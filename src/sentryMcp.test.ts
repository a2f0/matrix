import { beforeEach, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import path from "node:path";
import { ROOT } from "./cli";
import { tempDir } from "./testFixtures";

const SOURCE = path.join(ROOT, "scripts", "sentry");
const TRUSTED_PATH_LINE = /^TRUSTED_PATH=.*$/m;
const TOKEN = "sntryu_fixture-dummy-token";
const TOOLS = ["dirname", "sed", "tail", "id", "env", "grep", "sort"];
let temporary: string, matrix: string, script: string, secrets: string, bin: string, checkout: string;

interface Launch { status: number | null; stdout: string; stderr: string }

/** Executes a copy of the launcher (through its shebang) whose trusted PATH holds only fixture tools and a stub `npx`. */
function launch(env: Record<string, string> = {}, ...args: string[]): Launch {
  const result = spawnSync(script, args, {
    cwd: checkout,
    env: { HOME: checkout, PATH: bin, MATRIX_SECRETS_DIR: secrets, ...env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function writeRootEnv(contents: string) {
  writeFileSync(path.join(secrets, "root", "root.env"), contents, { mode: 0o600 });
}

function writeExecutable(file: string, lines: string[]) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${lines.join("\n")}\n`, { mode: 0o755 });
}

beforeEach(() => {
  temporary = realpathSync(tempDir("matrix-sentry-mcp"));
  matrix = path.join(temporary, "matrix");
  secrets = path.join(temporary, "matrix-secrets");
  bin = path.join(temporary, "trusted-bin");
  checkout = path.join(temporary, "checkout");
  mkdirSync(path.join(matrix, "scripts", "sentry"), { recursive: true });
  mkdirSync(path.join(secrets, "root"), { recursive: true });
  mkdirSync(bin);
  mkdirSync(checkout);
  script = path.join(matrix, "scripts", "sentry", "mcp.sh");
  const source = readFileSync(path.join(SOURCE, "mcp.sh"), "utf8");
  expect(source).toMatch(TRUSTED_PATH_LINE);
  writeFileSync(script, source.replace(TRUSTED_PATH_LINE, `TRUSTED_PATH="${bin}"`), { mode: 0o755 });
  copyFileSync(path.join(SOURCE, "npmrc"), path.join(matrix, "scripts", "sentry", "npmrc"));
  for (const tool of TOOLS) symlinkSync(execFileSync("/bin/sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).trim(), path.join(bin, tool));
  writeExecutable(path.join(bin, "npx"), [
    "#!/bin/bash",
    "printf 'args=%s\\n' \"$*\"",
    "printf 'cwd=%s\\n' \"$(pwd -P)\"",
    "env | sort",
  ]);
  writeFileSync(path.join(checkout, ".npmrc"), "@sentry:registry=https://attacker.invalid/\n");
  writeRootEnv(`SENTRY_AUTH_TOKEN=upload-token\nSENTRY_MCP_AUTH_TOKEN="${TOKEN}"\n`);
});


test("the shipped launcher uses a fixed privileged-mode bash and system tool directories", () => {
  const source = readFileSync(path.join(SOURCE, "mcp.sh"), "utf8");
  expect(source.split("\n")[0]).toBe("#!/bin/bash -p");
  expect(source.match(TRUSTED_PATH_LINE)?.[0]).toBe('TRUSTED_PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"');
  // PATH is replaced before the first external command.
  const firstCommand = source.indexOf("$(");
  expect(source.indexOf('PATH="$TRUSTED_PATH"')).toBeGreaterThan(-1);
  expect(source.indexOf('PATH="$TRUSTED_PATH"')).toBeLessThan(firstCommand);
});

test("runs none of the caller's startup files, functions, or commands", () => {
  const marker = path.join(temporary, "injected");
  const startup = path.join(checkout, "startup.sh");
  writeFileSync(startup, `touch ${marker}\n`);
  const hostile = path.join(checkout, "tools");
  for (const tool of ["sed", "tail", "id", "dirname", "env", "bash"]) writeExecutable(path.join(hostile, tool), ["#!/bin/sh", `touch ${marker}`, "exit 1"]);
  const result = launch({
    PATH: `${hostile}:${bin}`,
    BASH_ENV: startup,
    ENV: startup,
    SHELLOPTS: "xtrace",
    CDPATH: checkout,
    "BASH_FUNC_sed%%": `() { touch ${marker}; }`,
  });
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toContain(`SENTRY_ACCESS_TOKEN=${TOKEN}`);
  expect(() => readFileSync(marker)).toThrow();
});

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
  expect(lines.filter(line => line.startsWith("SENTRY_"))).toEqual([`SENTRY_ACCESS_TOKEN=${TOKEN}`]);
  expect(result.stdout).not.toContain("inherited");
  expect(result.stdout).not.toContain("upload-token");
  const args = lines.find(line => line.startsWith("args="));
  expect(args).toBe("args=-y @sentry/mcp-server@0.42.0 --organization-slug=tearleads");
  expect(args).not.toContain(TOKEN);
});

test("drops every inherited variable that could inject code or configuration", () => {
  const result = launch({
    NODE_OPTIONS: `--require=${checkout}/payload.cjs`,
    NODE_PATH: checkout,
    npm_config_registry: "https://attacker.invalid/",
    NPM_CONFIG_USERCONFIG: path.join(checkout, ".npmrc"),
    BUN_INSTALL: checkout,
    LANG: "en_US.UTF-8",
  });
  expect(result.status).toBe(0);
  // The stub's own bash sets PWD, OLDPWD, SHLVL and _.
  const environment = result.stdout.trim().split("\n").filter(line => !/^(args|cwd|PWD|OLDPWD|SHLVL|_)=/.test(line));
  expect(environment.map(line => line.split("=")[0]).sort()).toEqual(
    ["HOME", "LANG", "PATH", "SENTRY_ACCESS_TOKEN", "npm_config_globalconfig", "npm_config_userconfig"].sort(),
  );
  expect(environment).toContain(`HOME=${userInfo().homedir}`);
  expect(environment).toContain(`PATH=${bin}`);
  expect(environment).toContain("npm_config_globalconfig=/dev/null");
  expect(environment).toContain(`npm_config_userconfig=${path.join(matrix, "scripts", "sentry", "npmrc")}`);
  expect(result.stdout).toContain(`cwd=${matrix}`);
  expect(result.stdout).not.toContain(checkout);
});

test("pins every registry, including the @sentry scope, in its npm user config", () => {
  const settings = readFileSync(path.join(SOURCE, "npmrc"), "utf8").split("\n").filter(line => line && !line.startsWith("#"));
  expect(settings).toEqual(["registry=https://registry.npmjs.org/", "@sentry:registry=https://registry.npmjs.org/"]);
});

test("never runs an npx from the caller's PATH", () => {
  const shadow = path.join(checkout, "node_modules", ".bin");
  writeExecutable(path.join(shadow, "npx"), ["#!/bin/bash", "echo shadowed"]);
  for (const tool of TOOLS) symlinkSync(path.join(bin, tool), path.join(shadow, tool));
  const shadowed = launch({ PATH: `${shadow}:${bin}` });
  expect(shadowed.status).toBe(0);
  expect(shadowed.stdout).not.toContain("shadowed");

  rmSync(path.join(bin, "npx"));
  const missing = launch({ PATH: `${shadow}:${bin}` });
  expect(missing.status).toBe(1);
  expect(missing.stderr).toContain("npx not found");
  expect(missing.stdout).toBe("");
});
