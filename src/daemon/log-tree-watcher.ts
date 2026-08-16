import { EventEmitter } from "events";
import { watch as chokidarWatch } from "chokidar";
import {
  watch as fsWatch,
  type FSWatcher as NodeFsWatcher,
  readdirSync,
  statSync,
  existsSync,
} from "fs";
import { join, sep } from "path";

/** Recursive fs.watch arming latency cover; see the constructor comment. */
const ARM_SETTLE_MS = 50;

/** Only ENOENT means "the path is gone"; EACCES/EMFILE/etc. must not be
 * classified as deletions or they would emit spurious `unlink`s that tear
 * down live session state. */
function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

/**
 * A directory's cheap gate key. Node exposes nanoseconds, but both values
 * retain the filesystem's actual timestamp resolution. Rapid namespace
 * mutations can therefore leave both unchanged on coarse-resolution
 * filesystems, so equality is an optimization rather than proof that the
 * directory did not change.
 */
interface DirSig {
  mtimeNs: bigint;
  ctimeNs: bigint;
}

/** Throws ENOENT when `dir` is gone so callers classify the deletion. */
function statDirSig(dir: string): DirSig {
  const s = statSync(dir, { bigint: true });
  return { mtimeNs: s.mtimeNs, ctimeNs: s.ctimeNs };
}

function sigEqual(a: DirSig | null, b: DirSig | null): boolean {
  return (
    a !== null &&
    b !== null &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs
  );
}

/**
 * One node per watched directory, mirroring the tree under the root.
 *
 * `walkSig` and `sweepSig` gate re-readdir (add discovery) and re-stat
 * (unlink discovery) INDEPENDENTLY and MUST stay separate fields: a single
 * shared signature would let a walk that consumes the change in one event
 * blind the sweep in the same event, dropping every co-occurring unlink
 * (see the "reconciles the whole tree on a null event" contract). `files`
 * holds the abs paths of known files directly in this dir; `childDirs` maps
 * an abs child-dir path to its node.
 */
interface DirNode {
  walkSig: DirSig | null;
  sweepSig: DirSig | null;
  files: Set<string>;
  childDirs: Map<string, DirNode>;
}

function newDirNode(): DirNode {
  return {
    walkSig: null,
    sweepSig: null,
    files: new Set(),
    childDirs: new Map(),
  };
}

/** Reopen every cached gate under `node` for the null-event reconcile. */
function clearSigs(node: DirNode): void {
  node.walkSig = null;
  node.sweepSig = null;
  for (const child of node.childDirs.values()) clearSigs(child);
}

/**
 * The slice of chokidar's FSWatcher surface that LogWatcher consumes.
 * Both the native implementation below and the chokidar fallback satisfy
 * it, so LogWatcher stays substrate-agnostic.
 */
export interface LogTreeWatcher {
  on(event: "add" | "change" | "unlink", cb: (path: string) => void): this;
  on(event: "ready", cb: () => void): this;
  on(event: "error", cb: (error: unknown) => void): this;
  /** Re-arm a previously `unwatch`ed file. The native watcher emits
   * nothing by itself; the chokidar fallback may emit `add` for an
   * existing file. */
  add(path: string): void;
  /** Suppress further events for a file (chokidar-compatible). Native
   * suppression survives deletion: a file recreated at the same path
   * stays silent until `add` re-arms it. The chokidar fallback re-detects
   * a recreated file via its watched parent directory. */
  unwatch(path: string): void;
  close(): Promise<void>;
}

/**
 * Recursive-`fs.watch`-backed replacement for chokidar over the agent log
 * trees (`~/.claude/projects`, `~/.codex/sessions`).
 *
 * Why: chokidar arms one watcher per directory, and on a session-heavy
 * machine (hundreds of project dirs) that setup alone took 1-2s of daemon
 * boot — `ignoreInitial` doesn't help because the cost is the traversal,
 * not the events. One recursive FSEvents/ReadDirectoryChangesW handle arms
 * in microseconds, and the initial `add` walk is a plain readdir recursion
 * (~1ms for 1k files).
 *
 * Platform notes (verified on macOS):
 * - Event names are unreliable (`rename` for creates, appends, AND
 *   deletes), so events are classified by stat + a known-files set, never
 *   by event type.
 * - A file created moments after its parent directory only surfaces as
 *   the directory's event, so a directory event triggers a subtree walk
 *   that emits `add` for any unknown files.
 * - Deleting a directory may not emit per-child events, so an ENOENT on a
 *   path sweeps that directory's cached subtree and emits `unlink` for
 *   every known file underneath.
 */
