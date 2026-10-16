import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { deployAll, deploySecrets, dotenvNames, type Gh, runGh, secretsRoot } from "./secrets";

let secrets: string, calls: string[][];
const remote: Record<string, string[]> = { secret: ["DEPLOY_KEY", "LEGACY_TOKEN"], variable: [] };
const gh: Gh = args => {
  calls.push(args);
  return args[1] === "list" ? `${remote[args[0]!]!.join("\n")}\n` : "";
};

function ci(file: string, content: string): string {
  const directory = path.join(secrets, "demo", "ci");
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, file), content);
  return path.join(directory, file);
}

beforeEach(() => {
  secrets = mkdtempSync(path.join(tmpdir(), "matrix-secrets-"));
  calls = [];
});

afterEach(() => rmSync(secrets, { recursive: true, force: true }));

test("reads names in order and skips comments, export prefixes, and quoted multi-line values", () => {
  const source = [
    "# header",
    "",
    "export API_TOKEN=abc # trailing",
    "SSH_KEY=\"-----BEGIN KEY-----",
    "NOT_A_NAME=inside the value \\\" still inside",
    "-----END KEY-----\"",
    "SINGLE='one",
    "two'",
    "  PLAIN = value",
  ].join("\n");
  expect(dotenvNames(source, "ci/secrets.env")).toEqual(["API_TOKEN", "SSH_KEY", "SINGLE", "PLAIN"]);
});

test("treats a quote after a backslash as part of the value, as gh's parser does", () => {
  const source = [
    "SINGLE='it\\'s",
    "HIDDEN_ONE=still inside",
    "done'",
    "DOUBLE=\"ends with a backslash \\\\\"",
    "HIDDEN_TWO=still inside\"",
    "EMPTY=''",
    "LAST=1",
  ].join("\n");
  expect(dotenvNames(source, "f")).toEqual(["SINGLE", "DOUBLE", "EMPTY", "LAST"]);
});

test("rejects lines and names GitHub would refuse", () => {
  expect(() => dotenvNames("just text\n", "f")).toThrow("f:1 is not a NAME=value line.");
  expect(() => dotenvNames("GITHUB_TOKEN=x\n", "f")).toThrow("reserves names");
  expect(() => dotenvNames("A=1\nA=2\n", "f")).toThrow("A is assigned twice");
  expect(() => dotenvNames("TOKEN=1\ntoken=2\n", "f")).toThrow("token is assigned twice");
  expect(() => dotenvNames("A=\"open\n", "f")).toThrow("unterminated quoted value");
  expect(() => dotenvNames("A=\"x\" B=y\n", "f")).toThrow("f:1: A has text after its closing quote.");
  expect(() => dotenvNames("A='one\ntwo' C=3\n", "f")).toThrow("f:2: A has text after its closing quote.");
  expect(dotenvNames("A=\"x\"   # note\nB='y'\n", "f")).toEqual(["A", "B"]);
});

test("plans without changing GitHub and reports settings the files do not name", () => {
  ci("secrets.env", "# comment only\ndeploy_key=value\nNEW_TOKEN=value\n");
  const result = deploySecrets(secrets, "a2f0/demo", false, gh);
  expect(result).toEqual({
    repo: "a2f0/demo",
    path: path.join(secrets, "demo", "ci"),
    secrets: { deploy: ["deploy_key", "NEW_TOKEN"], unmanaged: ["LEGACY_TOKEN"], applied: false },
    variables: { deploy: [], unmanaged: [], applied: false },
  });
  expect(calls.every(args => args[1] === "list")).toBe(true);
});

test("applies each non-empty file through gh without passing values or deleting anything", () => {
  const file = ci("secrets.env", "DEPLOY_KEY=sensitive-value\n");
  ci("variables.env", "# nothing yet\n");
  const result = deploySecrets(secrets, "a2f0/demo", true, gh);
  expect([result.secrets?.applied, result.variables?.applied]).toEqual([true, false]);
  const changes = calls.filter(args => args[1] !== "list");
  expect(changes).toEqual([["secret", "set", "--repo", "a2f0/demo", "--env-file", file]]);
  expect(JSON.stringify(calls)).not.toContain("sensitive-value");
});

test("records a failing repository and keeps the others' results", () => {
  ci("secrets.env", "BROKEN\n");
  const { ok, results } = deployAll(secrets, ["a2f0/demo", "a2f0/other"], false, gh);
  expect(ok).toBe(false);
  expect(results[0]).toEqual({ repo: "a2f0/demo", error: `${path.join(secrets, "demo", "ci", "secrets.env")}:1 is not a NAME=value line.` });
  expect(results[1]).toMatchObject({ repo: "a2f0/other", skipped: "no ci folder" });
});

test("reports what a partly failed apply already set", () => {
  ci("secrets.env", "DEPLOY_KEY=value\n");
  ci("variables.env", "REGION=value\n");
  const failing: Gh = args => {
    if (args[0] === "variable" && args[1] === "set") throw new Error("gh variable set failed (exit 1).");
    return gh(args);
  };
  const result = deploySecrets(secrets, "a2f0/demo", true, failing);
  expect(result.secrets?.applied).toBe(true);
  expect(result.variables?.applied).toBe(false);
  expect(result.error).toBe("gh variable set failed (exit 1).");
  expect(deployAll(secrets, ["a2f0/demo"], true, failing).ok).toBe(false);
});

test("skips repositories without a ci folder", () => {
  expect(deploySecrets(secrets, "a2f0/other", true, gh)).toEqual({
    repo: "a2f0/other", path: path.join(secrets, "other", "ci"), skipped: "no ci folder",
  });
  expect(calls).toEqual([]);
});

test("locates matrix-secrets beside the repository unless overridden", () => {
  expect(secretsRoot("/work/matrix", {})).toBe("/work/matrix-secrets");
  expect(secretsRoot("/work/matrix", { MATRIX_SECRETS_DIR: "/vault/secrets" })).toBe("/vault/secrets");
});

test("withholds gh output when a set fails, but keeps it for listings", () => {
  const bin = path.join(secrets, "bin");
  mkdirSync(bin);
  writeFileSync(path.join(bin, "gh"), "#!/bin/sh\necho 'parse error near sensitive-value' >&2\nexit 1\n");
  chmodSync(path.join(bin, "gh"), 0o755);
  const saved = process.env.PATH;
  process.env.PATH = `${bin}:${saved}`;
  try {
    expect(() => runGh(["secret", "set", "--repo", "a2f0/demo", "--env-file", "ci/secrets.env"])).toThrow("output withheld");
    expect(() => runGh(["secret", "set"])).not.toThrow("sensitive-value");
    expect(() => runGh(["secret", "list"])).toThrow("parse error near sensitive-value");
  } finally {
    process.env.PATH = saved;
  }
});
