import { describe, it, expect } from "bun:test";
import {
  daemonError,
  daemonBody,
  readBoolean,
  readString,
} from "./daemon-json";

/** A `Response` carrying an arbitrary body, including bodies `json()` rejects. */
function res(body: string, status = 200): Response {
  return new Response(body, { status });
}

describe("daemonError", () => {
  it("returns the error string an endpoint sent", async () => {
    expect(await daemonError(res(JSON.stringify({ error: "nope" }), 400))).toBe(
      "nope",
    );
  });

  it("returns null rather than throwing on a non-JSON body", async () => {
    // A proxy's HTML error page, or a daemon that died mid-response: the
    // caller's fallback message is the right answer, not a second failure.
    expect(await daemonError(res("<html>502</html>", 502))).toBeNull();
  });

  it("returns null for an empty body", async () => {
    expect(await daemonError(res("", 500))).toBeNull();
  });

  it("returns null when the body is JSON but carries no error", async () => {
    expect(await daemonError(res(JSON.stringify({ ok: false })))).toBeNull();
  });

  it("ignores a non-string or empty error field", async () => {
    expect(await daemonError(res(JSON.stringify({ error: 42 })))).toBeNull();
    expect(await daemonError(res(JSON.stringify({ error: "" })))).toBeNull();
  });

  it("ignores an array body", async () => {
    expect(await daemonError(res(JSON.stringify([{ error: "x" }])))).toBeNull();
  });
});

describe("readBoolean / readString", () => {
  it("reads a present field of the right type", () => {
    expect(readBoolean({ killed: false }, "killed")).toBe(false);
    expect(readString({ socketPath: "/tmp/s" }, "socketPath")).toBe("/tmp/s");
  });

  it("returns null for an absent field", () => {
    // The distinction the kill path depends on: absent is not `false`.
    expect(readBoolean({}, "killed")).toBeNull();
    expect(readString({}, "socketPath")).toBeNull();
  });

  it("returns null for a field of the wrong type", () => {
    expect(readBoolean({ killed: "yes" }, "killed")).toBeNull();
    expect(readString({ socketPath: null }, "socketPath")).toBeNull();
  });

  it("returns null for a non-object body", () => {
    for (const body of [null, undefined, 3, "str", [1]]) {
      expect(readBoolean(body, "killed")).toBeNull();
      expect(readString(body, "socketPath")).toBeNull();
    }
  });
});

describe("daemonBody", () => {
  it("returns the parsed object", async () => {
    const body = await daemonBody<{ sessions: number[] }>(
      res(JSON.stringify({ sessions: [1, 2] })),
      "sessions",
    );
    expect(body.sessions).toEqual([1, 2]);
  });

  it("throws naming the shape when the body is not JSON", async () => {
    await expect(daemonBody(res("<html>"), "transcript")).rejects.toThrow(
      "non-JSON transcript",
    );
  });

  it("throws when the body is JSON but not an object", async () => {
    await expect(daemonBody(res(JSON.stringify("hi")), "scan")).rejects.toThrow(
      "malformed scan",
    );
    await expect(daemonBody(res(JSON.stringify([1])), "scan")).rejects.toThrow(
      "malformed scan",
    );
  });
});