class NativeLogTreeWatcher extends EventEmitter implements LogTreeWatcher {
  private readonly root: string;
  /** Max path segments (relative to root) an eligible file may have.
   * Mirrors chokidar's `depth`: depth N traverses N subdirectory levels,
   * so an eligible file has at most N+1 relative segments. */
  private readonly maxSegments: number;
  private readonly watcher: NodeFsWatcher;
  /** Files we have emitted `add` for; membership classifies change vs add. */
  private readonly known = new Set<string>();
  /** `unwatch`ed files: events are suppressed until `add` re-arms them. */
  private readonly ignored = new Set<string>();
  /** Per-directory cache mirroring the tree: the mtime/ctime gate keys and
   * the known files/child dirs under each directory. Lets a coalesced
   * directory or root event re-readdir and re-stat only the directories
   * whose signature actually changed, instead of walking + statting the
   * whole subtree. `known` stays the authoritative flat membership index,
   * kept in lockstep with the tree via addKnownFile/delKnownFile. */
  private readonly rootNode: DirNode = newDirNode();
  private closed = false;

  constructor(root: string, depth?: number) {
    super();
    this.root = root;
    this.maxSegments = depth === undefined ? Infinity : depth + 1;
    // Throws synchronously when recursive watching is unsupported on this
    // platform; the factory catches it and falls back to chokidar.
    this.watcher = fsWatch(root, { recursive: true }, (_event, relPath) => {
      try {
        this.handleEvent(relPath);
      } catch (error) {
        this.emit("error", error);
      }
    });
    this.watcher.on("error", (error) => this.emit("error", error));

    // Initial scan runs after a short settle, then `ready` fires. The
    // settle matters: the recursive FSEvents stream is not armed the
    // instant fs.watch returns, and events in that blind window are
    // dropped (verified: a file touched 0ms after watch only surfaces as
    // a coalesced parent-dir event; at 20ms+ delivery is complete).
    // Walking after the settle closes the gap — files created in the
    // blind window are unknown to the walk and emit `add` normally. The
    // delay also guarantees callers attach listeners first (LogWatcher
    // registers handlers synchronously after construction).
    setTimeout(() => {
      if (this.closed) return;
      try {
        this.walk(this.root, this.rootNode, 0);
      } catch (error) {
        this.emit("error", error);
      }
      if (!this.closed) this.emit("ready");
    }, ARM_SETTLE_MS);
  }

  add(path: string): void {
    this.ignored.delete(path);
    // Keep the tree in lockstep so a later sweep (which scans node.files,
    // not the flat set) can still unlink a re-armed path. A path outside
    // the root stays flat-only, matching the pre-tree behavior.
    if (path.startsWith(this.root + sep)) {
      this.getOrCreateNode(this.parentDir(path)).files.add(path);
    }
    this.known.add(path);
  }

  unwatch(path: string): void {
    this.ignored.add(path);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.watcher.close();
    this.removeAllListeners();
  }

  /** Add/remove a tree-tracked file in BOTH the flat membership index and
   * its directory node, so the two never drift. Every tree-driven mutation
   * of a known file goes through these; `add`/`unwatch` touch only the flat
   * `known`/`ignored` sets (they are not bound to a node), matching the
   * native unwatch-suppression contract. */
  private addKnownFile(node: DirNode, abs: string): void {
    this.known.add(abs);
    node.files.add(abs);
  }

  private delKnownFile(node: DirNode, abs: string): void {
    this.known.delete(abs);
    node.files.delete(abs);
  }

  private parentDir(abs: string): string {
    return abs.slice(0, abs.lastIndexOf(sep));
  }

  /** Resolve (creating as needed) the node for an absolute directory path
   * under the root. A freshly created node has null signatures, so the
   * next walk/sweep readdir-s and re-stats it rather than trusting a cache
   * it never populated. */
  private getOrCreateNode(absDir: string): DirNode {
    if (absDir === this.root || !absDir.startsWith(this.root + sep)) {
      return this.rootNode;
    }
    let node = this.rootNode;
    let cur = this.root;
    for (const seg of absDir.slice(this.root.length + 1).split(sep)) {
      cur = join(cur, seg);
      let child = node.childDirs.get(cur);
      if (!child) {
        child = newDirNode();
        node.childDirs.set(cur, child);
      }
      node = child;
    }
    return node;
  }

  private dirExists(abs: string): boolean {
    try {
      return statSync(abs).isDirectory();
    } catch {
      return false;
    }
  }

