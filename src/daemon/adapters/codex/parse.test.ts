import { describe, it, expect } from "bun:test";
import { isSubagentRollout } from "./parse";

describe("isSubagentRollout", () => {
  it("treats a thread with neither field as a user thread (pre-0.146 codex, backward compatible)", () => {
    expect(isSubagentRollout({})).toBe(false);
  });

  it('treats thread_source "user" as a user thread', () => {
    expect(isSubagentRollout({ thread_source: "user" })).toBe(false);
  });

  it("treats any non-user thread_source as a subagent thread", () => {
    expect(isSubagentRollout({ thread_source: "subagent" })).toBe(true);
  });

  it("treats a present parent_thread_id as a subagent thread even without thread_source", () => {
    expect(isSubagentRollout({ parent_thread_id: "parent-id" })).toBe(true);
  });

  it("treats a present parent_thread_id as a subagent thread even if thread_source says user", () => {
    // Not the real shape (the reviewer's thread_source is "subagent"), but
    // parent_thread_id alone is sufficient evidence, so this must still
    // exclude the rollout rather than trust thread_source.
    expect(
      isSubagentRollout({
        thread_source: "user",
        parent_thread_id: "parent-id",
      }),
    ).toBe(true);
  });
});
