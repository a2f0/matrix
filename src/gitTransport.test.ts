import { afterEach, beforeEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { effectiveHelpers, helperName, inspectGitTransport, type Runner, sshEndpoint } from "./gitTransport";
import { gitIn, gitInit, tempDir } from "./testFixtures";

let root: string;
const saved: Record<string, string | undefined> = {};
const ISOLATION = ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM", "HOME"];

/** A repository whose only Git configuration is its own: no system or global files. */
beforeEach(() => {
  root = tempDir("matrix-git-transport");
  for (const name of ISOLATION) saved[name] = process.env[name];
  process.env.GIT_CONFIG_GLOBAL = path.join(root, "global");
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  process.env.HOME = root;
  writeFileSync(process.env.GIT_CONFIG_GLOBAL, "");
  gitInit(root);
});
afterEach(() => {
  for (const name of ISOLATION) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

function config(...pairs: Array<[string, string]>): void {
  for (const [key, value] of pairs) gitIn(root, "config", "--add", key, value);
}

const record = (key: string, value: string) => `${key}\n${value}\0`;

test("folds credential helpers the way Git does, for https://github.com only", () => {
  expect(effectiveHelpers(record("credential.helper", "osxkeychain"))).toEqual(["osxkeychain"]);
  // The Xcode system helper, cleared by an empty helper scoped to GitHub.
  expect(effectiveHelpers(record("credential.helper", "osxkeychain") + record("credential.https://github.com.helper", ""))).toEqual([]);
  expect(effectiveHelpers(record("credential.helper", "osxkeychain") + record("credential.https://github.com/.helper", ""))).toEqual([]);
  // A later helper comes back after the reset.
  expect(effectiveHelpers(record("credential.helper", "") + record("credential.helper", "store"))).toEqual(["store"]);
  // Other hosts and protocols do not apply.
  expect(effectiveHelpers(record("credential.https://gitlab.com.helper", "store") + record("credential.http://github.com.helper", "store"))).toEqual([]);
  // A path or user narrows a pattern: its helper may still run, but its reset does not clear the rest.
  expect(effectiveHelpers(record("credential.helper", "osxkeychain") + record("credential.https://github.com/a2f0.helper", ""))).toEqual(["osxkeychain"]);
  expect(effectiveHelpers(record("credential.https://github.com/a2f0.helper", "store"))).toEqual(["store"]);
  expect(effectiveHelpers(record("credential.https://*.com.helper", "store"))).toEqual(["store"]);
  expect(effectiveHelpers(record("Credential.Helper", "osxkeychain"))).toEqual(["osxkeychain"]);
});

test("names helpers without their arguments, which can carry tokens", () => {
  expect(helperName("osxkeychain")).toBe("osxkeychain");
  expect(helperName("store --file /secret/path")).toBe("store");
  expect(helperName("/usr/local/bin/git-credential-manager get")).toBe("git-credential-manager");
  expect(helperName("!/opt/homebrew/bin/gh auth git-credential")).toBe("an inline shell helper");
  expect(helperName("!GH_TOKEN=ghp_secret gh auth git-credential")).toBe("an inline shell helper");
  expect(helperName("GH_TOKEN=ghp_secret")).toBe("a helper with an unusual name");
});

test("reports helpers by name only", () => {
  config(["credential.helper", "!f() { echo password=ghp_secret; }; f"]);
  const result = inspectGitTransport(root, fakeRunner("ssh", "hostname ssh.github.com\nport 443\n"));
  expect(result.credentialHelpers).toEqual(["an inline shell helper"]);
  expect(JSON.stringify(result)).not.toContain("ghp_secret");
});

test("reads the host and port from ssh -G output", () => {
  expect(sshEndpoint("user git\nhostname ssh.github.com\nport 443\n")).toEqual({ hostname: "ssh.github.com", port: 443 });
  expect(sshEndpoint("user git\n")).toBeUndefined();
});

/** gh answers with `protocol`; ssh -G answers from a fake config. */
function fakeRunner(protocol: string | null, ssh: string, calls: string[][] = []): Runner {
  return (command, args) => {
    calls.push([command, ...args]);
    if (command === "gh") {
      if (protocol === null) return { status: null, stdout: "", stderr: "", error: Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" }) };
      return { status: 0, stdout: `${protocol}\n`, stderr: "" };
    }
    return { status: 0, stdout: ssh, stderr: "" };
  };
}

test("passes SSH through port 443 with no helper and gh on SSH", () => {
  config(["credential.helper", "osxkeychain"], ["credential.https://github.com.helper", ""], ["core.sshCommand", "ssh -F ~/.config/git/ssh_config"]);
  const calls: string[][] = [];
  const result = inspectGitTransport(root, fakeRunner("ssh", "hostname ssh.github.com\nport 443\n", calls));
  expect(result).toEqual({ ghProtocol: "ssh", credentialHelpers: [], ssh: { hostname: "ssh.github.com", port: 443 }, problems: [] });
  // A configured command runs through the shell with Git's arguments appended.
  expect(calls[1]).toEqual(["sh", "-c", "ssh -F ~/.config/git/ssh_config \"$@\"", "ssh -F ~/.config/git/ssh_config", "-G", "git@github.com"]);
});

test("reports each way Git or gh can leave SSH", () => {
  config(["credential.helper", "osxkeychain"]);
  const calls: string[][] = [];
  const result = inspectGitTransport(root, fakeRunner("https", "hostname github.com\nport 22\n", calls));
  expect(calls[1]).toEqual(["ssh", "-G", "git@github.com"]);
  expect(result.ghProtocol).toBe("https");
  expect(result.credentialHelpers).toEqual(["osxkeychain"]);
  expect(result.problems).toEqual([
    "gh uses https for github.com, so `gh repo clone` and `gh pr checkout` use HTTPS; run `gh config set git_protocol ssh --host github.com`, which overrides the global setting",
    "Git would ask `osxkeychain` for https://github.com credentials, which can wait on a keychain prompt; set an empty `credential.https://github.com.helper`, as dotfiles' gitconfig does",
    "Git's SSH reaches github.com at github.com:22, which fails where port 22 is blocked; send it to ssh.github.com:443, as dotfiles' Git SSH config does",
  ]);
});

test("skips gh when it is not installed and reports an SSH command that cannot resolve", () => {
  const result = inspectGitTransport(root, (command, args) => (command === "gh" ? fakeRunner(null, "")(command, args) : { status: 255, stdout: "", stderr: "ssh: Could not resolve" }));
  expect(result.ghProtocol).toBeNull();
  expect(result.ssh).toEqual({ error: "`-G` through Git's ssh exited 255" });
  expect(result.problems).toEqual(["Could not resolve Git's SSH endpoint for github.com: `-G` through Git's ssh exited 255"]);
});

test("never reports the SSH command or its output, which can carry credentials", () => {
  config(["core.sshCommand", "ssh -o ProxyCommand='connect -H user:proxy_secret@proxy %h %p'"]);
  const result = inspectGitTransport(root, (command, args) => {
    if (command === "gh") return { status: 0, stdout: "ssh\n", stderr: "" };
    const run = Bun.spawnSync(["sh", "-c", "echo 'proxy_secret rejected' >&2; exit 255"]);
    void args;
    return { status: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString() };
  });
  expect(result.ssh).toEqual({ error: "`-G` through Git's configured core.sshCommand exited 255" });
  expect(JSON.stringify(result)).not.toContain("proxy_secret");
  const missing = inspectGitTransport(root, command => (command === "gh" ? { status: 0, stdout: "ssh\n", stderr: "" } : { status: null, stdout: "", stderr: "", error: Object.assign(new Error("spawn sh ENOENT with proxy_secret"), { code: "ENOENT" }) }));
  expect(missing.ssh).toEqual({ error: "`-G` through Git's configured core.sshCommand could not start (ENOENT)" });
});

test("runs the real ssh -G against a Git-only SSH config", () => {
  const sshConfig = path.join(root, "ssh_config");
  writeFileSync(sshConfig, "Host github.com\n  HostName ssh.github.com\n  Port 443\n");
  config(["core.sshCommand", `ssh -F '${sshConfig}'`]);
  const result = inspectGitTransport(root, (command, args) => {
    if (command === "gh") return { status: 0, stdout: "ssh\n", stderr: "" };
    const run = Bun.spawnSync([command, ...args]);
    return { status: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString() };
  });
  expect(result.ssh).toEqual({ hostname: "ssh.github.com", port: 443 });
  expect(result.problems).toEqual([]);
});
