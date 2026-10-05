import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkoutStatus, syncRepo, unmanagedCheckouts } from "./checkouts";

const REPO = "a2f0/demo";
let temporary: string, root: string, seed: string, remote: string, checkout: string;

function run(cwd: string, ...args: string[]): string {
  const identity = ["-c", "commit.gpgsign=false", "-c", "user.name=Matrix Test", "-c", "user.email=matrix@example.com"];
  return execFileSync("git", [...identity, ...args], { cwd, encoding: "utf8", stdio: "pipe" }).trim();
}

function commit(cwd: string, file: string, content: string): string {
  writeFileSync(path.join(cwd, file), content);
  run(cwd, "add", file);
  run(cwd, "commit", "-q", "-m", `update ${file}`);
  return run(cwd, "rev-parse", "HEAD");
}

function publish(content: string): string {
  const head = commit(seed, "README.md", content);
  run(seed, "push", "-q", remote, "HEAD");
  return head;
}

function setup(branch: string): void {
  temporary = mkdtempSync(path.join(tmpdir(), "matrix-test-"));
  root = path.join(temporary, "matrix");
  seed = path.join(temporary, "seed");
  remote = path.join(temporary, "remote.git");
  checkout = path.join(root, "checkouts", "demo");
  mkdirSync(root);
  mkdirSync(seed);
  run(seed, "init", "-q", "-b", branch);
  commit(seed, "README.md", "one\n");
  run(temporary, "clone", "-q", "--bare", seed, remote);
}

afterEach(() => rmSync(temporary, { recursive: true, force: true }));

