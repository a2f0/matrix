import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    expect(syncRepo(root, REPO, remote)).toMatchObject({ action: "error", reason: "origin is git@github.com:a2f0/other.git, expected a2f0/demo" });
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

  test("lists unmanaged checkout entries without touching them", () => {
    syncRepo(root, REPO, remote);
    mkdirSync(path.join(root, "checkouts", "old-clone"));
    writeFileSync(path.join(root, "checkouts", ".DS_Store"), "");
    expect(unmanagedCheckouts(root, [REPO, "a2f0/missing"])).toEqual(["checkouts/old-clone"]);
  });
});
