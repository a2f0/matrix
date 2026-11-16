import { describe, expect, test } from "bun:test";
import { filterMatches, strictFreshness, ungatedShippingJobs } from "./pushGates";

describe("filterMatches", () => {
  test("reads GitHub branch filters, with the last matching pattern deciding", () => {
    expect(filterMatches(["main"], "main")).toBe(true);
    expect(filterMatches(["*"], "feat/x")).toBe(false);
    expect(filterMatches(["**"], "feat/x")).toBe(true);
    expect(filterMatches(["**", "!main"], "main")).toBe(false);
    expect(filterMatches(["!main", "**"], "main")).toBe(true);
  });

  test("reads ?, +, and character classes as GitHub does, not as shell globs", () => {
    expect(filterMatches(["mai?n"], "main")).toBe(true);
    expect(filterMatches(["mai?n"], "man")).toBe(true);
    expect(filterMatches(["mai?n"], "maxn")).toBe(false);
    expect(filterMatches(["ma+in"], "maaain")).toBe(true);
    expect(filterMatches(["ma+in"], "min")).toBe(false);
    expect(filterMatches(["[lm]ain"], "main")).toBe(true);
    expect(filterMatches(["release/v[0-9]*"], "release/v2.1")).toBe(true);
    expect(filterMatches(["release/*"], "release/a/b")).toBe(false);
    expect(filterMatches(["release/**"], "release/a/b")).toBe(true);
    expect(filterMatches(["main.x"], "mainyx")).toBe(false);
    expect(filterMatches(["?main", "+main"], "main")).toBe(false);
    expect(filterMatches(["?main"], "?main")).toBe(true);
  });
});

describe("ungatedShippingJobs", () => {
  const job = (fields: Record<string, unknown>) => ({ "runs-on": "x", steps: [{ run: "true" }], ...fields });
  test("matches required checks by name, matrix suffix, reusable-workflow prefix, and expression prefix", () => {
    const required = ["build (ubuntu-latest)", "windows / Windows CEF persistence", "Smoke (node 20)"];
    const workflow = (name: string) => ({ jobs: { pre: job({ name }), deploy: job({ needs: "pre" }) } });
    // A GitHub expression, built so it is not mistaken for a template placeholder.
    const expression = (text: string) => `$\{{ ${text} }}`;
    for (const name of ["build", "windows", `Smoke (node ${expression("matrix.node")})`]) expect(ungatedShippingJobs(workflow(name), required)).toEqual([]);
    expect(ungatedShippingJobs(workflow("Package"), required)).toEqual(["deploy"]);
    expect(ungatedShippingJobs(workflow(expression("matrix.name")), required)).toEqual(["deploy"]);
  });

  test("follows needs through other jobs and survives cycles", () => {
    const jobs = {
      a: job({ needs: "b" }),
      b: job({ needs: ["a"] }),
      publish: job({ needs: ["a"] }),
    };
    expect(ungatedShippingJobs({ jobs }, [])).toEqual(["publish"]);
    expect(ungatedShippingJobs({ jobs: { ...jobs, b: job({ needs: ["a", "unit-tests"] }), "unit-tests": job({}) } }, [])).toEqual([]);
    expect(ungatedShippingJobs(undefined, [])).toEqual([]);
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
