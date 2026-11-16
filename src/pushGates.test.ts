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
    // Any status function drops GitHub's implicit success(); an explicit success() keeps every need.
    for (const condition of [
      "!success()",
      "!failure() && always()",
      "success() || failure()",
      // A compared group could invert what it holds.
      "always() && (success() && false) == false",
      "always() && (needs.tests.result == 'success') == false",
      "always() && (needs.tests.result == 'success' || true)",
    ])
      expect(deploy(condition)).toEqual(["deploy"]);
    for (const condition of ["always() && (needs.tests.result == 'success' && github.ref != 'x')", "ALWAYS() && needs.tests.result == 'SUCCESS'", "Success()"])
      expect(deploy(condition)).toEqual([]);
    for (const condition of ["success()", "success() && github.ref == 'refs/heads/main'", "github.ref == 'refs/heads/main'"])
      expect(deploy(condition)).toEqual([]);
  });

  test("counts only validation whose failure fails the job", () => {
    const publish = (testStep: Record<string, unknown>, testJob: Record<string, unknown> = {}) =>
      ungatedShippingJobs({ jobs: { prepare: job({ steps: [testStep], ...testJob }), publish: job({ needs: "prepare" }) } }, []);
    expect(publish({ run: "bun test" })).toEqual([]);
    // Conditions the file cannot evaluate are trusted, such as a release workflow's shared publish condition.
    for (const runs of [
      { "continue-on-error": false },
      { if: "steps.version.outputs.publish == 'true'" },
      { if: "always()" },
      { if: "!cancelled()" },
      { if: "!failure()" },
    ])
      expect(publish({ run: "bun test", ...runs })).toEqual([]);
    for (const skipped of [
      { if: false },
      { if: "false" },
      { if: expression("false") },
      { if: "failure()" },
      { if: "cancelled()" },
      { if: "!success()" },
      { if: "!always()" },
      // GitHub reads function names and literals without regard to case.
      { if: expression("Failure()") },
      { if: "CANCELLED()" },
      { if: "FALSE" },
      // A compared or alternative status function may skip a passing run.
      { if: "success() == false" },
      { if: "always() || github.ref == 'refs/heads/x'" },
      { "continue-on-error": true },
      { "continue-on-error": expression("true") },
    ])
      expect(publish({ run: "bun test", ...skipped })).toEqual(["publish"]);
    expect(publish({ run: "bun test" }, { "continue-on-error": true })).toEqual(["publish"]);
    // A job named for validation, or required, whose only validation cannot fail it validates nothing.
    const named = (id: string, testStep: Record<string, unknown>, required: string[] = []) =>
      ungatedShippingJobs({ jobs: { [id]: job({ steps: [testStep] }), publish: job({ needs: id }) } }, required);
    for (const excused of [{ "continue-on-error": true }, { if: "false" }, { run: "bun test || true" }]) {
      expect(named("test", { run: "bun test", ...excused })).toEqual(["publish"]);
      expect(named("gate", { run: "bun test", ...excused }, ["gate"])).toEqual(["publish"]);
    }
    expect(named("test", { run: "bun run build" })).toEqual([]);
    // A job named for validation whose command cannot fail it validates nothing.
    expect(named("tests", { run: "npx --yes vitest run || true" })).toEqual(["publish"]);
    expect(named("tests", { run: "./run-suite.sh || true" })).toEqual(["publish"]);
    expect(named("tests", { run: "npx --yes vitest run" })).toEqual([]);
    // A pipeline's status is its last command's, so a pipe from a command that only prints is safe.
    expect(named("gate", { run: "printf '%s\\n' \"$NEEDS\" | bun run agent-tool ci gate -" })).toEqual([]);
    expect(named("gate", { run: "bun run agent-tool ci gate - | tee gate.log" })).toEqual(["publish"]);
    // Under shell: bash, GitHub sets pipefail, so any pipe fails on a failed command.
    expect(named("tests", { run: "bun test | tee test.log", shell: "bash" })).toEqual([]);
    expect(named("tests", { run: "bun test | tee test.log" })).toEqual(["publish"]);
    expect(named("tests", { run: "echo start | bun test" })).toEqual([]);
    // A job trusted by its name must stop at any failed command, under its shell.
    expect(named("tests", { run: "./run-suite.sh; echo done", shell: "bash {0}" })).toEqual(["publish"]);
    expect(named("tests", { run: "./run-suite.sh; echo done" })).toEqual([]);
    expect(named("tests", { run: "./run-suite.sh && echo ok; echo done" })).toEqual(["publish"]);
    // An action whose failure is excused, or that a passing run skips, may be the tests.
    for (const excused of [{ "continue-on-error": true }, { if: "false" }, { if: "failure()" }])
      expect(named("tests", { uses: "acme/run-tests@v1", ...excused })).toEqual(["publish"]);
    expect(named("tests", { uses: "acme/run-tests@v1" })).toEqual([]);
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
    // A shipping step whose condition lets it run after the tests fail is not gated by them.
    for (const condition of ["always()", "!cancelled()", "failure() || success()"])
      expect(publish("bun test", { run: "npm publish", if: condition })).toEqual(["publish"]);
    for (const condition of ["success()", "github.ref == 'refs/heads/main'"]) expect(publish("bun test", { run: "npm publish", if: condition })).toEqual([]);
    // Every shipping step must be gated, not only the first.
    expect(publish("bun test", "npm publish", { run: "npm publish --tag next", if: "always()" })).toEqual(["publish"]);
    expect(publish("bun test", "npm publish", "npm publish --tag next")).toEqual([]);
  });

  test("counts only shell that stops at a failed test", () => {
    const publish = (...runs: Array<string | Record<string, unknown>>) =>
      ungatedShippingJobs({ jobs: { publish: job({ steps: runs.map(run => (typeof run === "string" ? { run } : run)) }) } }, []);
    // A command that can mask a failed test validates nothing.
    for (const masked of ["bun test || true; npm publish", "bun test | tee test.log; npm publish", "set +e; bun test; npm publish"])
      expect(publish(masked)).toEqual(["publish"]);
    expect(publish("bun test || true", "npm publish")).toEqual(["publish"]);
    expect(publish("bun test; npm publish")).toEqual([]);
    // Pipeline stages run at once, so a test piped into a publish does not gate it.
    expect(ungatedShippingJobs({ jobs: { publish: job({ steps: [{ run: "bun test | npm publish", shell: "bash" }] }) } }, [])).toEqual(["publish"]);
    // Under -e, a failure anywhere in an && list that more commands follow is ignored, before the tests or after.
    for (const run of ["cd packages/client && bun test; npm publish", "false && bun test; npm publish"]) expect(publish(run)).toEqual(["publish"]);
    expect(publish("cd packages/client && bun test", "npm publish")).toEqual([]);
    // Under -e, a failure inside an && list that more commands follow does not stop the script.
    for (const masked of ["bun test && echo ok; npm publish", "bun test && echo ok\nnpm publish"]) expect(publish(masked)).toEqual(["publish"]);
    expect(publish("bun test && echo ok", "npm publish")).toEqual([]);
    expect(publish("bun test && npm publish\n")).toEqual([]);
    expect(publish("bun run lint && bun run test", "npm publish")).toEqual([]);
    // A custom shell may not stop at the first failure; a single command fails its step in any shell.
    expect(publish({ run: "bun test; echo done", shell: "bash {0}" }, "npm publish")).toEqual(["publish"]);
    expect(publish({ run: "bun test; echo done", shell: "bash" }, "npm publish")).toEqual([]);
    expect(publish({ run: "bun test", shell: "bash {0}" }, "npm publish")).toEqual([]);
    // Anything but plain commands could keep a failed test from failing its step.
    for (const script of [
      "if bun test; then echo ok; fi",
      "! bun test",
      "echo $(bun test)",
      "bun test &",
      "bun test 2>&1",
      "(bun test)",
      "{ bun test; }",
      "while bun test; do break; done",
      "trap 'exit 0' ERR\nbun test",
      "set +o errexit\nbun test",
    ])
      expect(publish(script, "npm publish")).toEqual(["publish"]);
    expect(publish(`cd packages/client\nbun test --filter "$NAME" ${expression("matrix.shard")}; echo done`, "npm publish")).toEqual([]);
  });

  test("resolves each step's shell from job and workflow defaults and the runner", () => {
    const shipping = (workflow: Record<string, unknown>, job: Record<string, unknown> = {}, run = "bun test; echo done") =>
      ungatedShippingJobs({ ...workflow, jobs: { publish: { "runs-on": "ubuntu-latest", ...job, steps: [{ run }, { run: "npm publish" }] } } }, []);
    expect(shipping({})).toEqual([]);
    expect(shipping({ defaults: { run: { shell: "bash {0}" } } })).toEqual(["publish"]);
    expect(shipping({}, { defaults: { run: { shell: "bash {0}" } } })).toEqual(["publish"]);
    expect(shipping({ defaults: { run: { shell: "bash {0}" } } }, { defaults: { run: { shell: "bash" } } })).toEqual([]);
    expect(shipping({}, { "runs-on": "windows-latest" })).toEqual(["publish"]);
    expect(shipping({}, { "runs-on": "windows-latest" }, "bun test")).toEqual([]);
    expect(shipping({}, { "runs-on": "windows-latest", defaults: { run: { shell: "bash" } } })).toEqual([]);
    // A runner given by an expression may be Windows.
    expect(shipping({}, { "runs-on": expression("matrix.os") })).toEqual(["publish"]);
    expect(shipping({}, { "runs-on": [expression("matrix.os")] }, "bun test")).toEqual([]);
    expect(shipping({ defaults: { run: { shell: "bash" } } }, { "runs-on": expression("matrix.os") })).toEqual([]);
  });

  test("finds validation only where a command starts, outside comments and quoted text", () => {
    const publish = (run: string) => ungatedShippingJobs({ jobs: { publish: job({ steps: [{ run }, { run: "npm publish" }] }) } }, []);
    for (const run of ["# bun test", "echo 'bun test'", 'echo "run bun test first"', "echo bun test", "true # then bun test", "bun run build"])
      expect(publish(run)).toEqual(["publish"]);
    for (const run of [
      "CI=1 bun test",
      "cd packages/client\nbun test",
      "./gradlew test",
      "npx vitest run",
      "bun test # all suites",
      "bun run test:unit",
      "pytest",
    ])
      expect(publish(run)).toEqual([]);
    expect(ungatedShippingJobs({ jobs: { publish: job({ steps: [{ run: "# bun test\nnpm publish" }] }) } }, [])).toEqual(["publish"]);
    // Compiling tests is not running them.
    expect(publish("./gradlew testClasses")).toEqual(["publish"]);
    for (const run of ["./gradlew testDebugUnitTest", "./gradlew :app:test", "./gradlew check"]) expect(publish(run)).toEqual([]);
    // A runner's task list ends with its command.
    const own = (run: string) => ungatedShippingJobs({ jobs: { publish: job({ steps: [{ run }] }) } }, []);
    expect(own("./gradlew assemble && ./gradlew publish && ./gradlew test")).toEqual(["publish"]);
    expect(own("xcodebuild build; npm publish; xcodebuild test")).toEqual(["publish"]);
    expect(own("./gradlew assemble test && ./gradlew publish")).toEqual([]);
    // A line continuation joins lines into one command, as the shell reads them.
    expect(publish("echo \\\nbun test")).toEqual(["publish"]);
    expect(publish("bun test \\\n  --coverage")).toEqual([]);
    expect(ungatedShippingJobs({ jobs: { publish: job({ steps: [{ run: "echo \\\nbun test\nnpm publish" }] }) } }, [])).toEqual(["publish"]);
  });

  test("finds shipping in the command a step runs, not in its arguments", () => {
    const ships = (...runs: Array<string | Record<string, unknown>>) =>
      ungatedShippingJobs({ jobs: { publish: job({ steps: runs.map(run => (typeof run === "string" ? { run } : run)) }) } }, []);
    for (const neutral of [
      "cargo build --release",
      "echo Preparing release",
      "cd packages/release",
      "bun run agent-tool runs list",
      // A package manager's run names only its script, and installing a package publishes nothing.
      "bun run build --outdir dist/release",
      "npm install semantic-release",
      "bun add -d release-it",
    ])
      expect(ships(neutral, "bun test", "npm publish")).toEqual([]);
    for (const shipping of [
      "npm publish",
      "npx wrangler deploy",
      "bun run deploy",
      "NODE_ENV=production bun run release:prod",
      "bash scripts/release/publishNpmPackage.sh client",
      "gh release create v1",
      // Quoting a command does not hide what it runs.
      'bash "scripts/publish.sh"',
      "'npm' publish",
      'npm "publish"',
      { uses: "softprops/action-gh-release@v2" },
      { uses: "cloudflare/wrangler-action@v3", with: { command: "deploy" } },
    ])
      expect(ships(shipping, "bun test")).toEqual(["publish"]);
    expect(ships({ uses: "actions-rs/cargo@v1", with: { command: "build", args: "--release" } }, "bun test", "npm publish")).toEqual([]);
    // Options can come before the subcommand.
    for (const shipping of [
      "npm --prefix web publish",
      "npm --prefix web --workspace client publish",
      "bun --cwd web run deploy",
      "pnpm -C packages/client publish --no-git-checks",
    ])
      expect(ships(shipping, "bun test")).toEqual(["publish"]);
    // Only command inputs name what an action runs.
    expect(ships({ uses: "actions/download-artifact@v4", with: { name: "release-bundle", path: "dist/release" } }, "bun test", "npm publish")).toEqual([]);
    // Shipping words in comments or quoted text are not shipping.
    expect(
      ungatedShippingJobs({ jobs: { publish: job({ steps: [{ run: "echo 'Preparing release'" }, { run: "bun test" }, { run: "npm publish" }] }) } }, []),
    ).toEqual([]);
  });

  test("reads conditions as a push to the default branch evaluates them", () => {
    const publish = (testIf: unknown, branch = "main", extra: Record<string, unknown> = {}) =>
      ungatedShippingJobs({ jobs: { publish: job({ ...extra, steps: [{ run: "bun test", if: testIf }, { run: "npm publish" }] }) } }, [], branch);
    // Validation that a push to main never runs does not gate the publish.
    for (const condition of [
      "github.event_name == 'pull_request'",
      "github.event_name != 'push'",
      "github.ref == 'refs/heads/develop'",
      "github.ref_name != 'main'",
      "github.event_name == 'pull_request' || github.event_name == 'schedule'",
      expression("github.event_name == 'workflow_dispatch' && inputs.full"),
      "github.event_name == 'pull_request' && (vars.A || vars.B)",
      "(github.event_name == 'pull_request' || github.ref == 'refs/heads/dev') && contains(github.ref, ')')",
      "github.event_name == 'push' && false",
    ])
      expect(publish(condition)).toEqual(["publish"]);
    // Conditions a push to main can satisfy, or that cannot be read, are trusted.
    for (const condition of [
      "github.event_name == 'push'",
      "github.ref == 'refs/heads/main'",
      "github.event_name == 'pull_request' || inputs.full",
      "!(github.event_name == 'pull_request')",
      "steps.version.outputs.publish == 'true'",
      "(github.event_name == 'pull_request' || vars.A) && vars.B",
      "contains(github.ref, 'main') || github.event_name == 'pull_request'",
      "github.event_name == 'pull_request')",
      // GitHub compares strings without regard to case.
      "github.event_name == 'PUSH'",
      "github.ref == 'refs/heads/MAIN'",
      "github.ref_name != 'Develop'",
    ])
      expect(publish(condition)).toEqual([]);
    expect(publish("github.ref_name == 'release'", "release")).toEqual([]);
    // A shipping job or step that a push to main never runs needs nothing.
    expect(publish("false", "main", { if: "github.event_name == 'workflow_dispatch'" })).toEqual([]);
    const step = ungatedShippingJobs({ jobs: { publish: job({ steps: [{ run: "npm publish", if: "github.event_name == 'release'" }] }) } }, []);
    expect(step).toEqual([]);
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