  /** Emit `add` for every eligible unknown file under `dir`. Re-reads a
   * directory only when its signature changed (a child was added/removed);
   * otherwise descends into cached child nodes so a deeper change is still
   * discovered. A content append does not bump the directory signature, so
   * the cheap `change` path stays correctly invisible here. */
  private walk(dir: string, node: DirNode, segmentsUsed: number): void {
    let sig: DirSig;
    try {
      sig = statDirSig(dir);
    } catch (error) {
      if (!isEnoent(error)) this.emit("error", error);
      return; // raced with deletion; the sweep half emits any unlinks
    }
    if (!sigEqual(sig, node.walkSig)) {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch (error) {
        // ENOENT = raced with deletion; the sweep half emits any unlinks.
        // Any other error (EACCES/EMFILE/...) is surfaced, never swallowed,
        // mirroring statDirSig's discipline so a transient fault is visible.
        if (!isEnoent(error)) this.emit("error", error);
        return;
      }
      for (const entry of entries) {
        if (this.closed) return;
        const abs = join(dir, entry.name);
        if (entry.isFile()) {
          if (segmentsUsed + 1 > this.maxSegments) continue;
          if (!this.known.has(abs)) {
            this.addKnownFile(node, abs);
            if (!this.ignored.has(abs)) this.emit("add", abs);
          }
        } else if (entry.isDirectory() && segmentsUsed + 1 < this.maxSegments) {
          let child = node.childDirs.get(abs);
          if (!child) {
            child = newDirNode();
            node.childDirs.set(abs, child);
          }
          this.walk(abs, child, segmentsUsed + 1);
        }
      }
      // Record AFTER the readdir: an op that bumps the signature between the
      // stat and now produces a value != sig, so the next event reopens the
      // gate and reconciles rather than skipping.
      node.walkSig = sig;
    } else {
      for (const [abs, child] of node.childDirs) {
        if (this.closed) return;
        if (segmentsUsed + 1 < this.maxSegments) {
          this.walk(abs, child, segmentsUsed + 1);
        }
      }
    }
  }

  private handleEvent(relPath: string | null): void {
    if (this.closed) return;
    // FSEvents coalescing is stream-local and unpredictable: a burst of
    // changes may surface as any one of the touched file, its parent
    // directory, or the root. Every branch below therefore reconciles a
    // whole subtree (walk for new files, sweep for gone ones) rather
    // than trusting the event to name the exact path that changed.
    if (!relPath) {
      // A null event carries no path-local evidence, so cached directory
      // signatures cannot safely close the gates. On filesystems whose
      // timestamp resolution is coarser than the mutation sequence (HFS+,
      // legacy ext4 with 128-byte inodes), a rapid add/remove pair can
      // leave a directory's (mtime, ctime) unchanged. Clear every cached
      // gate, not just the root: no built-in keeps session files at the
      // root (claude depth 1, copilot 2, codex 4), so a root-only reset
      // would miss every .jsonl that matters.
      clearSigs(this.rootNode);
      this.walk(this.root, this.rootNode, 0);
      this.sweep(this.root, this.rootNode);
      return;
    }
    const abs = join(this.root, relPath);

    let stat;
    try {
      stat = statSync(abs);
    } catch (error) {
      if (isEnoent(error)) {
        // Classify before the depth gate: a directory delete may surface
        // only as a too-deep child's event (e.g. removing a Claude project
        // dir coalesces into one event for a subagents file), and the
        // ancestor climb must still run to unlink the in-depth files.
        this.handleGone(abs);
      } else {
        this.emit("error", error);
      }
      return;
    }

    const segments = relPath.split(sep).length;
    if (segments > this.maxSegments) return;

    if (stat.isDirectory()) {
      const node = this.getOrCreateNode(abs);
      // The event names this directory: direct evidence its own namespace
      // may have changed, which outranks a cached signature that a rapid
      // add/remove pair can leave unchanged on coarse-timestamp
      // filesystems (see DirSig). Clear only this node's own gates — the
      // burst model above surfaces a change as the touched file (ungated
      // branch below), its parent directory (this branch), or the root
      // (null branch, which clears the whole tree), so deeper levels keep
      // their gates and the descent stays cheap.
      node.walkSig = null;
      node.sweepSig = null;
      this.walk(abs, node, segments);
      this.sweep(abs, node);
      return;
    }
    if (!stat.isFile() || this.ignored.has(abs)) return;
    if (this.known.has(abs)) {
      this.emit("change", abs);
    } else {
      this.addKnownFile(this.getOrCreateNode(this.parentDir(abs)), abs);
      this.emit("add", abs);
    }
  }

