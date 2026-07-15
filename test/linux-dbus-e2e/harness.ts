// Drives the REAL ccmux DbusNotifier against a real session bus + the python
// stub server. Asserts the wire protocol and the signal round-trip, then
// writes $CCMUX_DBUS_E2E_OUT/RESULT.json.
//
// Imports are repo-relative so this resolves whether the repo root is a Docker
// `/work` mount (run-local.sh) or a native CI checkout (linux-dbus-e2e.yml).
import { DbusNotifier } from "../../src/lib/notify-dbus.ts";
import type { NotificationPayload } from "../../src/lib/notify.ts";

const OUT = process.env.CCMUX_DBUS_E2E_OUT;
if (!OUT) {
  throw new Error("CCMUX_DBUS_E2E_OUT must be set");
}

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const notifier = new DbusNotifier();

  // 1. probe() → GetServerInformation round-trip
  const probed = await notifier.probe(3000);
  check(
    "probe() succeeds against a real bus",
    probed === true,
    `probe=${probed}`,
  );

  // 2. permission notification: actions [default,Open, approve,Approve, deny,Deny]
  const permPayload: NotificationPayload = {
    title: "ccmux",
    body: "curl -sI https://example.com",
    event: "waiting",
    sessionId: "permA",
    agent: "claude",
    project: "ccmux",
    actions: [
      { id: "approve", label: "Approve" },
      { id: "deny", label: "Deny" },
    ],
  };
  const permCalls: { key: string; text?: string }[] = [];
  const permId = await notifier.notify(permPayload, {
    canDefault: true,
    onAction: (key: string, text?: string) => permCalls.push({ key, text }),
  });
  check(
    "permission Notify returns an id",
    typeof permId === "number",
    `id=${permId}`,
  );

  // 3. question notification: actions [..., inline-reply, Reply] (capability-gated)
  const questPayload: NotificationPayload = {
    title: "ccmux",
    body: "What is your favorite season?",
    event: "waiting",
    sessionId: "questB",
    agent: "claude",
    project: "ccmux",
    reply: { id: "answer", label: "Reply" },
  };
  const questCalls: { key: string; text?: string }[] = [];
  const questId = await notifier.notify(questPayload, {
    canDefault: true,
    onAction: (key: string, text?: string) => questCalls.push({ key, text }),
  });
  check(
    "question Notify returns an id",
    typeof questId === "number",
    `id=${questId}`,
  );

  // Give the stub's GLib timeouts (200ms) time to emit the signals.
  await sleep(1200);

  // 4. ActionInvoked → onAction("approve")
  check(
    "ActionInvoked signal routes to onAction('approve')",
    permCalls.some((c) => c.key === "approve"),
    JSON.stringify(permCalls),
  );

  // 5. NotificationReplied → onAction('answer', text)  [inline-reply path]
  check(
    "NotificationReplied signal routes to onAction('answer', text)",
    questCalls.some((c) => c.key === "answer" && c.text === "e2e-typed-reply"),
    JSON.stringify(questCalls),
  );

  // 6. retract → CloseNotification
  await notifier.retract("permA");
  await sleep(400);
  check(
    "retract() issues CloseNotification for the tracked id",
    await Bun.file(`${OUT}/closed-${permId}.json`).exists(),
    `expected ${OUT}/closed-${permId}.json`,
  );

  // 7. inspect the recorded Notify args (independent server-side view)
  const notify1 = await Bun.file(`${OUT}/notify-1.json`).json();
  const notify2 = await Bun.file(`${OUT}/notify-2.json`).json();
  check(
    "permission Notify carried [default,Open,approve,Approve,deny,Deny]",
    JSON.stringify(notify1.actions) ===
      JSON.stringify(["default", "Open", "approve", "Approve", "deny", "Deny"]),
    JSON.stringify(notify1.actions),
  );
  check(
    "question Notify carried inline-reply (capability-gated on GetCapabilities)",
    notify2.actions.includes("inline-reply") &&
      notify2.actions.includes("Reply"),
    JSON.stringify(notify2.actions),
  );
  check(
    "app_name is 'ccmux' and urgency hint present",
    notify1.app_name === "ccmux" && notify1.hints?.urgency !== undefined,
    JSON.stringify({ app: notify1.app_name, hints: notify1.hints }),
  );

  await notifier.close();

  const passed = results.filter((r) => r.ok).length;
  const total = results.length;
  await Bun.write(
    `${OUT}/RESULT.json`,
    JSON.stringify(
      { passed, total, allPass: passed === total, results },
      null,
      2,
    ),
  );
  for (const r of results) {
    console.log(
      `${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : "  <<< " + r.detail}`,
    );
  }
  console.log(`\n${passed}/${total} passed`);

  // Fail the process on any failed assertion so `bun harness.ts` is a real
  // gate for the CI job (which trusts the exit code, not RESULT.json).
  if (passed !== total) process.exit(1);
}

main().catch(async (e) => {
  await Bun.write(
    `${OUT}/RESULT.json`,
    JSON.stringify(
      { passed: 0, total: 0, allPass: false, error: String(e) },
      null,
      2,
    ),
  );
  console.error("HARNESS ERROR:", e);
  process.exit(1);
});
