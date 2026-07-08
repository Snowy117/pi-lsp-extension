/**
 * pi-lsp-extension — Pi coding agent extension for LSP integration.
 *
 * Exposes Language Server Protocol capabilities as tools the LLM can call:
 * - lsp_diagnostics: compilation errors and warnings
 * - lsp_hover: type info and docs at a position
 * - lsp_definition: go to definition
 * - lsp_references: find all references
 * - lsp_symbols: file/workspace symbol search
 * - lsp_rename: preview rename refactoring
 * - lsp_completions: code completion suggestions at a position
 * - lsp_code_actions: quick fixes, refactorings, and source actions
 *
 * Position-based tools (hover, definition, references, rename, code_actions)
 * accept an optional `query` parameter as an alternative to line/character,
 * resolving a symbol name to its position automatically.
 *
 * Usage:
 *   1. npm install in this directory
 *   2. Add to pi via settings.json extensions, or: pi -e ./src/index.ts
 *   3. LSP servers start lazily when you first use a tool on a file
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  isReadToolResult,
  isWriteToolResult,
  isEditToolResult,
} from "@earendil-works/pi-coding-agent";
import { DiagnosticSeverity, type Diagnostic } from "vscode-languageserver-protocol";

import { LspManager, type ServerConfig, type LspManagerCallbacks } from "./lsp-manager.js";
import { FileSync } from "./file-sync.js";
import type { DiagnosticRefreshResult } from "./lsp-client.js";
import { TreeSitterManager } from "./tree-sitter/parser-manager.js";
import { WorkspaceIndex } from "./tree-sitter/workspace-index.js";
import { type WorkspaceProvider, DefaultWorkspaceProvider } from "./workspace-provider.js";
import { createDiagnosticsTool } from "./tools/diagnostics.js";
import { createHoverTool } from "./tools/hover.js";
import { createDefinitionTool } from "./tools/definition.js";
import { createReferencesTool } from "./tools/references.js";
import { createSymbolsTool } from "./tools/symbols.js";
import { createRenameTool } from "./tools/rename.js";
import { createCodeOverviewTool } from "./tools/code-overview.js";
import { createCompletionsTool } from "./tools/completions.js";
import { createCodeSearchTool } from "./tools/code-search.js";
import { createCodeRewriteTool } from "./tools/code-rewrite.js";
import { createCodeActionsTool } from "./tools/code-actions.js";
import { syntheticDotLocks } from "./tools/completions.js";
import { relative } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DIAGNOSTIC_SETTLE_DELAY_MS } from "./shared/timing.js";

/**
 * Poll the server for fresh diagnostics until it returns a `fresh` report
 * (full report, or an `unchanged` confirmed against the current document
 * version) or until the deadline expires.
 *
 * Heavy servers like Roslyn can still be mid-analysis after the initial
 * settle delay; a single pull at that point returns either stale cached
 * diagnostics or an `unchanged` whose resultId predates the edit. Polling
 * until `fresh` avoids surfacing pre-edit diagnostics as if they were current.
 *
 * Each iteration re-resolves the client through the manager: a daemon socket
 * may die and restart mid-poll, and pinning the dead instance would keep
 * returning its stale cache. Re-resolution picks up the restarted client.
 */
