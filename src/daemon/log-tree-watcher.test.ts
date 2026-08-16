import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  appendFileSync,
  unlinkSync,
  statSync,
  chmodSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createLogTreeWatcher, type LogTreeWatcher } from "./log-tree-watcher";

/** The slice of a NativeLogTreeWatcher's internals these white-box tests
 * reach via the same `as unknown as` cast the existing tests use. */
type TreeNode = { files: Set<string>; childDirs: Map<string, TreeNode> };
type Internals = {
  handleEvent(relPath: string | null): void;
  known: Set<string>;
  rootNode: TreeNode;
};
function flattenTree(node: TreeNode, into: Set<string>): Set<string> {
  for (const f of node.files) into.add(f);
  for (const child of node.childDirs.values()) flattenTree(child, into);
  return into;
}

/** FSEvents delivery is not instant; poll until the predicate holds. */
async function until(pred: () => boolean, maxMs = 2000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    if (pred()) return true;
    await Bun.sleep(25);
  }
  return pred();
}

describe("LogTreeWatcher (native)", () => {
  let root: string;
  let watcher: LogTreeWatcher | null = null;
  let added: string[];
  let changed: string[];
  let unlinked: string[];
  let errors: unknown[];

  function startWatcher(depth?: number): Promise<void> {
    watcher = createLogTreeWatcher(root, depth);
    watcher.on("add", (p) => added.push(p));
    watcher.on("change", (p) => changed.push(p));
    watcher.on("unlink", (p) => unlinked.push(p));
    // Capture errors so an emitted `error` never throws as unhandled, and so
    // tests can assert a fault was surfaced rather than swallowed.
    watcher.on("error", (e) => errors.push(e));
    return new Promise((resolve) => watcher!.on("ready", () => resolve()));
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ccmux-tree-watch-"));
    added = [];
    changed = [];
    unlinked = [];
    errors = [];
  });

  afterEach(async () => {
    await watcher?.close();
    watcher = null;
    rmSync(root, { recursive: true, force: true });
  });

  it("emits add for existing files before ready, respecting depth", async () => {
    mkdirSync(join(root, "proj-a", "session", "subagents"), {
      recursive: true,
    });
    writeFileSync(join(root, "proj-a", "top.jsonl"), "x\n");
    writeFileSync(
      join(root, "proj-a", "session", "subagents", "deep.jsonl"),
      "x\n",
    );

    await startWatcher(1);

    expect(added).toEqual([join(root, "proj-a", "top.jsonl")]);
  });

  it("emits change for appends to a known file", async () => {
    mkdirSync(join(root, "proj-a"));
    const file = join(root, "proj-a", "log.jsonl");
    writeFileSync(file, "line1\n");
    await startWatcher(1);

    appendFileSync(file, "line2\n");

    expect(await until(() => changed.includes(file))).toBe(true);
    expect(added).toEqual([file]); // initial walk only, no duplicate add
  });

  it("discovers a file created inside a brand-new directory", async () => {
    await startWatcher(1);

    // On macOS the file inside a just-created directory often only
    // surfaces as the directory's event; the dir walk must find it.
    mkdirSync(join(root, "proj-new"));
    const file = join(root, "proj-new", "fresh.jsonl");
    writeFileSync(file, "x\n");

    expect(await until(() => added.includes(file))).toBe(true);
  });

  it("emits unlink for a deleted file", async () => {
    mkdirSync(join(root, "proj-a"));
    const file = join(root, "proj-a", "log.jsonl");
    writeFileSync(file, "x\n");
    await startWatcher(1);

    unlinkSync(file);

    expect(await until(() => unlinked.includes(file))).toBe(true);
  });

  it("emits unlink for every known file under a deleted directory", async () => {
    mkdirSync(join(root, "proj-a"));
    const f1 = join(root, "proj-a", "one.jsonl");
    const f2 = join(root, "proj-a", "two.jsonl");
    writeFileSync(f1, "x\n");
    writeFileSync(f2, "x\n");
    await startWatcher(1);

    rmSync(join(root, "proj-a"), { recursive: true, force: true });

    expect(
      await until(() => unlinked.includes(f1) && unlinked.includes(f2)),
    ).toBe(true);
  });

  it("unwatch suppresses events until add re-arms the file", async () => {
    mkdirSync(join(root, "proj-a"));
    const file = join(root, "proj-a", "log.jsonl");
    writeFileSync(file, "x\n");
    await startWatcher(1);

    watcher!.unwatch(file);
    appendFileSync(file, "y\n");
    await Bun.sleep(400);
    expect(changed).toEqual([]);

    watcher!.add(file);
    appendFileSync(file, "z\n");
    expect(await until(() => changed.includes(file))).toBe(true);
  });

  it("unwatch suppression survives deletion and recreation", async () => {
    mkdirSync(join(root, "proj-a"));
    const file = join(root, "proj-a", "log.jsonl");
    writeFileSync(file, "x\n");
    await startWatcher(1);

    watcher!.unwatch(file);
    unlinkSync(file);
    await Bun.sleep(200);
    writeFileSync(file, "y\n");
    await Bun.sleep(400);

    expect(added).toEqual([file]); // the initial walk only
    expect(changed).toEqual([]);
    expect(unlinked).toEqual([]);
  });

  it("classifies a deletion surfacing as a too-deep path event", async () => {
    mkdirSync(join(root, "proj-a", "session", "subagents"), {
      recursive: true,
    });
    const top = join(root, "proj-a", "top.jsonl");
    writeFileSync(top, "x\n");
    await startWatcher(1);

    rmSync(join(root, "proj-a"), { recursive: true, force: true });
    // A recursive delete may coalesce into a single event naming a path
    // beyond the depth limit; the gone-classification must still run so
    // the ancestor climb unlinks the in-depth files. Deliver the deep
    // event directly since coalescing can't be provoked reliably.
    (
      watcher as unknown as { handleEvent(relPath: string | null): void }
    ).handleEvent(join("proj-a", "session", "subagents", "deep.jsonl"));

    expect(unlinked).toContain(top);
  });

  it("reconciles the whole tree on an event with no path", async () => {
    mkdirSync(join(root, "proj-a"));
    const gone = join(root, "proj-a", "gone.jsonl");
    writeFileSync(gone, "x\n");
    await startWatcher(1);

    // FSEvents may coalesce a burst into a single event whose path is
    // null; the watcher must then reconcile everything from the root.
    // Deliver that event directly since it can't be provoked reliably.
    const fresh = join(root, "proj-a", "fresh.jsonl");
    writeFileSync(fresh, "x\n");
    unlinkSync(gone);
    (
      watcher as unknown as { handleEvent(relPath: string | null): void }
    ).handleEvent(null);

    expect(added).toContain(fresh);
    expect(unlinked).toContain(gone);
  });

  it("reopens nested gates on a null event when directory signatures collide", async () => {
    const project = join(root, "proj-a");
    mkdirSync(project);
    const gone = join(project, "gone.jsonl");
    writeFileSync(gone, "x\n");
    await startWatcher(1);

    const evt = watcher as unknown as Internals;
    evt.handleEvent(null);

    const fresh = join(project, "fresh.jsonl");
    writeFileSync(fresh, "x\n");
    unlinkSync(gone);

    // Model a filesystem whose timestamp granularity lets the rapid pair of
    // mutations retain a cached child signature. Reopening only the root
    // gates cannot discover either change below that still-closed child.
    const current = statSync(project, { bigint: true });
    const collidingSig = {
      mtimeNs: current.mtimeNs,
      ctimeNs: current.ctimeNs,
    };
    const projectNode = evt.rootNode.childDirs.get(project) as TreeNode & {
      walkSig: typeof collidingSig;
      sweepSig: typeof collidingSig;
    };
    projectNode.walkSig = collidingSig;
    projectNode.sweepSig = collidingSig;

    evt.handleEvent(null);

    expect(added).toContain(fresh);
    expect(unlinked).toContain(gone);
  });

  it("trusts a named directory event over a colliding cached signature", async () => {
    const project = join(root, "proj-a");
    mkdirSync(project);
    const gone = join(project, "gone.jsonl");
    writeFileSync(gone, "x\n");
    await startWatcher(1);

    const evt = watcher as unknown as Internals;
    evt.handleEvent(null); // populate both gate signatures for proj-a

    const fresh = join(project, "fresh.jsonl");
    writeFileSync(fresh, "x\n");
    unlinkSync(gone);

    // Model a filesystem whose timestamp granularity lets the rapid pair of
    // mutations retain the named directory's cached signature. The event
    // names proj-a itself, so the gate must yield to that direct evidence.
    const current = statSync(project, { bigint: true });
    const collidingSig = {
      mtimeNs: current.mtimeNs,
      ctimeNs: current.ctimeNs,
    };
    const projectNode = evt.rootNode.childDirs.get(project) as TreeNode & {
      walkSig: typeof collidingSig;
      sweepSig: typeof collidingSig;
    };
    projectNode.walkSig = collidingSig;
    projectNode.sweepSig = collidingSig;

    evt.handleEvent("proj-a");

    expect(added).toContain(fresh);
    expect(unlinked).toContain(gone);
  });

  it("falls back to chokidar without throwing when the root is missing", async () => {
    // Parity with the pre-native behavior: a missing log dir (fresh
    // machine, agent never run) must construct and reach ready without
    // throwing. Discovery of the late-created root is not part of the
    // contract; sessions there surface via markers and pane scanning.
    const missing = join(root, "does-not-exist-yet");
    const fallback = createLogTreeWatcher(missing, 1);
    const ready = await new Promise<boolean>((resolve) => {
      fallback.on("ready", () => resolve(true));
      setTimeout(() => resolve(false), 3000);
    });

    expect(ready).toBe(true);
    await fallback.close();
  });

  it("emits both add and unlink on a null event after the signatures are cached", async () => {
    // The critical trap: walk and sweep MUST gate on separate signatures.
    // With a shared field the walk consumes the directory's signature change
    // and the sweep then skips, dropping the co-occurring unlink.
    mkdirSync(join(root, "proj-a"));
    const gone = join(root, "proj-a", "gone.jsonl");
    writeFileSync(gone, "x\n");
    await startWatcher(1);

    const evt = watcher as unknown as Internals;
    evt.handleEvent(null); // prime BOTH walkSig and sweepSig

    const fresh = join(root, "proj-a", "fresh.jsonl");
    writeFileSync(fresh, "x\n");
    unlinkSync(gone);
    evt.handleEvent(null);

    expect(added).toContain(fresh);
    expect(unlinked).toContain(gone);
  });

  it("still sweeps a deletion when the directory mtime collides (ctime gate)", async () => {
    // On coarse-mtime filesystems two same-second mutations share an mtime
    // tick; the sweep must still fire because the gate also keys on ctime.
    // Force the collision precisely: make the cached signature's mtime equal
    // the current mtime but its ctime differ. A gate keyed on mtime alone
    // would skip and silently lose the unlink.
    mkdirSync(join(root, "proj-a"));
    const a = join(root, "proj-a", "a.jsonl");
    const b = join(root, "proj-a", "b.jsonl");
    writeFileSync(a, "x\n");
    writeFileSync(b, "x\n");
    await startWatcher(1);

    const evt = watcher as unknown as Internals;
    evt.handleEvent("proj-a"); // cache proj-a's sweepSig
    const projNode = evt.rootNode.childDirs.get(
      join(root, "proj-a"),
    ) as unknown as {
      sweepSig: { mtimeNs: bigint; ctimeNs: bigint } | null;
    };
    expect(projNode.sweepSig).not.toBeNull();

    unlinkSync(b);
    const cur = statSync(join(root, "proj-a"), { bigint: true });
    projNode.sweepSig = { mtimeNs: cur.mtimeNs, ctimeNs: cur.ctimeNs - 1n };
    evt.handleEvent("proj-a");

    expect(unlinked).toContain(b);
    expect(unlinked).not.toContain(a);
  });

  it("keeps the flat known set in lockstep with the directory tree", async () => {
    mkdirSync(join(root, "proj-a"));
    mkdirSync(join(root, "proj-b"));
    const f1 = join(root, "proj-a", "one.jsonl");
    const f2 = join(root, "proj-a", "two.jsonl");
    const f3 = join(root, "proj-b", "three.jsonl");
    writeFileSync(f1, "x\n");
    writeFileSync(f2, "x\n");
    writeFileSync(f3, "x\n");
    await startWatcher(1);

    const evt = watcher as unknown as Internals;
    const f4 = join(root, "proj-b", "four.jsonl");
    writeFileSync(f4, "x\n");
    unlinkSync(f1);
    evt.handleEvent(null);

    const flat = flattenTree(evt.rootNode, new Set<string>());
    expect([...flat].sort()).toEqual([...evt.known].sort());
  });

  it("discovers a new file through unchanged ancestor directories", async () => {
    mkdirSync(join(root, "a", "b"), { recursive: true });
    writeFileSync(join(root, "a", "b", "existing.jsonl"), "x\n");
    await startWatcher(3);

    const evt = watcher as unknown as Internals;
    evt.handleEvent(null); // cache sigs for root, a, a/b

    // Adding a file under a/b bumps only a/b's signature; root and a are
    // unchanged, so the gate-closed branch must still recurse to find it.
    const fresh = join(root, "a", "b", "fresh.jsonl");
    writeFileSync(fresh, "x\n");
    evt.handleEvent(null);

    expect(added).toContain(fresh);
  });

  it("prunes a deleted subtree so a recreate re-arms cleanly", async () => {
    mkdirSync(join(root, "proj-a"));
    const f = join(root, "proj-a", "log.jsonl");
    writeFileSync(f, "x\n");
    await startWatcher(1);

    const evt = watcher as unknown as Internals;
    evt.handleEvent(null);
    expect(evt.rootNode.childDirs.has(join(root, "proj-a"))).toBe(true);

    rmSync(join(root, "proj-a"), { recursive: true, force: true });
    evt.handleEvent(null);

    expect(unlinked).toContain(f);
    expect(evt.rootNode.childDirs.has(join(root, "proj-a"))).toBe(false);

    // Recreate at the same path: a fresh node re-arms and re-adds.
    mkdirSync(join(root, "proj-a"));
    const f2 = join(root, "proj-a", "log2.jsonl");
    writeFileSync(f2, "x\n");
    evt.handleEvent(null);

    expect(added).toContain(f2);
  });

  it("keeps known and the tree in lockstep when add() re-arms a removed file", async () => {
    // add() is the one re-arm path that touches the flat set directly; if it
    // skipped the tree, a later sweep (which scans node.files) could never
    // unlink the re-armed path. Force the drift: delete a file so it leaves
    // both indexes, then re-arm via add() and assert lockstep holds.
    mkdirSync(join(root, "proj-a"));
    const file = join(root, "proj-a", "log.jsonl");
    writeFileSync(file, "x\n");
    await startWatcher(1);

    const evt = watcher as unknown as Internals;
    unlinkSync(file);
    evt.handleEvent(join("proj-a", "log.jsonl")); // process the unlink
    expect(evt.known.has(file)).toBe(false);

    watcher!.add(file); // consumer re-arms the path (rewatchFile)

    const flat = flattenTree(evt.rootNode, new Set<string>());
    expect([...flat].sort()).toEqual([...evt.known].sort());
    expect(flat.has(file)).toBe(true);
  });

  // chmod 0o000 is a no-op for root, which would defeat the EACCES setup.
  const isRoot = (process.getuid?.() ?? 0) === 0;
  (isRoot ? it.skip : it)(
    "surfaces a non-ENOENT stat error without emitting a spurious unlink",
    async () => {
      // The load-bearing invariant (see the isEnoent docstring): an EACCES on
      // a still-present path must NOT be classified as a deletion, or a live
      // session row gets torn down. Make proj-a unreadable so the walk's
      // readdir AND the sweep's per-file statSync both hit EACCES, then assert
      // no unlink fired, the files stay known, and the fault surfaced as an
      // `error` (walk re-emits non-ENOENT errors rather than swallowing them).
      mkdirSync(join(root, "proj-a"));
      const a = join(root, "proj-a", "a.jsonl");
      const b = join(root, "proj-a", "b.jsonl");
      writeFileSync(a, "x\n");
      writeFileSync(b, "x\n");
      await startWatcher(1);

      const evt = watcher as unknown as Internals;
      evt.handleEvent("proj-a"); // populate proj-a's node + cache its sigs
      const projNode = evt.rootNode.childDirs.get(
        join(root, "proj-a"),
      ) as unknown as { walkSig: unknown; sweepSig: unknown };

      chmodSync(join(root, "proj-a"), 0o000); // reads now fail with EACCES
      // Force both gates open so the readdir (walk) and per-file stat (sweep)
      // actually run instead of short-circuiting on an unchanged signature.
      projNode.walkSig = null;
      projNode.sweepSig = null;
      try {
        evt.handleEvent(null);

        expect(unlinked).toEqual([]); // EACCES is not a deletion
        expect(evt.known.has(a)).toBe(true);
        expect(evt.known.has(b)).toBe(true);
        expect(errors.length).toBeGreaterThan(0); // the fault was surfaced
      } finally {
        chmodSync(join(root, "proj-a"), 0o755); // let afterEach clean up
      }
    },
  );
});