describe("syncRepo", () => {
  beforeEach(() => setup("main"));

  test("clones a missing checkout, then reports it current", () => {
    expect(syncRepo(root, REPO, remote)).toMatchObject({ action: "cloned", path: "checkouts/demo", branch: "main", defaultBranch: "main" });
    expect(syncRepo(root, REPO, remote)).toMatchObject({ action: "current" });
  });

  test("fast-forwards a clean default branch", () => {
    syncRepo(root, REPO, remote);
    const head = publish("two\n");
    expect(syncRepo(root, REPO, remote)).toMatchObject({ action: "updated", head });
    expect(readFileSync(path.join(checkout, "README.md"), "utf8")).toBe("two\n");
  });

  test("fetches but preserves dirty checkouts and feature branches", () => {
    syncRepo(root, REPO, remote);
    writeFileSync(path.join(checkout, "notes.txt"), "keep me\n");
    let head = publish("two\n");
    expect(syncRepo(root, REPO, remote)).toMatchObject({ action: "skipped", reason: "uncommitted changes" });
    expect(run(checkout, "rev-parse", "origin/main")).toBe(head);
    expect(readFileSync(path.join(checkout, "notes.txt"), "utf8")).toBe("keep me\n");

    rmSync(path.join(checkout, "notes.txt"));
    run(checkout, "switch", "-q", "-c", "sweep/topic");
    head = publish("three\n");
    expect(syncRepo(root, REPO, remote)).toMatchObject({ action: "skipped", reason: "on branch sweep/topic" });
    expect(run(checkout, "rev-parse", "origin/main")).toBe(head);
  });

  test("never replaces local default-branch commits", () => {
    syncRepo(root, REPO, remote);
    const local = commit(checkout, "local.txt", "local\n");
    expect(syncRepo(root, REPO, remote)).toMatchObject({ action: "skipped", reason: "local main has unpushed commits" });
    publish("two\n");
    expect(syncRepo(root, REPO, remote)).toMatchObject({ action: "skipped", reason: "local main has diverged from origin" });
    expect(run(checkout, "rev-parse", "HEAD")).toBe(local);
  });

  test("rejects checkouts that are not the managed repository", () => {
    mkdirSync(checkout, { recursive: true });
    expect(syncRepo(root, REPO, remote)).toMatchObject({ action: "error", reason: "not a separate Git checkout" });
    rmSync(checkout, { recursive: true });
    syncRepo(root, REPO, remote);
    run(checkout, "remote", "set-url", "origin", "git@github.com:a2f0/other.git");
    expect(syncRepo(root, REPO, remote)).toMatchObject({ action: "error", reason: "origin is a2f0/other, expected a2f0/demo" });
  });

  test("never reports credentials embedded in a mismatched origin", () => {
    syncRepo(root, REPO, remote);
    run(checkout, "remote", "set-url", "origin", "https://user:secret@github.com/a2f0/other.git");
    expect(syncRepo(root, REPO, remote)).toMatchObject({ reason: "origin is a2f0/other, expected a2f0/demo" });
    run(checkout, "remote", "set-url", "origin", "https://user:secret@example.com/demo.git");
    expect(checkoutStatus(root, REPO, remote)).toMatchObject({ error: "origin is https://example.com/demo.git, expected a2f0/demo" });
    run(checkout, "remote", "set-url", "origin", "https://github.com/a2f0/other.git?access_token=secret#secret");
    expect(checkoutStatus(root, REPO, remote)).toMatchObject({ error: "origin is https://github.com/a2f0/other.git, expected a2f0/demo" });
  });

  test("refuses to overwrite ignored local files that upstream starts tracking", () => {
    commit(seed, ".gitignore", "local.env\n");
    run(seed, "push", "-q", remote, "HEAD");
    syncRepo(root, REPO, remote);
    writeFileSync(path.join(checkout, "local.env"), "secret\n");
    const head = run(checkout, "rev-parse", "HEAD");
    writeFileSync(path.join(seed, "local.env"), "upstream\n");
    run(seed, "add", "-f", "local.env");
    run(seed, "commit", "-q", "-m", "track local.env");
    run(seed, "push", "-q", remote, "HEAD");
    expect(syncRepo(root, REPO, remote)).toMatchObject({ action: "error" });
    expect(readFileSync(path.join(checkout, "local.env"), "utf8")).toBe("secret\n");
    expect(run(checkout, "rev-parse", "HEAD")).toBe(head);
  });

  test("runs no checkout hooks or fsmonitor that plain Git would run", () => {
    syncRepo(root, REPO, remote);
    const marker = path.join(temporary, "ran.log");
    mkdirSync(path.join(checkout, ".git", "hooks"), { recursive: true });
    writeFileSync(path.join(checkout, ".git", "hooks", "post-merge"), `#!/bin/sh\necho post-merge >> "${marker}"\n`, { mode: 0o755 });
    const fsmonitor = path.join(temporary, "fsmonitor");
    writeFileSync(fsmonitor, `#!/bin/sh\necho fsmonitor >> "${marker}"\nexit 1\n`, { mode: 0o755 });
    run(checkout, "config", "core.fsmonitor", fsmonitor);
    publish("two\n");
    expect(syncRepo(root, REPO, remote)).toMatchObject({ action: "updated" });
    expect(checkoutStatus(root, REPO, remote)).toMatchObject({ ready: true });
    expect(existsSync(marker)).toBe(false);

    publish("three\n");
    run(checkout, "fetch", "-q", "origin");
    run(checkout, "merge", "-q", "--ff-only", "origin/main");
    run(checkout, "status", "--porcelain");
    expect(readFileSync(marker, "utf8")).toContain("post-merge");
    expect(readFileSync(marker, "utf8")).toContain("fsmonitor");
  });

  test("refuses symlinked checkouts that could reach clones outside the workspace", () => {
    const external = path.join(temporary, "external");
    run(temporary, "clone", "-q", remote, external);
    const head = run(external, "rev-parse", "HEAD");
    publish("two\n");
    const refused = { action: "error", reason: "checkouts/demo is a symlink; checkouts must be clones inside the workspace" };

    mkdirSync(path.join(root, "checkouts"));
    symlinkSync(external, checkout);
    expect(syncRepo(root, REPO, remote)).toMatchObject(refused);
    expect(checkoutStatus(root, REPO, remote)).toMatchObject({ present: true, ready: false, error: refused.reason });
    rmSync(checkout);
    symlinkSync(path.join(temporary, "missing"), checkout);
    expect(syncRepo(root, REPO, remote)).toMatchObject(refused);
    rmSync(checkout);

    rmSync(path.join(root, "checkouts"), { recursive: true });
    mkdirSync(path.join(temporary, "elsewhere"));
    symlinkSync(external, path.join(temporary, "elsewhere", "demo"));
    symlinkSync(path.join(temporary, "elsewhere"), path.join(root, "checkouts"));
    expect(syncRepo(root, REPO, remote)).toMatchObject({ action: "error", reason: "checkouts is a symlink; checkouts must be clones inside the workspace" });
    expect(run(external, "rev-parse", "HEAD")).toBe(head);
  });

  test("refuses worktrees and linked Git directories of clones outside the workspace", () => {
    const external = path.join(temporary, "external");
    run(temporary, "clone", "-q", remote, external);
    const head = run(external, "rev-parse", "HEAD");
    publish("two\n");
    const refused = { action: "error", reason: "not a standalone clone with its own .git directory" };

    run(external, "worktree", "add", "-q", "--detach", checkout);
    expect(syncRepo(root, REPO, remote)).toMatchObject(refused);
    run(external, "worktree", "remove", "--force", checkout);

    mkdirSync(checkout, { recursive: true });
    symlinkSync(path.join(external, ".git"), path.join(checkout, ".git"));
    expect(syncRepo(root, REPO, remote)).toMatchObject(refused);
    expect(checkoutStatus(root, REPO, remote)).toMatchObject({ ready: false, error: refused.reason });
    expect(run(external, "rev-parse", "main")).toBe(head);
    expect(run(external, "rev-parse", "origin/main")).toBe(head);
  });

  test("names the remote origin regardless of clone.defaultRemoteName", () => {
    const saved = { ...process.env };
    Object.assign(process.env, { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "clone.defaultRemoteName", GIT_CONFIG_VALUE_0: "upstream" });
    try {
      expect(syncRepo(root, REPO, remote)).toMatchObject({ action: "cloned", defaultBranch: "main" });
    } finally {
      for (const key of ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"]) {
        if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
      }
    }
    expect(run(checkout, "remote")).toBe("origin");
  });

  test("reports a clone failure as an error", () => {
    expect(syncRepo(root, REPO, path.join(temporary, "missing.git"))).toMatchObject({ action: "error" });
  });
});

