import { expect, test } from "bun:test";
import { teardownAll } from "./teardown";

test("reports a failed inspection's message, whatever was thrown", () => {
  const thrown: unknown[] = [new Error("agent-tool teardown could not run: ENOENT"), "spawn failed"];
  const result = teardownAll([{ repo: "a2f0/one", path: "/one" }, { repo: "a2f0/two", path: "/two" }], () => { throw thrown.shift(); }, false);
  expect(result.ok).toBe(false);
  expect(result.repos.map(item => item.problems)).toEqual([["agent-tool teardown could not run: ENOENT"], ["spawn failed"]]);
});
