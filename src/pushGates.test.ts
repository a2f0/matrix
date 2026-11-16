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
  // A GitHub expression, built so it is not mistaken for a template placeholder.
  const expression = (text: string) => `$\{{ ${text} }}`;
  test("matches required checks by name, matrix suffix, reusable-workflow prefix, and expression prefix", () => {
    const required = ["build (ubuntu-latest)", "windows / Windows CEF persistence", "Smoke (node 20)"];
    const workflow = (name: string) => ({ jobs: { pre: job({ name }), deploy: job({ needs: "pre" }) } });
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

  test("does not count needs that a job may run after failing", () => {
    const shipping = (publishIf?: string, packIf?: string) =>
      ungatedShippingJobs(
        {
          jobs: {
            test: job({ steps: [{ run: "bun test" }] }),
            pack: job({ needs: "test", ...(packIf ? { if: packIf } : {}) }),
            publish: job({ needs: "pack", ...(publishIf ? { if: publishIf } : {}) }),
          },
        },
        [],
      );
    expect(shipping()).toEqual([]);
    expect(shipping("github.ref == 'refs/heads/main'")).toEqual([]);
    for (const condition of ["always()", "!cancelled()", "failure() || success()", "always() && github.ref == 'refs/heads/main'"]) {
      expect(shipping(condition)).toEqual(["publish"]);
      expect(shipping(undefined, condition)).toEqual(["publish"]);
    }
    expect(shipping("always() && needs.pack.result == 'success'")).toEqual([]);
    expect(shipping("needs.pack.result == 'success' || always()")).toEqual(["publish"]);
    // Only the needs whose success the condition requires count.
    const deploy = (condition: string) =>
      ungatedShippingJobs(
        { jobs: { tests: job({ steps: [{ run: "bun test" }] }), build: job({}), deploy: job({ needs: ["tests", "build"], if: condition }) } },
        [],
      );
    expect(deploy("always() && needs.build.result == 'success'")).toEqual(["deploy"]);
    expect(deploy("always() && needs.tests.result == 'success'")).toEqual([]);
    expect(deploy(expression("!cancelled() && (needs.tests.result == 'success')"))).toEqual([]);
    // Negation could invert a comparison, so a condition with one requires nothing.
    for (const condition of [
      "always() && !(needs.tests.result == 'success')",
      "always() && !(github.ref == 'x' && needs.tests.result == 'success')",
      "always() && needs.tests.result == 'success' || failure()",
    ])
      expect(deploy(condition)).toEqual(["deploy"]);
    expect(deploy("always() && needs.tests.result == 'success' && github.ref != 'refs/heads/x'")).toEqual([]);
  });

  test("counts only validation whose failure fails the job", () => {
    const publish = (testStep: Record<string, unknown>, testJob: Record<string, unknown> = {}) =>
      ungatedShippingJobs({ jobs: { prepare: job({ steps: [testStep], ...testJob }), publish: job({ needs: "prepare" }) } }, []);
    expect(publish({ run: "bun test" })).toEqual([]);
    // Conditions the file cannot evaluate are trusted, such as a release workflow's shared publish condition.
    for (const runs of [{ "continue-on-error": false }, { if: "steps.version.outputs.publish == 'true'" }, { if: "always()" }, { if: "!cancelled()" }])
      expect(publish({ run: "bun test", ...runs })).toEqual([]);
    for (const skipped of [
      { if: false },
      { if: "false" },
      { if: expression("false") },
      { if: "failure()" },
      { if: "cancelled()" },
      { "continue-on-error": true },
      { "continue-on-error": expression("true") },
    ])
      expect(publish({ run: "bun test", ...skipped })).toEqual(["publish"]);
    expect(publish({ run: "bun test" }, { "continue-on-error": true })).toEqual(["publish"]);
    // The shipping job's own validation follows the same rule.
    const own = (testStep: Record<string, unknown>) => ungatedShippingJobs({ jobs: { publish: job({ steps: [testStep, { run: "npm publish" }] }) } }, []);
    expect(own({ run: "bun test" })).toEqual([]);
    expect(own({ run: "bun test", if: "false" })).toEqual(["publish"]);
  });

  test("counts validation in the shipping job only before it ships", () => {
    const publish = (...runs: Array<string | Record<string, unknown>>) =>
      ungatedShippingJobs({ jobs: { publish: job({ steps: runs.map(run => (typeof run === "string" ? { run } : run)) }) } }, []);
    expect(publish("bun test", "npm publish")).toEqual([]);
    expect(publish("bun test && npm publish")).toEqual([]);
    expect(publish("npm publish", "bun test")).toEqual(["publish"]);
    expect(publish("npm publish && bun test")).toEqual(["publish"]);
    expect(publish({ uses: "cloudflare/wrangler-action@v3", with: { command: "deploy" } }, "bun test")).toEqual(["publish"]);
    expect(publish("bun test", { uses: "cloudflare/wrangler-action@v3", with: { command: "deploy" } })).toEqual([]);
  });

  test("counts validation scripts but not installs that share their names", () => {
    const shipping = (run: string) => ungatedShippingJobs({ jobs: { publish: job({ steps: [{ run }, { run: "npm publish" }] }) } }, []);
    for (const run of ["npm ci", "pnpm ci", "yarn ci", "bun ci", "npm install"]) expect(shipping(run)).toEqual(["publish"]);
    for (const run of ["npm run ci", "bun run check", "npm test", "bun test", "pnpm run test:unit", "cargo test --all"]) expect(shipping(run)).toEqual([]);
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
