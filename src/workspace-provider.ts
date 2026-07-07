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
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

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

/**
 * Resolve the canonical project root for daemon-sharing purposes.
 *
 * The problem this solves: subagents and other pi processes may have a cwd
 * that is NOT the project root (e.g. a git worktree, or a /tmp work dir used
 * by pi-subagents). If stateDir were derived from cwd directly, every such
 * process would resolve a different stateDir and spawn its own daemon —
 * defeating daemon sharing entirely.
 *
 * Resolution order:
 *  1. PI_LSP_PROJECT_ROOT env var — explicit override (lets orchestrators
 *     like pi-subagents pass the real project root even when cwd is /tmp).
 *  2. Walk up from `dir` looking for `.git`:
 *     - `.git` directory  → this is the repository root.
 *     - `.git` file (git worktree) → contains `gitdir: <main>/.git/worktrees/<name>`;
 *       walk up from that gitdir until we find a directory whose `.git` is a
 *       directory, i.e. the main worktree (repository root).
 *  3. Fallback: `dir` itself (no project root detectable).
 */
function resolveProjectRoot(dir: string): string {
  const envRoot = process.env.PI_LSP_PROJECT_ROOT;
  if (envRoot && envRoot.trim()) {
    return resolve(envRoot.trim());
  }

  let current = resolve(dir);
  // Guard: avoid infinite loop at filesystem root.
  for (;;) {
    const dotGit = join(current, ".git");
    if (existsSync(dotGit)) {
      let isDir = false;
      try { isDir = statSync(dotGit).isDirectory(); } catch { /* not statable */ }
      if (isDir) {
        return current; // main worktree / ordinary clone
      }
      // .git is a file → git worktree. Read it to find the main repository.
      try {
        const content = readFileSync(dotGit, "utf-8").trim();
        const m = content.match(/^gitdir:\s*(.+)$/);
        if (m) {
          // gitdirPath is typically <mainRepo>/.git/worktrees/<name>
          let search = dirname(m[1]);
          for (;;) {
            const candidate = join(search, ".git");
            if (existsSync(candidate)) {
              try {
                if (statSync(candidate).isDirectory()) return search;
              } catch { /* keep walking */ }
            }
            const parent = dirname(search);
            if (parent === search) break;
            search = parent;
          }
        }
      } catch { /* ignore unreadable .git file */ }
      // Worktree gitdir resolution failed — fall back to the worktree root,
      // which at least keeps this one process self-consistent.
      return current;
    }
    const parent = dirname(current);
    if (parent === current) break; // reached filesystem root
    current = parent;
  }
  return resolve(dir);
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
  /** Original cwd as passed in; may differ from the detected project root. */
  readonly workspaceRoot: string | null;
  /**
   * Detected project root (git repo root, worktree main, or PI_LSP_PROJECT_ROOT).
   * stateDir and workspace folders are derived from this so that every pi
   * process in the same project shares one daemon, regardless of cwd.
   */
  readonly projectRoot: string | null;
  readonly stateDir: string | null;

  constructor(workspaceRoot?: string | null) {
    this.workspaceRoot = workspaceRoot ?? null;
    // Derive the canonical project root before hashing, so processes whose cwd
    // is a subdirectory, a git worktree, or a /tmp work dir all converge on the
    // same stateDir (and thus the same daemon).
    this.projectRoot = workspaceRoot ? resolveProjectRoot(workspaceRoot) : null;
    this.stateDir = this.projectRoot ? resolveStateDir(this.projectRoot) : null;
  }

  getWorkspaceFolders(): { uri: string; name: string }[] {
    // Return the project root as the LSP workspace folder. Previously this
    // returned [], so in daemon/direct mode the server's workspaceFolder fell
    // back to rootUri (= cwd). For subagents whose cwd is /tmp or a worktree,
    // that meant the server looked for .vscode/settings.json and the solution
    // file in the wrong place. Returning the real project root fixes that.
    if (!this.projectRoot) return [];
    return [{
      uri: pathToFileURL(this.projectRoot).toString(),
      name: this.projectRoot.split("/").pop() ?? "workspace",
    }];
  }

  async ensureReady(_sessionId?: string): Promise<boolean> {
    if (!this.stateDir) return true;
    try {
      mkdirSync(join(this.stateDir, "sockets"), { recursive: true });
      // Stamp the real project root for human inspection / debugging. Use
      // projectRoot (not the raw cwd) so multi-process daemon sharing is
      // visible: every process that converged here wrote the same path.
      if (this.projectRoot) {
        const rootStamp = join(this.stateDir, ".root");
        if (!existsSync(rootStamp)) {
          writeFileSync(rootStamp, this.projectRoot, "utf-8");
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
