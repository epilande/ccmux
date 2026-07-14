import solidPlugin from "@opentui/solid/bun-plugin";
import { mkdirSync, readdirSync, renameSync, rmSync, utimesSync } from "fs";
import { join } from "path";

// Build into a staging dir and rename into place. The ccmux launcher
// treats dist/index.js's mtime as the freshness marker and may exec it
// concurrently; an in-place write would bump the mtime at write START,
// letting a parallel launch see a half-written bundle as current. A
// failed build must also never replace a good bundle.
const STAGING = "./dist/.staging";
rmSync(STAGING, { recursive: true, force: true });

// Captured before the build so the published bundle can be backdated to
// it (below): an edit landing while the build runs must compare as newer
// than the bundle, or the launcher would treat a bundle missing that edit
// as current.
const buildStart = new Date();

const result = await Bun.build({
  entrypoints: ["./src/index.ts"],
  target: "bun",
  outdir: STAGING,
  plugins: [solidPlugin],
  // dbus-next (src/lib/notify-dbus.ts's dynamic `import("dbus-next")`, only
  // ever reached on Linux with the dbus notification backend) has one dead
  // code path, `getDbusAddressFromWindowSelection` in its address-x11.js,
  // that does a top-level-in-function `require('x11')` — a package dbus-next
  // itself doesn't declare as a dependency and that isn't installed. It's
  // never called (dbus-next only calls its sibling `getDbusAddressFromFs`),
  // but Bun's bundler still resolves every reachable `require`/`import`
  // regardless of whether the containing function ever runs, so the build
  // fails without this. Marking it external leaves a harmless unresolved
  // `require("x11")` in the bundle that's simply never executed.
  external: ["x11"],
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

mkdirSync("./dist", { recursive: true });
// Assets first, index.js last: asset names are content-hashed (never
// overwritten in place), so the final rename atomically publishes a
// bundle whose assets already exist.
const outputs = readdirSync(STAGING).sort(
  (a, b) => Number(a === "index.js") - Number(b === "index.js"),
);
for (const file of outputs) {
  renameSync(join(STAGING, file), join("./dist", file));
}
utimesSync("./dist/index.js", buildStart, buildStart);
rmSync(STAGING, { recursive: true, force: true });

console.log("Build complete: dist/index.js");