  /** A path disappeared: unlink it if it was a known file, else treat it
   * as a removed directory and unlink every known file underneath. Then
   * climb toward the root sweeping any ancestor that is also gone — a
   * recursive directory delete may surface as a single event for one
   * arbitrary child, with the directory's own event coalesced away. */
  private handleGone(abs: string): void {
    if (this.known.has(abs)) {
      this.delKnownFile(this.getOrCreateNode(this.parentDir(abs)), abs);
      if (!this.ignored.has(abs)) this.emit("unlink", abs);
    } else {
      this.sweep(abs, this.getOrCreateNode(abs));
    }

    let dir = abs;
    while (true) {
      const parent = dir.slice(0, dir.lastIndexOf(sep));
      if (!parent.startsWith(this.root + sep)) return;
      try {
        statSync(parent);
        return; // live ancestor: nothing above it was deleted
      } catch (error) {
        if (!isEnoent(error)) return; // unreadable, not deleted
        this.sweep(parent, this.getOrCreateNode(parent));
        dir = parent;
      }
    }
  }

  /** Emit `unlink` for known files under `dir`'s subtree that no longer
   * exist. Re-stats a directory's files only when its signature changed,
   * but ALWAYS recurses so a deletion deeper in the tree is still swept.
   *
   * Reads/writes `sweepSig` ONLY, never `walkSig`: a shared field would let
   * a same-event walk consume the signature delta and skip this sweep,
   * dropping every co-occurring unlink (the null-event reconcile contract). */
  private sweep(dir: string, node: DirNode): void {
    let sig: DirSig;
    try {
      sig = statDirSig(dir);
    } catch (error) {
      if (isEnoent(error)) {
        this.unlinkSubtree(node); // dir gone: its cached files are all gone
        return;
      }
      this.emit("error", error);
      return;
    }
    if (!sigEqual(sig, node.sweepSig)) {
      for (const file of [...node.files]) {
        try {
          statSync(file);
        } catch (error) {
          if (!isEnoent(error)) continue; // unreadable, not deleted
          this.delKnownFile(node, file);
          if (!this.ignored.has(file)) this.emit("unlink", file);
        }
      }
      node.sweepSig = sig;
    }
    // Iterate the Map directly (no per-reconcile snapshot allocation) and
    // defer prunes so the recursion above never mutates what we're iterating.
    // The recursive sweep only ever deletes from the CHILD's childDirs, not
    // this node's, so direct iteration is safe; the only writes to
    // node.childDirs are the deferred deletes below.
    let toPrune: string[] | undefined;
    for (const [childAbs, child] of node.childDirs) {
      if (this.closed) return;
      this.sweep(childAbs, child);
      if (
        child.files.size === 0 &&
        child.childDirs.size === 0 &&
        !this.dirExists(childAbs)
      ) {
        (toPrune ??= []).push(childAbs);
      }
    }
    if (toPrune)
      for (const childAbs of toPrune) node.childDirs.delete(childAbs);
  }

  /** Emit `unlink` for every known file in `node`'s cached subtree without
   * statting — the directory above them is already confirmed gone — then
   * drop the subtree so a recreate at the same path re-arms via fresh
   * nodes rather than stale signatures. */
  private unlinkSubtree(node: DirNode): void {
    for (const file of [...node.files]) {
      this.delKnownFile(node, file);
      if (!this.ignored.has(file)) this.emit("unlink", file);
    }
    for (const child of node.childDirs.values()) {
      this.unlinkSubtree(child);
    }
    node.childDirs.clear();
  }
}

/**
 * Watch an agent log tree, preferring the native recursive watcher and
 * falling back to chokidar when the root is missing (chokidar tolerates
 * watching a not-yet-created directory) or recursive `fs.watch` is
 * unsupported on this platform.
 *
 * Substrate choice is made once, at construction. Known limitation: if
 * the watched root is deleted at runtime, the native stream goes dead
 * silently (chokidar would re-arm on recreation), so files in a recreated
 * root are unseen until the daemon restarts. Acceptable for the agent log
 * trees, which agents recreate only alongside new sessions that pane
 * scanning and markers surface anyway.
 */
export function createLogTreeWatcher(
  root: string,
  depth?: number,
): LogTreeWatcher {
  if (existsSync(root)) {
    try {
      return new NativeLogTreeWatcher(root, depth);
    } catch {
      // fall through to chokidar
    }
  }
  return chokidarWatch(root, {
    persistent: true,
    ignoreInitial: false,
    depth,
  }) as unknown as LogTreeWatcher;
}
