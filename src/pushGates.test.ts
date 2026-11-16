import { describe, expect, test } from "bun:test";
import { filterMatches, strictFreshness } from "./pushGates";

describe("filterMatches", () => {
  test("reads GitHub branch filters, with the last matching pattern deciding", () => {
    expect(filterMatches(["main"], "main")).toBe(true);
    expect(filterMatches(["*"], "feat/x")).toBe(false);
    expect(filterMatches(["**"], "feat/x")).toBe(true);
    expect(filterMatches(["**", "!main"], "main")).toBe(false);
    expect(filterMatches(["!main", "**"], "main")).toBe(true);
  });
});

describe("strictFreshness", () => {
  test("names classic protection and each strict active ruleset rule", () => {
    const calls: string[][] = [];
    const found = strictFreshness("a2f0/x", "main", args => {
      calls.push(args);
      if (args[1]!.endsWith("/protection")) return JSON.stringify({ required_status_checks: { strict: true } });
      return JSON.stringify([
        { type: "required_status_checks", ruleset_id: 7, parameters: { strict_required_status_checks_policy: true } },
        { type: "required_status_checks", ruleset_id: 8, parameters: { strict_required_status_checks_policy: false } },
        { type: "pull_request", ruleset_id: 9, parameters: {} },
      ]);
    });
    expect(found).toEqual(["classic branch protection", "ruleset 7"]);
    expect(calls).toEqual([
      ["api", "repos/a2f0/x/branches/main/protection"],
      ["api", "repos/a2f0/x/rules/branches/main"],
    ]);
  });

  test("treats an unprotected branch as no classic rule and passes other errors through", () => {
    const unprotected = (args: string[]) => {
      if (args[1]!.endsWith("/protection")) throw new Error("gh api failed (gh: Branch not protected (HTTP 404)).");
      return "[]";
    };
    expect(strictFreshness("a2f0/x", "main", unprotected)).toEqual([]);
    expect(() =>
      strictFreshness("a2f0/x", "main", () => {
        throw new Error("gh api failed (HTTP 403).");
      }),
    ).toThrow("HTTP 403");
  });
});
