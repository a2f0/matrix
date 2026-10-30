import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  acquireLock, artifactsRoot, processGroup, validRecord, githubRepo, LINK, link, linkState, LOCK, main, parseOptions, readRecord, relation, resolveTargets,
  type Runner, storeDir, targetFor,
} from "../skills/take-screenshots/scripts/artifacts";

const temps: string[] = [];
afterEach(() => { for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function git(root: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function write(root: string, rel: string, text = "x") {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), text);
}

/** A matrix workspace beside its store, with a checkout that captures and one that does not. */
function workspace(ignore = ".screenshots\n"): { home: string; root: string; app: string } {
  const home = realpathSync(mkdtempSync(path.join(os.tmpdir(), "take-screenshots-")));
  temps.push(home);
  const root = path.join(home, "matrix");
  write(root, "matrix.json", "{}");
  const app = repo(path.join(root, "checkouts", "app"), ignore);
  repo(path.join(root, "checkouts", "lib"), ignore, {});
  git(root, "init", "-q");
  return { home, root, app };
}

function repo(root: string, ignore: string, scripts: Record<string, string> = { screenshots: "echo capture" }): string {
  mkdirSync(root, { recursive: true });
  git(root, "init", "-q", "-b", "main");
  write(root, ".gitignore", ignore);
  write(root, "package.json", JSON.stringify({ scripts }));
  git(root, "add", ".");
  git(root, "commit", "-qm", "init");
  git(root, "remote", "add", "origin", "git@github.com:a2f0/app.git");
  return root;
}

const output: string[] = [];
const print = (text: string) => { output.push(text); };

describe("take-screenshots artifacts", () => {
  test("names projects by GitHub repository and stores them beside the workspace", () => {
    expect(githubRepo("git@github.com:a2f0/a2f0.net.git")).toBe("a2f0/a2f0.net");
    expect(githubRepo("https://github.com/a2f0/nc")).toBe("a2f0/nc");
    expect(githubRepo("/srv/git/app.git")).toBeUndefined();
    expect(githubRepo("ssh://git@github.com/a2f0/app.git")).toBe("a2f0/app");
    expect(githubRepo("https://token@github.com/a2f0/app.git")).toBe("a2f0/app");
    for (const url of ["https://evilgithub.com/a2f0/app.git", "git@github.com.evil.io:a2f0/app.git", "https://github.com.evil.io/a2f0/app", "https://evil.io/github.com/a2f0/app"]) {
      expect(githubRepo(url)).toBeUndefined();
    }
    const { home, root, app } = workspace();
    expect(artifactsRoot(root, {})).toBe(path.join(home, "matrix-artifacts"));
    expect(artifactsRoot(app, {})).toBe(path.join(home, "matrix-artifacts"));
    expect(artifactsRoot(app, { MATRIX_ARTIFACTS_DIR: "/elsewhere" })).toBe("/elsewhere");
    // A clone outside any workspace keeps the store beside itself.
    expect(artifactsRoot(path.join(home, "app2"), {})).toBe(path.join(home, "matrix-artifacts"));
    expect(targetFor(app)).toMatchObject({ project: "app", repo: "a2f0/app" });
    // Only checkouts that capture are selected by default.
    expect(resolveTargets(root, []).targets.map(target => target.name)).toEqual(["app"]);
  });

  test("links a clone with a relative, ignored symlink, and only when a plain pattern ignores it", () => {
    const { home, app } = workspace();
    const target = targetFor(app);
    const artifacts = path.join(home, "matrix-artifacts");
    expect(link(target, artifacts, false)).toMatchObject({ before: "missing", action: "link" });
    expect(lstatSync(path.join(app, LINK), { throwIfNoEntry: false })).toBeUndefined();
    expect(link(target, artifacts, true)).toMatchObject({ action: "link", applied: true });
    expect(readlinkSync(path.join(app, LINK))).toBe("../../../matrix-artifacts/app/screenshots");
    expect(linkState(target, artifacts)).toEqual({ state: "linked" });
    expect(git(app, "status", "--porcelain")).toBe("");
    expect(link(target, artifacts, true)).toMatchObject({ before: "linked" });

    const slashed = workspace(".screenshots/\n");
    expect(link(targetFor(slashed.app), path.join(slashed.home, "matrix-artifacts"), true).blocked).toContain("without a trailing slash");
  });

  test("moves an existing capture into an empty store, and refuses to merge two captures", () => {
    const { home, app } = workspace();
    const artifacts = path.join(home, "matrix-artifacts");
    write(app, ".screenshots/web/home.png", "old");
    expect(link(targetFor(app), artifacts, true)).toMatchObject({ before: "directory", action: "move-and-link", applied: true });
    expect(readFileSync(path.join(artifacts, "app/screenshots/web/home.png"), "utf8")).toBe("old");

    const second = repo(path.join(home, "app2"), ".screenshots\n");
    write(second, ".screenshots/web/home.png", "other");
    expect(link(targetFor(second), artifacts, true).blocked).toContain("store already holds another");
    expect(readFileSync(path.join(second, ".screenshots/web/home.png"), "utf8")).toBe("other");
    // --supersede keeps the clone's capture beside the store, never deleting it.
    const moved = link(targetFor(second), artifacts, true, true, new Date("2026-10-30T12:00:00.000Z"));
    expect(moved).toMatchObject({ action: "supersede-and-link", applied: true, superseded: path.join(artifacts, "app/superseded/app2-2026-10-30T12-00-00-000Z") });
    expect(readFileSync(path.join(moved.superseded!, "web/home.png"), "utf8")).toBe("other");
    expect(readFileSync(path.join(second, ".screenshots/web/home.png"), "utf8")).toBe("old");

    const stray = repo(path.join(home, "app3"), ".screenshots\n");
    symlinkSync("/tmp", path.join(stray, LINK));
    expect(link(targetFor(stray), artifacts, true).blocked).toContain("already links to");
  });

  test("captures under a lock, records provenance, and every linked clone sees it", () => {
    const { home, root, app } = workspace();
    const artifacts = path.join(home, "matrix-artifacts");
    expect(main(["link", "--apply"], root, undefined, print)).toBe(0);
    const clone = repo(path.join(home, "app-day-to-day"), ".screenshots\n");
    git(clone, "fetch", "-q", app, "main");
    git(clone, "reset", "-q", "--hard", "FETCH_HEAD");
    expect(main(["link", "--apply"], clone, undefined, print)).toBe(0);

    const runs: string[][] = [];
    const runner: Runner = {
      capture(cwd, args, env) {
        runs.push(args);
        expect(env.SCREENSHOT_OUTPUT_DIR).toBe(path.join(cwd, LINK));
        expect(existsSync(path.join(artifacts, "app", LOCK))).toBe(true);
        expect(readRecord(storeDir(targetFor(cwd), artifacts))?.status).toBe("running");
        write(cwd, ".screenshots/web/light/home.png", "png");
        return 0;
      },
    };
    expect(main(["capture", "app"], root, runner, print)).toBe(0);
    expect(runs).toEqual([]);
    expect(main(["capture", "app", "--apply"], root, runner, print)).toBe(0);
    expect(main(["capture", "app", "--apply", "--", "--project=web"], root, runner, print)).toBe(0);
    expect(runs).toEqual([[], ["--project=web"]]);
    expect(existsSync(path.join(artifacts, "app", LOCK))).toBe(false);
    const record = readRecord(path.join(artifacts, "app/screenshots"))!;
    expect(record).toMatchObject({ status: "complete", project: "app", repo: "a2f0/app", commit: git(app, "rev-parse", "HEAD"), branch: "main", dirty: false, args: ["--project=web"], exitCode: 0 });
    expect(readFileSync(path.join(clone, ".screenshots/web/light/home.png"), "utf8")).toBe("png");
    write(clone, "src/next.ts");
    git(clone, "add", ".");
    git(clone, "commit", "-qm", "next");
    expect(relation(clone, record.commit)).toEqual({ relation: "behind", commits: 1 });
    expect(relation(app, record.commit)).toEqual({ relation: "current" });

    // Another owner's repository of the same name cannot write into this namespace.
    const fork = repo(path.join(home, "fork", "app"), ".screenshots\n");
    git(fork, "remote", "set-url", "origin", "git@github.com:someone/app.git");
    expect(link(targetFor(fork), artifacts, true).blocked).toContain("holds captures of a2f0/app");
    // An empty namespace is reserved by the first repository that links it.
    const other = path.join(home, "other-artifacts");
    rmSync(path.join(app, LINK));
    expect(link(targetFor(app), other, true)).toMatchObject({ applied: true });
    rmSync(path.join(app, LINK));
    expect(link(targetFor(fork), other, true).blocked).toContain("holds captures of a2f0/app, not someone/app");
    // Without a GitHub origin the namespace must be named.
    git(fork, "remote", "set-url", "origin", "/srv/git/app.git");
    expect(() => targetFor(fork, undefined, () => undefined)).toThrow("pass --project");
    expect(targetFor(fork, "app-local", () => undefined)).toMatchObject({ project: "app-local" });
  });

  test("partial captures keep the merge state of the images they keep", () => {
    const { app } = workspace();
    expect(main(["link", "--apply"], app, undefined, print)).toBe(0);
    const ok: Runner = { capture: () => 0 };
    // No origin/HEAD here, so merged is unknown (null); a full capture records that.
    expect(main(["capture", "--apply"], app, ok, print)).toBe(0);
    const store = storeDir(targetFor(app), artifactsRoot(app));
    expect(readRecord(store)?.merged).toBeNull();
    git(app, "update-ref", "refs/remotes/origin/HEAD", "HEAD");
    expect(main(["capture", "--apply", "--", "--project=web"], app, ok, print)).toBe(0);
    expect(readRecord(store)).toMatchObject({ merged: null, over: { status: "complete" } });
    expect(main(["capture", "--apply"], app, ok, print)).toBe(0);
    expect(readRecord(store)?.merged).toBe(true);
  });

  test("refuses dirty trees and unlinked clones, and records failed captures", () => {
    const { home, app } = workspace();
    expect(() => main(["capture", "--apply"], app, undefined, print)).toThrow("not linked");
    expect(main(["link", "--apply"], app, undefined, print)).toBe(0);
    write(app, "src/wip.ts");
    expect(() => main(["capture", "--apply"], app, undefined, print)).toThrow("local changes");
    rmSync(path.join(app, "src"), { recursive: true });
    // A git check that fails is not evidence of a clean tree.
    const index = readFileSync(path.join(app, ".git/index"));
    writeFileSync(path.join(app, ".git/index"), "corrupt");
    expect(() => main(["capture", "--apply"], app, undefined, print)).toThrow("cannot tell whether it has local changes");
    writeFileSync(path.join(app, ".git/index"), index);
    // Edits hidden behind assume-unchanged or skip-worktree still count.
    for (const flag of ["--assume-unchanged", "--skip-worktree"]) {
      git(app, "update-index", flag, "package.json");
      expect(() => main(["capture", "--apply"], app, undefined, print)).toThrow("local changes");
      git(app, "update-index", flag.replace("--", "--no-"), "package.json");
    }
    // A partial capture into a store with no record keeps images of unknown provenance.
    expect(main(["capture", "--apply", "--", "--project=web"], app, { capture: () => 0 }, print)).toBe(1);
    expect(readRecord(path.join(home, "matrix-artifacts/app/screenshots"))?.status).toBe("incomplete");

    expect(main(["capture", "--apply"], app, { capture: () => 1 }, print)).toBe(1);
    const store = path.join(home, "matrix-artifacts/app/screenshots");
    expect(readRecord(store)).toMatchObject({ status: "failed", exitCode: 1 });

    // A capture that deletes the link and writes a real directory never reaches the store.
    const replacing: Runner = { capture(cwd) { rmSync(path.join(cwd, LINK)); write(cwd, ".screenshots/web/a.png"); return 0; } };
    expect(main(["capture", "--apply"], app, replacing, print)).toBe(1);
    // A branch switch during the capture means the record would name the wrong commit.
    const switching: Runner = { capture(cwd) { git(cwd, "commit", "-q", "--allow-empty", "-m", "moved"); return 0; } };
    rmSync(path.join(app, LINK), { recursive: true });
    expect(main(["link", "--apply"], app, undefined, print)).toBe(0);
    expect(main(["capture", "--apply"], app, switching, print)).toBe(1);
    expect(readRecord(store)?.status).toBe("failed");
    expect(readRecord(store)?.status).toBe("failed");

    // A partial capture keeps the failed capture's other images, so it cannot mark the store complete.
    const ok: Runner = { capture: () => 0 };
    rmSync(path.join(app, LINK), { recursive: true });
    expect(main(["link", "--apply", "--supersede"], app, undefined, print)).toBe(0);
    expect(main(["capture", "--apply", "--", "--project=web"], app, ok, print)).toBe(1);
    expect(readRecord(store)).toMatchObject({ status: "incomplete", over: { status: "failed" } });
    expect(main(["capture", "--apply"], app, ok, print)).toBe(0);
    expect(readRecord(store)).toMatchObject({ status: "complete", dirty: false });
    expect(readRecord(store)?.over).toBeUndefined();

    // A partial clean capture over a dirty one stays dirty until a full clean capture.
    write(app, "src/wip.ts");
    expect(main(["capture", "--apply", "--allow-dirty"], app, ok, print)).toBe(0);
    rmSync(path.join(app, "src"), { recursive: true });
    expect(main(["capture", "--apply", "--", "--project=web"], app, ok, print)).toBe(0);
    expect(readRecord(store)).toMatchObject({ status: "complete", dirty: true, over: { dirty: true } });
  });

  test("a live lock blocks a second capture; a dead holder's lock waits for a person", () => {
    const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "take-screenshots-lock-")));
    temps.push(dir);
    const file = path.join(dir, LOCK);
    const info = { pid: process.pid, host: os.hostname(), checkout: dir, startedAt: "now" };
    const release = acquireLock(file, info);
    expect(() => acquireLock(file, { ...info, pid: process.pid + 1 })).toThrow("another capture");
    release();
    // A dead holder's lock is reported, never removed: recovery could race another process.
    writeFileSync(file, JSON.stringify({ ...info, pid: 2 ** 22 + 12345 }));
    expect(() => acquireLock(file, info)).toThrow("is no longer running");
    expect(existsSync(file)).toBe(true);
    writeFileSync(file, JSON.stringify({ ...info, pid: 2 ** 22 + 12345, host: "another-host" }));
    expect(() => acquireLock(file, info)).toThrow("another-host");
    writeFileSync(file, "{");
    expect(() => acquireLock(file, info)).toThrow("unreadable");
    // A dead holder whose process group still runs (orphaned capture children) is not recoverable yet.
    writeFileSync(file, JSON.stringify({ ...info, pid: 2 ** 22 + 12345, pgid: processGroup(process.pid) }));
    expect(() => acquireLock(file, info)).toThrow("still has processes that may be writing");
  });

  test("exactly one of several concurrent processes takes the lock", async () => {
    const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "take-screenshots-race-")));
    temps.push(dir);
    const file = path.join(dir, LOCK);
    const script = path.join(dir, "race.ts");
    const module = path.resolve(import.meta.dir, "../skills/take-screenshots/scripts/artifacts.ts");
    writeFileSync(script, `import { acquireLock } from ${JSON.stringify(module)};
try {
  acquireLock(${JSON.stringify(file)}, { pid: process.pid, host: "${os.hostname()}", checkout: "x", startedAt: "now" });
  console.log("won");
  await Bun.sleep(1500);
} catch { console.log("lost"); }
`);
    const children = Array.from({ length: 6 }, () => Bun.spawn([process.execPath, script], { stdout: "pipe" }));
    const results = await Promise.all(children.map(child => new Response(child.stdout).text()));
    expect(results.map(result => result.trim()).filter(result => result === "won")).toHaveLength(1);
  });

  test("malformed records read as no record, so partial captures over them stay incomplete", () => {
    const good = { schemaVersion: 1, project: "app", status: "complete", commit: "a".repeat(40), branch: "main", dirty: false, merged: true, args: [] };
    expect(validRecord(good)).toBe(true);
    expect(validRecord({ status: "complete" })).toBe(false);
    expect(validRecord({ ...good, commit: "abc" })).toBe(false);
    expect(validRecord({ ...good, dirty: "no" })).toBe(false);
    expect(validRecord({ ...good, status: "done" })).toBe(false);
    expect(validRecord({ ...good, over: { commit: "x", status: "complete" } })).toBe(false);
    const { home, app } = workspace();
    expect(main(["link", "--apply"], app, undefined, print)).toBe(0);
    const store = path.join(home, "matrix-artifacts/app/screenshots");
    writeFileSync(path.join(store, "capture.json"), JSON.stringify({ status: "complete" }));
    expect(main(["capture", "--apply", "--", "--project=web"], app, { capture: () => 0 }, print)).toBe(1);
    expect(readRecord(store)).toMatchObject({ status: "incomplete" });
  });

  test("parses commands and rejects options that do not apply", () => {
    expect(parseOptions(["capture", "app", "--apply", "--", "--project", "x"])).toMatchObject({ names: ["app"], apply: true, captureArgs: ["--project", "x"] });
    expect(() => parseOptions(["status", "--apply"])).toThrow("changes nothing");
    expect(() => parseOptions(["link", "--", "x"])).toThrow("only capture");
    expect(() => parseOptions(["link", "--allow-dirty"])).toThrow("only to capture");
    expect(() => parseOptions(["capture", "--supersede"])).toThrow("only to link");
    expect(() => parseOptions(["delete"])).toThrow("unknown command");
  });
});
