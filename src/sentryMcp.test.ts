import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ROOT } from "./cli";

const SCRIPT = path.join(ROOT, "scripts", "sentry", "mcp.sh");
const TOKEN = "sntryu_fixture-dummy-token";
let temporary: string, secrets: string, bin: string, checkout: string;

interface Launch { status: number | null; stdout: string; stderr: string }

/** Runs the launcher with a stub `npx` that reports what it received. */
function launch(env: Record<string, string> = {}, ...args: string[]): Launch {
  const result = spawnSync("bash", [SCRIPT, ...args], {
    cwd: checkout,
    env: { HOME: temporary, PATH: `${bin}:/usr/bin:/bin`, MATRIX_SECRETS_DIR: secrets, ...env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function writeRootEnv(contents: string) {
  writeFileSync(path.join(secrets, "root", "root.env"), contents, { mode: 0o600 });
}

beforeEach(() => {
  temporary = realpathSync(mkdtempSync(path.join(tmpdir(), "matrix-sentry-mcp-")));
  secrets = path.join(temporary, "matrix-secrets");
  bin = path.join(temporary, "bin");
  checkout = path.join(temporary, "checkout");
  mkdirSync(path.join(secrets, "root"), { recursive: true });
  mkdirSync(bin);
  mkdirSync(checkout);
  writeFileSync(path.join(checkout, ".npmrc"), "@sentry:registry=https://attacker.invalid/\n");
  writeFileSync(path.join(bin, "npx"), [
    "#!/usr/bin/env bash",
    "printf 'args=%s\\n' \"$*\"",
    "printf 'cwd=%s\\n' \"$(pwd -P)\"",
    "env | grep -E '^(SENTRY_|npm_config_|NPM_CONFIG_)' | sort",
    "",
  ].join("\n"), { mode: 0o755 });
  writeRootEnv(`SENTRY_AUTH_TOKEN=upload-token\nSENTRY_MCP_AUTH_TOKEN="${TOKEN}"\n`);
});

afterEach(() => rmSync(temporary, { recursive: true, force: true }));

test("fails without the token and never starts the server", () => {
  writeRootEnv("SENTRY_AUTH_TOKEN=upload-token\n");
  const missing = launch();
  expect(missing.status).toBe(1);
  expect(missing.stderr).toContain("SENTRY_MCP_AUTH_TOKEN is not set");
  expect(missing.stdout).toBe("");
  rmSync(path.join(secrets, "root", "root.env"));
  expect(launch().stderr).toContain("cannot read");
});

test("passes only the workspace token, through the environment", () => {
  const result = launch({ SENTRY_AUTH_TOKEN: "inherited", SENTRY_TOKEN: "inherited", SENTRY_ACCESS_TOKEN: "inherited" }, "--organization-slug=tearleads");
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  const lines = result.stdout.trim().split("\n");
  expect(lines).toContain(`SENTRY_ACCESS_TOKEN=${TOKEN}`);
  expect(result.stdout).not.toContain("inherited");
  expect(result.stdout).not.toContain("upload-token");
  expect(lines.some(line => line.startsWith("SENTRY_AUTH_TOKEN=") || line.startsWith("SENTRY_TOKEN="))).toBe(false);
  const args = lines.find(line => line.startsWith("args="));
  expect(args).toBe("args=-y @sentry/mcp-server@0.42.0 --organization-slug=tearleads");
  expect(args).not.toContain(TOKEN);
});

test("ignores the caller's directory and inherited npm configuration", () => {
  const result = launch({ npm_config_registry: "https://attacker.invalid/", NPM_CONFIG_USERCONFIG: path.join(checkout, ".npmrc") });
  expect(result.status).toBe(0);
  const lines = result.stdout.trim().split("\n");
  expect(lines).toContain(`cwd=${realpathSync(ROOT)}`);
  expect(lines.filter(line => /^(npm_config_|NPM_CONFIG_)/i.test(line))).toEqual([
    "npm_config_globalconfig=/dev/null",
    "npm_config_registry=https://registry.npmjs.org/",
    `npm_config_userconfig=${path.join(realpathSync(ROOT), "scripts", "sentry", "npmrc")}`,
  ]);
});

test("pins every registry, including the @sentry scope, in its npm user config", () => {
  const npmrc = readFileSync(path.join(ROOT, "scripts", "sentry", "npmrc"), "utf8");
  const settings = npmrc.split("\n").filter(line => line && !line.startsWith("#"));
  expect(settings).toEqual(["registry=https://registry.npmjs.org/", "@sentry:registry=https://registry.npmjs.org/"]);
});

test("never runs an npx that the calling checkout puts on PATH", () => {
  for (const directory of [path.join(checkout, "node_modules", ".bin"), path.join(checkout, "tools"), path.join(temporary, "elsewhere", "node_modules", ".bin")]) {
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, "npx"), "#!/usr/bin/env bash\necho shadowed\nenv\n", { mode: 0o755 });
  }
  const shadowed = `${checkout}/node_modules/.bin:${checkout}/tools:${temporary}/elsewhere/node_modules/.bin:node_modules/.bin:.:`;
  const result = launch({ PATH: `${shadowed}${bin}:/usr/bin:/bin` });
  expect(result.status).toBe(0);
  expect(result.stdout).not.toContain("shadowed");
  expect(result.stdout).toContain(`SENTRY_ACCESS_TOKEN=${TOKEN}`);

  rmSync(path.join(bin, "npx"));
  const missing = launch({ PATH: `${shadowed}/usr/bin:/bin` });
  expect(missing.status).toBe(1);
  expect(missing.stderr).toContain("npx is not on a trusted PATH entry");
  expect(missing.stdout).not.toContain(TOKEN);
});
