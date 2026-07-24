import { describe, it, expect, afterEach } from "bun:test";
import { testRender } from "@opentui/solid";
import { Header } from "./Header";
import type { ConnectionState } from "../utils/sse";

type Setup = Awaited<ReturnType<typeof testRender>>;
let setup: Setup;

afterEach(() => {
  setup?.renderer.destroy();
});

async function renderHeader(props: {
  sessionCount?: number;
  totalCount?: number;
  hideIdle?: boolean;
  connectionState?: ConnectionState;
  daemonDegraded?: boolean;
  dimmed?: boolean;
  invokeInFlight?: number;
  width?: number;
}) {
  setup = await testRender(
    () => (
      <Header
        sessionCount={props.sessionCount ?? 5}
        totalCount={props.totalCount}
        hideIdle={props.hideIdle}
        connectionState={props.connectionState ?? "connected"}
        daemonDegraded={props.daemonDegraded}
        dimmed={props.dimmed}
        invokeInFlight={props.invokeInFlight}
      />
    ),
    { width: props.width ?? 60, height: 3 },
  );
  await setup.renderOnce();
  return setup.captureCharFrame();
}

describe("Header", () => {
  it("renders Sessions label with count", async () => {
    const frame = await renderHeader({ sessionCount: 5 });
    expect(frame).toContain("Sessions");
    expect(frame).toContain("(5)");
  });

  it("shows total count when provided", async () => {
    const frame = await renderHeader({ sessionCount: 3, totalCount: 10 });
    expect(frame).toContain("(3/10)");
  });

  it("omits total count when not provided", async () => {
    const frame = await renderHeader({ sessionCount: 5 });
    expect(frame).toContain("(5)");
    expect(frame).not.toContain("/");
  });

  it("shows active indicator when hideIdle", async () => {
    const frame = await renderHeader({ hideIdle: true });
    expect(frame).toContain("[active]");
  });

  it("hides active indicator by default", async () => {
    const frame = await renderHeader({ hideIdle: false });
    expect(frame).not.toContain("[active]");
  });

  it("shows the in-flight invoke count when nonzero", async () => {
    const frame = await renderHeader({ invokeInFlight: 3 });
    expect(frame).toContain("3 invoking");
  });

  it("hides the in-flight count when zero or undefined", async () => {
    const zero = await renderHeader({ invokeInFlight: 0 });
    expect(zero).not.toContain("invoking");
    const none = await renderHeader({});
    expect(none).not.toContain("invoking");
  });

  it("renders connection dot", async () => {
    const frame = await renderHeader({ connectionState: "connected" });
    expect(frame).toContain("●");
  });

  it("renders dot for all connection states", async () => {
    const states: ConnectionState[] = [
      "connected",
      "reconnecting",
      "disconnected",
    ];
    for (const state of states) {
      const frame = await renderHeader({ connectionState: state });
      expect(frame).toContain("●");
    }
  });

  it("renders the degraded warning when daemonDegraded", async () => {
    const frame = await renderHeader({ daemonDegraded: true, width: 80 });
    expect(frame).toContain("daemon degraded: scans failing");
  });

  it("renders no degraded warning by default", async () => {
    const off = await renderHeader({});
    expect(off).not.toContain("daemon degraded");
    const explicit = await renderHeader({ daemonDegraded: false });
    expect(explicit).not.toContain("daemon degraded");
  });
});