async function pollForFreshDiagnostics(
  manager: LspManager,
  filePath: string,
  uri: string,
  options: { intervalMs?: number; deadlineMs?: number } = {},
): Promise<DiagnosticRefreshResult> {
  const intervalMs = options.intervalMs ?? 1000;
  const deadlineMs = options.deadlineMs ?? (DIAGNOSTIC_SETTLE_DELAY_MS + 20_000);
  const start = Date.now();

  // Initial settle so the server has a chance to process the didChange before
  // we start polling (otherwise the very first poll races the notification).
  await new Promise((r) => setTimeout(r, DIAGNOSTIC_SETTLE_DELAY_MS));

  for (;;) {
    // Re-resolve the client every iteration. getClientForFile returns null
    // while a restart is in flight; that counts as not-fresh and we retry.
    const client = await manager.getClientForFile(filePath).catch(() => null);
    if (client) {
      const result = await client.refreshDiagnosticsWithFreshness(uri);
      if (result.fresh) return result;
    }
    if (Date.now() - start >= deadlineMs) {
      // Final attempt: return whatever the manager can give us so the caller
      // can decide to surface a stale warning.
      const finalClient = await manager.getClientForFile(filePath).catch(() => null);
      if (finalClient) return await finalClient.refreshDiagnosticsWithFreshness(uri);
      return {
        diagnostics: [],
        fresh: false,
        staleReason: "LSP server unavailable after polling; no diagnostics injected",
      };
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/**
 * Project-level LSP config — loaded from `.pi-lsp.json` in the workspace root.
 *
 * Example:
 * ```json
 * {
 *   "autoStart": ["java", "typescript"],
 *   "lombokJar": "env/Lombok-1.18.x/runtime/lib/lombok-1.18.42.jar",
 *   "servers": {
 *     "python": { "command": "pylsp", "args": [] }
 *   }
 * }
 * ```
 */
interface ProjectLspConfig {
  /** Languages to start eagerly on session_start (e.g. ["java", "typescript"]) */
  autoStart?: string[];
  /** Path to Lombok jar (absolute or relative to project root). "auto" to auto-detect. */
  lombokJar?: string;
  /** Custom server configs keyed by language ID */
  servers?: Record<string, { command: string; args?: string[]; env?: Record<string, string>; initializationOptions?: Record<string, unknown>; settings?: Record<string, unknown> }>;
  /**
   * Auto-inject LSP error diagnostics into write/edit tool results.
   * Set to false to disable, or provide an array of language IDs to enable selectively.
   * Default: true (all languages).
   *
   * Examples:
   *   true              — inject for all languages
   *   false             — never inject
   *   ["typescript"]    — only inject for TypeScript files
   */
  autoInjectDiagnostics?: boolean | string[];
}

/** Load .pi-lsp.json from a directory. Returns null if not found or invalid. */
function loadProjectConfig(dir: string): ProjectLspConfig | null {
  const configPath = join(dir, ".pi-lsp.json");
  try {
    if (!existsSync(configPath)) return null;
    const raw = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed as ProjectLspConfig;
  } catch {
    return null;
  }
}

export default function lspExtension(pi: ExtensionAPI) {
  // Prevent EPIPE errors from LSP server exits from crashing the host process.
  // When an LSP server exits unexpectedly, in-flight writes to its stdin pipe
  // can produce EPIPE errors that escape all connection-level error handlers.
  const origListeners = process.listeners("uncaughtException");
  process.on("uncaughtException", (err: any) => {
    if (err?.code === "EPIPE") return; // swallow — LSP server exited, harmless
    // Re-throw for other handlers
    for (const listener of origListeners) (listener as any)(err);
    if (origListeners.length === 0) {
      console.error("[LSP] Uncaught exception:", err);
    }
  });

  let manager: LspManager | null = null;
  let fileSync: FileSync | null = null;
  let treeSitter: TreeSitterManager | null = null;
  let workspaceIndex: WorkspaceIndex | null = null;
  let pendingProvider: WorkspaceProvider | null = null;
  // Store latest ctx for lifecycle callbacks (updated on each event)
  let latestCtx: any = null;
  // Project config — loaded on session_start, used by auto-injection guard
  let projectConfig: ProjectLspConfig | null = null;

  /**
   * Run `fn` with the currently captured ctx, swallowing stale-ctx errors.
   *
   * Lifecycle callbacks from LspManager (server ready, workspace setup, etc.)
   * and `pi.events` listeners can fire AFTER the session is replaced or reloaded,
   * at which point the captured ctx has been invalidated and any property access
   * throws via ExtensionRunner.assertActive(). We can't use optional chaining to
   * dodge it because the `ui` / `theme` getters themselves run assertActive().
   */
  const withLatestCtx = (fn: (ctx: any) => void) => {
    const ctx = latestCtx;
    if (!ctx) return;
    try {
      fn(ctx);
    } catch (err: any) {
      if (typeof err?.message === "string" && err.message.includes("stale after session")) {
        // Session was replaced/reloaded — drop the stale ctx and move on.
        latestCtx = null;
        return;
      }
      throw err;
    }
  };

  // Listen for external workspace providers (e.g. bemol extension).
  // Also check if one was already registered before we loaded (load order varies).
  // Store as pendingProvider so it's available when the manager is created later.
  const applyProvider = (data: unknown) => {
    const provider = data as WorkspaceProvider;
    pendingProvider = provider;
    if (manager) {
      manager.setWorkspaceProvider(provider);
    }
    // Update status if we have a UI context
    const statusText = provider.getStatusText();
    if (!statusText) return;
    withLatestCtx((ctx) => {
      if (!ctx.ui?.theme) return;
      ctx.ui.setStatus("lsp", ctx.ui.theme.fg("accent", `LSP: ${statusText}`));
    });
  };

  pi.events.on("lsp:register-workspace-provider", applyProvider);

  // Check for provider registered before our listener existed
  const existing = (pi.events as any)["lsp:workspace-provider"];
  if (existing) applyProvider(existing);

  /** Build lifecycle callbacks that update UI status */
  const setLspStatus = (color: string, text: string) => {
    withLatestCtx((ctx) => {
      if (!ctx.ui?.theme) return;
      ctx.ui.setStatus("lsp", ctx.ui.theme.fg(color, text));
    });
  };

  const makeCallbacks = (): LspManagerCallbacks => ({
    onWorkspaceSetupStart: () => {
      setLspStatus("warning", "LSP: workspace setup...");
    },
    onWorkspaceSetupEnd: (success: boolean, duration: number) => {
      const secs = (duration / 1000).toFixed(1);
      if (success) {
        setLspStatus("accent", `LSP: workspace ready (${secs}s)`);
      } else {
        setLspStatus("warning", `LSP: workspace setup failed (${secs}s)`);
      }
    },
    onServerStart: (languageId: string, command: string) => {
      setLspStatus("warning", `LSP: starting ${languageId} (${command})...`);
      // Clear tracked documents for this language so the new/reconnected
      // client re-sends didOpen instead of didChange for files the new
      // server never opened (stale tracked entries from a previous daemon).
      fileSync?.clearTrackedByLanguage(languageId);
    },
    onServerReady: (languageId: string) => {
      setLspStatus("accent", `LSP: ${languageId} ready`);
    },
    onServerError: (languageId: string, _error: string) => {
      setLspStatus("error", `LSP: ${languageId} failed`);
    },
    onServerCrash: (languageId: string, restarting: boolean, attempt: number) => {
      if (restarting) {
        setLspStatus("warning", `LSP: restarting ${languageId}... (attempt ${attempt}/3)`);
      } else {
        setLspStatus("error", `LSP: ${languageId} crashed — auto-restart exhausted`);
      }
    },
  });

  // Create manager eagerly so tools can reference it, but servers start lazily
  const getManager = (): LspManager => {
    if (!manager) {
      manager = new LspManager(process.cwd(), undefined, makeCallbacks(), undefined, pendingProvider ?? undefined);
      fileSync = new FileSync(manager);
      fileSync.setSyntheticDotChecker((uri) => syntheticDotLocks.has(uri));
      treeSitter = new TreeSitterManager();
      workspaceIndex = new WorkspaceIndex(process.cwd(), treeSitter);
      fileSync.setTreeSitter(treeSitter, workspaceIndex);
    }
    return manager;
  };

  const getFileSync = (): FileSync => {
    if (!fileSync) {
      getManager(); // ensures fileSync is created
    }
    return fileSync!;
  };

  const getTreeSitter = (): TreeSitterManager => {
    if (!treeSitter) {
      getManager(); // ensures treeSitter is created
    }
    return treeSitter!;
  };

  const getWorkspaceIndex = (): WorkspaceIndex => {
    if (!workspaceIndex) {
      getManager(); // ensures workspaceIndex is created
    }
    return workspaceIndex!;
  };

  // Initialize manager (uses cwd at session start time)
  pi.on("session_start", async (_event, ctx) => {
    latestCtx = ctx;

    // If manager was already created eagerly (e.g. by a tool before session_start),
    // shut it down so we can re-create with the correct ctx.cwd.
    if (manager) {
      await manager.shutdownAll().catch(() => {});
      if (treeSitter) treeSitter.shutdown();
    }

    manager = new LspManager(ctx.cwd, undefined, makeCallbacks(), undefined, pendingProvider ?? undefined);
    fileSync = new FileSync(manager);
    fileSync.setSyntheticDotChecker((uri) => syntheticDotLocks.has(uri));
    treeSitter = new TreeSitterManager();
    workspaceIndex = new WorkspaceIndex(ctx.cwd, treeSitter);
    fileSync.setTreeSitter(treeSitter, workspaceIndex);

    // Initialize tree-sitter in the background (don't block session start)
    treeSitter.init().catch((err) => {
      console.error(`[pi-lsp-extension] tree-sitter WASM init failed: ${err?.message ?? err}`);
    });

    // Show workspace provider status
    const wsProvider = manager.workspace;
    const statusText = wsProvider.getStatusText();
    if (statusText) {
      ctx.ui.setStatus("lsp", ctx.ui.theme.fg("accent", `LSP: ${statusText}`));
    } else {
      ctx.ui.setStatus("lsp", ctx.ui.theme.fg("dim", "LSP: idle"));
    }

    // Load project config and apply settings
    projectConfig = loadProjectConfig(ctx.cwd);
    if (projectConfig) {
      // Apply custom server configs
      if (projectConfig.servers) {
        for (const [lang, serverConf] of Object.entries(projectConfig.servers)) {
          manager.setServerConfig(lang, {
            command: serverConf.command,
            args: serverConf.args ?? [],
            env: serverConf.env,
            initializationOptions: serverConf.initializationOptions,
            settings: serverConf.settings,
          });
        }
      }

      // Set Lombok jar path (explicit path or "auto" for auto-detection)
      if (projectConfig.lombokJar) {
        if (projectConfig.lombokJar !== "auto") {
          manager.setLombokJar(projectConfig.lombokJar);
        }
        // "auto" is the default behavior — findLombokJar() already auto-detects.
        // Setting it explicitly just confirms the user wants Lombok support.
      }

      // Auto-start configured languages in the background
      if (projectConfig.autoStart && projectConfig.autoStart.length > 0) {
        const langs = projectConfig.autoStart;
        const lombokNote = langs.includes("java") && manager.getLombokJar()
          ? ` (lombok: ${manager.getLombokJar()?.split("/").pop()})` : "";
        setLspStatus("warning", `LSP: auto-starting ${langs.join(", ")}${lombokNote}...`);
        manager.startEagerly(langs);
      }
    }
  });

  // Register all LSP tools
  // Tools call getManager() lazily so they work even if session_start hasn't fired
  const managerProxy = new Proxy({} as LspManager, {
    get(_target, prop) {
      return (getManager() as any)[prop];
    },
  });

  const treeSitterProxy = new Proxy({} as TreeSitterManager, {
    get(_target, prop) {
      return (getTreeSitter() as any)[prop];
    },
  });

  const workspaceIndexProxy = new Proxy({} as WorkspaceIndex, {
    get(_target, prop) {
      return (getWorkspaceIndex() as any)[prop];
    },
  });

  pi.registerTool(createDiagnosticsTool(managerProxy, treeSitterProxy));
  pi.registerTool(createHoverTool(managerProxy, treeSitterProxy));
  pi.registerTool(createDefinitionTool(managerProxy, treeSitterProxy, workspaceIndexProxy));
  pi.registerTool(createReferencesTool(managerProxy, treeSitterProxy));
  pi.registerTool(createSymbolsTool(managerProxy, treeSitterProxy, workspaceIndexProxy));
  pi.registerTool(createRenameTool(managerProxy, treeSitterProxy));
  pi.registerTool(createCodeActionsTool(managerProxy, treeSitterProxy));
  pi.registerTool(createCompletionsTool(managerProxy, {
    getTrackedVersion: (uri) => getFileSync().getTrackedVersion(uri),
    setTrackedVersion: (uri, v) => getFileSync().setTrackedVersion(uri, v),
    isSyntheticDotActive: (uri) => syntheticDotLocks.has(uri),
  }, treeSitterProxy));
  const getRootDir = () => manager?.resolvePath(".") ?? process.cwd();
  pi.registerTool(createCodeOverviewTool(getRootDir, treeSitterProxy, workspaceIndexProxy));
  pi.registerTool(createCodeSearchTool(getRootDir, treeSitterProxy));
  pi.registerTool(createCodeRewriteTool(getRootDir, treeSitterProxy, {
    onFileModified: (filePath: string) => {
      getFileSync().handleFileWrite(filePath).catch(() => {});
    },
  }));
  pi.registerTool(createCodeActionsTool(managerProxy, treeSitterProxy));

  // File sync: track file reads/writes/edits
  // After writes/edits, append file-scoped error diagnostics to the tool result
  pi.on("tool_result", async (event) => {
    const sync = getFileSync();

    try {
      if (isReadToolResult(event) && !event.isError) {
        const path = (event.input as any)?.path;
        if (path) await sync.handleFileRead(path);
      }

      if (isWriteToolResult(event) && !event.isError) {
        const path = (event.input as any)?.path;
        if (path) await sync.handleFileWrite(path);
      }

      if (isEditToolResult(event) && !event.isError) {
        const path = (event.input as any)?.path;
        if (path) await sync.handleFileWrite(path);
      }
    } catch {
      // File sync errors are non-fatal
    }

    // Auto-append diagnostics for the changed file (write/edit only)
    if ((isWriteToolResult(event) || isEditToolResult(event)) && !event.isError && manager) {
      const path = (event.input as any)?.path;
      if (!path) return;

      const languageId = manager.getLanguageId(path);
      if (!languageId) return;

      // Check autoInjectDiagnostics config
      const inject = projectConfig?.autoInjectDiagnostics;
      if (inject === false) return;
      if (Array.isArray(inject) && !inject.includes(languageId)) return;

      // Use getClientForFile (not getRunningClient) so we await server startup
      // instead of silently bailing when the daemon is mid-(re)handshake.
      // (The actual client used for each poll is re-resolved inside
      // pollForFreshDiagnostics to survive daemon restarts mid-poll.)
      const client = await manager.getClientForFile(path).catch(() => null);
      if (!client) return;

      const uri = manager.getFileUri(path);
      // Poll for fresh diagnostics instead of a single fixed delay: heavy
      // servers (Roslyn) may still be mid-analysis 8s after didChange, in
      // which case the first pull returns the stale cache or `unchanged`.
      // We retry until the server returns a fresh report (full, or unchanged
      // against the post-change version), with a total deadline to avoid
      // blocking the tool result indefinitely.
      //
      // Each poll re-resolves the client through the manager so a daemon
      // socket that died and is being restarted mid-poll is picked up
      // instead of pinning the dead instance and returning its stale cache.
      const refreshResult = await pollForFreshDiagnostics(manager, path, uri);
      // If we could not obtain a fresh report (server not initialized, died,
      // or timed out), do NOT inject potentially-stale diagnostics — the user
      // can call lsp_diagnostics explicitly to confirm. Injecting cached
      // pre-edit diagnostics after a fix is exactly the staleness bug we are
      // solving.
      if (!refreshResult.fresh) return;
      const diagnostics = refreshResult.diagnostics;

      // Severity bucketing: errors first, then everything else in severity
      // order (Warning → Hint → Informational). Unspecified severity (0) is
      // treated as Error per the LSP spec's default-severity rule.
      const errors = diagnostics.filter(
        (d) => !d.severity || d.severity === DiagnosticSeverity.Error
      );
      const others = diagnostics
        .filter(
          (d) =>
            d.severity !== undefined &&
            d.severity !== DiagnosticSeverity.Error
        )
        .sort((a, b) => (a.severity! - b.severity!));

      if (errors.length === 0 && others.length === 0) return;

      // Build a compact summary — errors first, then other severities,
      // capped at MAX_DIAGNOSTIC_LINES total lines.
      const MAX_DIAGNOSTIC_LINES = 20;
      const relPath = relative(manager.resolvePath("."), manager.resolvePath(path));

      const severityLabel = (d: Diagnostic): string => {
        switch (d.severity) {
          case DiagnosticSeverity.Warning:
            return "warning";
          case DiagnosticSeverity.Hint:
            return "hint";
          case DiagnosticSeverity.Information:
            return "info";
          default:
            return "error"; // Error or unspecified
        }
      };

      const formatDiag = (d: Diagnostic): string => {
        const line = d.range.start.line + 1;
        const col = d.range.start.character + 1;
        const source = d.source ? ` [${d.source}]` : "";
        const code = d.code !== undefined ? ` (${d.code})` : "";
        return `${relPath}:${line}:${col} ${severityLabel(d)}: ${d.message}${code}${source}`;
      };

      const lines: string[] = [];
      const total = errors.length + others.length;
      let suppressed = 0;

      for (const d of errors) {
        if (lines.length >= MAX_DIAGNOSTIC_LINES) { suppressed = total - lines.length; break; }
        lines.push(formatDiag(d));
      }
      if (lines.length < MAX_DIAGNOSTIC_LINES) {
        for (const d of others) {
          if (lines.length >= MAX_DIAGNOSTIC_LINES) { suppressed = total - lines.length; break; }
          lines.push(formatDiag(d));
        }
      }
      if (suppressed > 0) {
        lines.push(`... and ${suppressed} more diagnostic(s)`);
      }

      const errorPart = errors.length > 0 ? `${errors.length} error(s)` : "no errors";
      const otherPart = others.length > 0 ? `, ${others.length} other diagnostic(s)` : "";
      const freshnessNote = refreshResult.fresh
        ? ""
        : ` [may be stale — ${refreshResult.staleReason ?? "results may be stale"}; run lsp_diagnostics to confirm]`;
      const summary = `\n\n⚠ LSP: ${errorPart}${otherPart} in ${relPath}${freshnessNote}:\n${lines.join("\n")}`;

      return {
        content: [
          ...event.content,
          { type: "text" as const, text: summary },
        ],
      };
    }
  });

  // Update status after tool execution ends
  pi.on("tool_execution_end", async (_event, ctx) => {
    latestCtx = ctx;
    if (!manager) return;
    const statuses = manager.getStatus();
    const running = statuses.filter((s) => s.running);
    if (running.length === 0) {
      ctx.ui.setStatus("lsp", ctx.ui.theme.fg("dim", "LSP: idle"));
    } else {
      const totalDiags = running.reduce((n, s) => n + s.diagnosticsCount, 0);
      const langs = running.map((s) => s.languageId).join(", ");
      let status = `LSP: ${langs}`;
      if (totalDiags > 0) {
        status += ` (${totalDiags} diagnostic${totalDiags !== 1 ? "s" : ""})`;
      }
      ctx.ui.setStatus("lsp", ctx.ui.theme.fg("accent", status));
    }
  });

  // /lsp command — show server status
  pi.registerCommand("lsp", {
    description: "Show LSP server status",
    handler: async (_args, ctx) => {
      if (!manager) {
        ctx.ui.notify("LSP manager not initialized", "warning");
        return;
      }

      const statuses = manager.getStatus();
      if (statuses.length === 0) {
        ctx.ui.notify("No LSP servers configured", "info");
        return;
      }

      const lines = statuses.map((s) => {
        const icon = s.running ? "🟢" : "⚪";
        const diags =
          s.diagnosticsCount > 0 ? ` (${s.diagnosticsCount} diagnostics)` : "";
        const shared = s.shared ? " [shared]" : "";
        return `${icon} ${s.languageId}: ${s.command}${diags}${shared}`;
      });

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // /lsp-restart command — restart a specific language server
  pi.registerCommand("lsp-restart", {
    description: "Restart an LSP server: /lsp-restart <language> (e.g. java, typescript)",
    handler: async (args, ctx) => {
      if (!manager) {
        ctx.ui.notify("LSP manager not initialized", "warning");
        return;
      }

      const languageId = args?.trim().toLowerCase();
      if (!languageId) {
        // Show running servers and usage
        const statuses = manager.getStatus().filter((s) => s.running);
        if (statuses.length === 0) {
          ctx.ui.notify("No LSP servers are running.\n\nUsage: /lsp-restart <language>", "info");
        } else {
          const langs = statuses.map((s) => s.languageId).join(", ");
          ctx.ui.notify(
            `Running servers: ${langs}\n\nUsage: /lsp-restart <language>\nExample: /lsp-restart java`,
            "info"
          );
        }
        return;
      }

      ctx.ui.setStatus("lsp", ctx.ui.theme.fg("warning", `LSP: restarting ${languageId}...`));
      ctx.ui.notify(`Restarting ${languageId} server (kills daemon if shared)...`, "info");

      try {
        await manager.restartServer(languageId);
        const lombokJar = languageId === "java" ? manager.getLombokJar() : null;
        const lombokNote = lombokJar ? `\nLombok: ${lombokJar}` : "";
        ctx.ui.notify(`${languageId} server restarted successfully.${lombokNote}`, "info");
        ctx.ui.setStatus("lsp", ctx.ui.theme.fg("accent", `LSP: ${languageId} ready`));
      } catch (err: any) {
        ctx.ui.notify(`Failed to restart ${languageId}: ${err.message}`, "error");
        ctx.ui.setStatus("lsp", ctx.ui.theme.fg("error", `LSP: ${languageId} restart failed`));
      }
    },
  });

  // /lsp-config command — add or override server configuration
  pi.registerCommand("lsp-config", {
    description:
      "Configure an LSP server: /lsp-config <language> <command> [args...]",
    handler: async (args, ctx) => {
      if (!args?.trim()) {
        ctx.ui.notify(
          "Usage: /lsp-config <language> <command> [args...]\nExample: /lsp-config python pylsp",
          "info"
        );
        return;
      }

      const parts = args.trim().split(/\s+/);
      if (parts.length < 2) {
        ctx.ui.notify(
          "Usage: /lsp-config <language> <command> [args...]",
          "warning"
        );
        return;
      }

      const [languageId, command, ...serverArgs] = parts;
      const config: ServerConfig = { command, args: serverArgs };

      getManager().setServerConfig(languageId, config);
      ctx.ui.notify(
        `Configured LSP for ${languageId}: ${command} ${serverArgs.join(" ")}`,
        "info"
      );
    },
  });

  // /lsp-lombok command — set Lombok jar path for Java
  pi.registerCommand("lsp-lombok", {
    description:
      "Set Lombok jar path for Java: /lsp-lombok <path-to-lombok.jar>",
    handler: async (args, ctx) => {
      const mgr = getManager();

      if (!args?.trim()) {
        const current = mgr.getLombokJar();
        if (current) {
          ctx.ui.notify(`Lombok jar: ${current}`, "info");
        } else {
          ctx.ui.notify(
            "No Lombok jar configured or detected.\n\n" +
            "Usage: /lsp-lombok <path-to-lombok.jar>\n" +
            "Or set LOMBOK_JAR environment variable.\n\n" +
            "Download from: https://projectlombok.org/download",
            "info"
          );
        }
        return;
      }

      const jarPath = args.trim();
      const { existsSync } = await import("node:fs");
      const { resolve } = await import("node:path");
      const resolved = resolve(ctx.cwd, jarPath);

      if (!existsSync(resolved)) {
        ctx.ui.notify(`File not found: ${resolved}`, "error");
        return;
      }

      if (!resolved.endsWith(".jar")) {
        ctx.ui.notify(`Warning: ${resolved} doesn't end in .jar — setting anyway`, "warning");
      }

      mgr.setLombokJar(resolved);
      ctx.ui.notify(`Lombok jar set: ${resolved}`, "info");
    },
  });

  // Clean shutdown (includes workspace provider, all LSP servers, and tree-sitter)
  pi.on("session_shutdown", async () => {
    // Drop the captured ctx immediately — once shutdown fires, any late
    // LSP manager callback that reaches setLspStatus/applyProvider would
    // otherwise hit an invalidated ctx and throw an uncaught exception.
    latestCtx = null;
    if (manager) {
      await manager.shutdownAll();
      manager = null;
      fileSync = null;
    }
    if (treeSitter) {
      treeSitter.shutdown();
      treeSitter = null;
    }
    workspaceIndex = null;
  });
}
