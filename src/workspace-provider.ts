/**
 * Workspace Provider — abstraction for workspace detection and configuration.
 *
 * Separates workspace-specific concerns (root detection, multi-root folders,
 * state directories) from the LSP manager.
 *
 * External extensions can provide custom implementations via pi.events:
 *   pi.events.emit("lsp:workspace-provider", myProvider);
 */

import { tmpdir, hostname } from "node:os";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Resolve a per-workspace state directory for daemon sockets / PIDs.
 *
 * Why per-workspace: every pi process (main session + subagents) spawned in
 * the same project root must resolve to the SAME directory so they share a
 * single LSP daemon instead of each spawning its own (expensive) language
 * server. Different projects get different directories so their daemons and
 * sockets never collide.
 *
 * Layout: `${cacheDir}/pi-lsp/${host}/${hashedWorkspaceRoot}`
 *   - cacheDir: XDG cache dir, or platform fallback (macOS ~/Library/Caches,
 *     Windows %LOCALAPPDATA%, else ~/.cache); falls back to os.tmpdir().
 *   - host: short hostname hash, so the same NFS/home dir on different
 *     machines doesn't reuse stale sockets/PIDs for a different machine.
 *   - hashedWorkspaceRoot: 16-hex-char SHA-256 of the absolute workspace root.
 *     Hashed (not raw) to avoid path-length / illegal-char issues; the real
 *     root is written inside as `.root` for human inspection.
 *
 * Returns null only if no writable cache/home dir can be determined.
 */
function resolveStateDir(workspaceRoot: string): string | null {
  const home = process.env.HOME || process.env.USERPROFILE;
  let cacheDir: string | undefined;
  if (process.env.XDG_CACHE_HOME && process.env.XDG_CACHE_HOME.trim()) {
    cacheDir = process.env.XDG_CACHE_HOME;
  } else if (home) {
    cacheDir = join(home, ".cache");
  } else {
    // No home/cache dir — use the OS temp dir as a last resort.
    cacheDir = tmpdir();
  }

  const rootHash = createHash("sha256")
    .update(workspaceRoot)
    .digest("hex")
    .slice(0, 16);
  const hostHash = createHash("sha256")
    .update(hostname())
    .digest("hex")
    .slice(0, 8);
  return join(cacheDir, "pi-lsp", hostHash, rootHash);
}

export interface WorkspaceProvider {
  /** Provider type identifier */
  readonly type: string;

  /** Workspace root directory (if detected — may differ from cwd) */
  readonly workspaceRoot: string | null;

  /** Directory for persistent state (daemon sockets, PIDs, locks). Null disables daemon mode. */
  readonly stateDir: string | null;

  /** Get workspace folders for multi-root LSP initialization */
  getWorkspaceFolders(): { uri: string; name: string }[];

  /** One-time setup before first LSP server start. Returns true if ready. */
  ensureReady(sessionId?: string): Promise<boolean>;

  /** Human-readable status for UI */
  getStatusText(): string;

  /** Clean up resources */
  shutdown(): void;
}

/**
 * Default provider for standard workspaces.
 *
 * Enables LSP daemon sharing: every pi process (main session + subagents)
 * in the same workspace root resolves to the same `stateDir`, so the first
 * process spawns the daemon and subsequent ones connect to its socket —
 * avoiding a per-process cold-start of expensive language servers.
 */
export class DefaultWorkspaceProvider implements WorkspaceProvider {
  readonly type = "default";
  readonly workspaceRoot: string | null;
  readonly stateDir: string | null;

  constructor(workspaceRoot?: string | null) {
    this.workspaceRoot = workspaceRoot ?? null;
    this.stateDir = workspaceRoot ? resolveStateDir(workspaceRoot) : null;
  }

  getWorkspaceFolders(): { uri: string; name: string }[] {
    return [];
  }

  async ensureReady(_sessionId?: string): Promise<boolean> {
    if (!this.stateDir) return true;
    try {
      mkdirSync(join(this.stateDir, "sockets"), { recursive: true });
      // Stamp the real root for human inspection / debugging.
      if (this.workspaceRoot) {
        const rootStamp = join(this.stateDir, ".root");
        if (!existsSync(rootStamp)) {
          writeFileSync(rootStamp, this.workspaceRoot, "utf-8");
        }
      }
      return true;
    } catch {
      // Non-writable state dir is non-fatal — LspManager falls back to direct mode.
      return false;
    }
  }

  getStatusText(): string {
    return "";
  }

  shutdown(): void {}
}
