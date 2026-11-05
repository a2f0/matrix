import { spawnSync } from "node:child_process";
import { git } from "./git";

/**
 * How this machine's Git and gh reach GitHub. Agents must use SSH only: an
 * HTTPS fallback reaches macOS's keychain credential helper, whose prompt
 * blocks a background agent indefinitely (a2f0/matrix#61).
 */
export interface GitTransport {
  /** gh's `git_protocol` for github.com, or null when gh is not installed. */
  readonly ghProtocol: string | null;
  /** Credential helpers Git would ask for https://github.com, in order, by program name only (see `helperName`). */
  readonly credentialHelpers: string[];
  /** Where Git's SSH command connects for github.com, or why that is unknown (never the command or its output). */
  readonly ssh: { readonly hostname: string; readonly port: number } | { readonly error: string };
  /** Each way the setup can still leave SSH; empty when it cannot. */
  readonly problems: string[];
}

interface Run { readonly status: number | null; readonly stdout: string; readonly stderr: string; readonly error?: Error }

/** What the inspection runs; tests replace it. */
export type Runner = (command: string, args: string[]) => Run;

/** The SSH endpoint that keeps working where port 22 is blocked. */
export const SSH_OVER_HTTPS = { hostname: "ssh.github.com", port: 443 } as const;