describe("non-main default branches", () => {
  beforeEach(() => setup("production"));

  test("syncs and reports origin's default branch", () => {
    expect(syncRepo(root, REPO, remote)).toMatchObject({ action: "cloned", branch: "production", defaultBranch: "production" });
    expect(checkoutStatus(root, REPO, remote)).toMatchObject({ ready: true, defaultBranch: "production" });
  });
});

describe("checkoutStatus", () => {
  beforeEach(() => setup("main"));

  test("reports missing, ready, changed, and stale checkouts", () => {
    expect(checkoutStatus(root, REPO, remote)).toEqual({ repo: REPO, path: "checkouts/demo", present: false, ready: false });
    syncRepo(root, REPO, remote);
    expect(checkoutStatus(root, REPO, remote)).toMatchObject({ present: true, ready: true, branch: "main", changes: 0, ahead: 0, behind: 0 });

    writeFileSync(path.join(checkout, "README.md"), "edited\n");
    expect(checkoutStatus(root, REPO, remote)).toMatchObject({ ready: false, changes: 1 });
    run(checkout, "checkout", "-q", "--", "README.md");

    run(checkout, "switch", "-q", "-c", "sweep/topic");
    commit(checkout, "change.txt", "change\n");
    expect(checkoutStatus(root, REPO, remote)).toMatchObject({ ready: false, branch: "sweep/topic", ahead: 1, behind: 0 });
    run(checkout, "switch", "-q", "main");

    publish("two\n");
    run(checkout, "fetch", "-q", "origin");
    expect(checkoutStatus(root, REPO, remote)).toMatchObject({ ready: false, behind: 1 });
  });

  test("counts untracked files even when Git is configured to hide them", () => {
    syncRepo(root, REPO, remote);
    run(checkout, "config", "status.showUntrackedFiles", "no");
    writeFileSync(path.join(checkout, "draft.txt"), "draft\n");
    expect(run(checkout, "status", "--porcelain")).toBe("");
    expect(checkoutStatus(root, REPO, remote)).toMatchObject({ ready: false, changes: 1 });
    expect(syncRepo(root, REPO, remote)).toMatchObject({ action: "skipped", reason: "uncommitted changes" });
  });

  test("counts dirty submodules even when Git is configured to ignore them", () => {
    const library = path.join(temporary, "library");
    mkdirSync(library);
    run(library, "init", "-q", "-b", "main");
    commit(library, "lib.txt", "lib\n");
    run(seed, "-c", "protocol.file.allow=always", "submodule", "add", "-q", library, "lib");
    run(seed, "commit", "-q", "-m", "add submodule");
    run(seed, "push", "-q", remote, "HEAD");
    syncRepo(root, REPO, remote);
    run(checkout, "-c", "protocol.file.allow=always", "submodule", "update", "-q", "--init");
    run(checkout, "config", "submodule.lib.ignore", "all");
    writeFileSync(path.join(checkout, "lib", "lib.txt"), "edited\n");
    expect(run(checkout, "status", "--porcelain")).toBe("");
    expect(checkoutStatus(root, REPO, remote)).toMatchObject({ ready: false, changes: 1 });
  });

  test("lists unmanaged checkout entries without touching them", () => {
    syncRepo(root, REPO, remote);
    mkdirSync(path.join(root, "checkouts", "old-clone"));
    mkdirSync(path.join(root, "checkouts", ".github"));
    writeFileSync(path.join(root, "checkouts", ".DS_Store"), "");
    expect(unmanagedCheckouts(root, [REPO, "a2f0/missing"])).toEqual(["checkouts/.github", "checkouts/old-clone"]);
  });
});