const runner: Runner = (command, args) => {
  const result = spawnSync(command, args, { encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" }, timeout: 30_000 });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", ...(result.error && { error: result.error }) };
};

const GITHUB = "github.com";

/**
 * Whether `credential.<pattern>.helper` can apply to https://github.com.
 * A pattern with a path or user matches only such requests, so a reset there
 * does not clear the helpers (`exact` false) while a helper there may still run.
 */
function patternScope(pattern: string): { applies: boolean; exact: boolean } {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(pattern);
  let url: URL;
  try { url = new URL(withScheme ? pattern : `https://${pattern}`); } catch { return { applies: true, exact: false }; }
  if (withScheme && url.protocol !== "https:") return { applies: false, exact: false };
  const host = url.hostname.toLowerCase();
  // Git matches a host label by label, and `*` matches one label.
  const labels = GITHUB.split(".");
  const hostMatches = host.split(".").length === labels.length && host.split(".").every((label, index) => label === "*" || label === labels[index]);
  if (!hostMatches || (url.port !== "" && url.port !== "443")) return { applies: false, exact: false };
  const exact = withScheme && url.username === "" && (url.pathname === "" || url.pathname === "/");
  return { applies: true, exact };
}

/**
 * A helper's program name without its arguments, which can carry tokens:
 * `store --file ~/x` is `store`, `/usr/local/bin/helper get` is `helper`.
 * An inline `!` helper is shell code that can start with an assignment
 * (`!GH_TOKEN=... gh auth git-credential`), so none of it is shown.
 */
export function helperName(helper: string): string {
  if (helper.startsWith("!")) return "an inline shell helper";
  const program = helper.trim().split(/\s+/)[0]!.split("/").at(-1)!;
  return /^[A-Za-z0-9._-]+$/.test(program) ? program : "a helper with an unusual name";
}

/**
 * Fold `credential.helper` entries in the order Git reads them: each value
 * appends a helper and an empty value clears the list. Config comes from
 * `git config --null --get-regexp`, NUL-terminated `key\nvalue` records.
 */
export function effectiveHelpers(config: string): string[] {
  let helpers: string[] = [];
  for (const record of config.split("\0").filter(Boolean)) {
    const newline = record.indexOf("\n");
    const key = newline === -1 ? record : record.slice(0, newline);
    const value = newline === -1 ? "" : record.slice(newline + 1);
    const lower = key.toLowerCase();
    if (!lower.startsWith("credential.") || !lower.endsWith(".helper")) continue;
    const pattern = key.slice("credential.".length, -".helper".length);
    const scope = pattern === "" ? { applies: true, exact: true } : patternScope(pattern);
    if (!scope.applies) continue;
    if (value !== "") helpers.push(value);
    else if (scope.exact) helpers = [];
  }
  return helpers;
}

/**
 * The command Git runs for SSH from configuration. The machine's setup is
 * what matters, so a session's GIT_SSH_COMMAND or GIT_SSH is not consulted.
 */
function sshCommand(root: string): { command: string; shell: boolean } {
  const configured = git(root, ["config", "--get", "core.sshCommand"]);
  if (configured.status === 0 && configured.stdout !== "") return { command: configured.stdout, shell: true };
  return { command: "ssh", shell: false };
}

/** Parse `ssh -G` output for the host and port it would connect to. */
export function sshEndpoint(output: string): { hostname: string; port: number } | undefined {
  const value = (name: string) => new RegExp(`^${name} (\\S+)$`, "m").exec(output)?.[1];
  const hostname = value("hostname");
  const port = Number(value("port"));
  return hostname && Number.isInteger(port) ? { hostname: hostname.toLowerCase(), port } : undefined;
}

/** Inspect gh's protocol, Git's credential helpers, and Git's SSH endpoint for GitHub, without connecting. */
export function inspectGitTransport(root: string, run: Runner = runner): GitTransport {
  const problems: string[] = [];

  const gh = run("gh", ["config", "get", "git_protocol", "--host", GITHUB]);
  const ghMissing = (gh.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
  const ghProtocol = ghMissing ? null : gh.status === 0 ? gh.stdout.trim() : "";
  if (ghProtocol !== null && ghProtocol !== "ssh") {
    problems.push(`gh uses ${ghProtocol === "" ? "an unreadable protocol" : ghProtocol} for ${GITHUB}, so \`gh repo clone\` and \`gh pr checkout\` use HTTPS; run \`gh config set git_protocol ssh --host ${GITHUB}\`, which overrides the global setting`);
  }

  const config = git(root, ["config", "--null", "--get-regexp", "^credential\\..*helper$"]);
  if (config.status !== 0 && config.status !== 1) throw new Error(`git config failed: ${config.stderr.trim()}`);
  const credentialHelpers = config.status === 0 ? effectiveHelpers(config.stdout).map(helperName) : [];
  if (credentialHelpers.length > 0) {
    problems.push(`Git would ask ${credentialHelpers.map(helper => (/^[A-Za-z0-9._-]+$/.test(helper) ? `\`${helper}\`` : helper)).join(", ")} for https://${GITHUB} credentials, which can wait on a keychain prompt; set an empty \`credential.https://${GITHUB}.helper\`, as dotfiles' gitconfig does`);
  }

  const { command, shell } = sshCommand(root);
  // Git runs a configured command through the shell with its arguments appended; `-G` prints the resolved config without connecting.
  const resolved = shell ? run("sh", ["-c", `${command} "$@"`, command, "-G", `git@${GITHUB}`]) : run(command, ["-G", `git@${GITHUB}`]);
  const endpoint = resolved.status === 0 ? sshEndpoint(resolved.stdout) : undefined;
  // The command and its stderr can carry credentials (a proxy password, a wrapper token), so neither is reported.
  const failure = resolved.error ? `could not start (${(resolved.error as NodeJS.ErrnoException).code ?? "error"})`
    : resolved.status !== 0 ? `exited ${resolved.status ?? "on a signal"}` : "printed no host and port";
  const ssh = endpoint ?? { error: `\`-G\` through Git's ${shell ? "configured core.sshCommand" : "ssh"} ${failure}` };
  if (!endpoint) problems.push(`Could not resolve Git's SSH endpoint for ${GITHUB}: ${"error" in ssh ? ssh.error : ""}`);
  else if (endpoint.hostname !== SSH_OVER_HTTPS.hostname || endpoint.port !== SSH_OVER_HTTPS.port) {
    problems.push(`Git's SSH reaches ${GITHUB} at ${endpoint.hostname}:${endpoint.port}, which fails where port 22 is blocked; send it to ${SSH_OVER_HTTPS.hostname}:${SSH_OVER_HTTPS.port}, as dotfiles' Git SSH config does`);
  }

  return { ghProtocol, credentialHelpers, ssh, problems };
}
