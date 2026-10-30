import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  acquireLock, artifactsRoot, githubRepo, LINK, link, linkState, LOCK, main, parseOptions, readRecord, relation, resolveTargets,
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
      capture(cwd, args) {
        runs.push(args);
        expect(existsSync(path.join(artifacts, "app", LOCK))).toBe(true);
        expect(readRecord(storeDir(targetFor(cwd), artifacts))?.status).toBe("running");
        write(cwd, ".screenshots/web/light/home.png", "png");
        return 0;
      },
    };
    expect(main(["capture", "app"], root, runner, print)).toBe(0);
    expect(runs).toEqual([]);
    expect(main(["capture", "app", "--apply", "--", "--project=web"], root, runner, print)).toBe(0);
    expect(runs).toEqual([["--project=web"]]);
    expect(existsSync(path.join(artifacts, "app", LOCK))).toBe(false);
    const record = readRecord(path.join(artifacts, "app/screenshots"))!;
    expect(record).toMatchObject({ status: "complete", project: "app", repo: "a2f0/app", commit: git(app, "rev-parse", "HEAD"), branch: "main", dirty: false, args: ["--project=web"], exitCode: 0 });
    expect(readFileSync(path.join(clone, ".screenshots/web/light/home.png"), "utf8")).toBe("png");
    write(clone, "src/next.ts");
    git(clone, "add", ".");
    git(clone, "commit", "-qm", "next");
    expect(relation(clone, record.commit)).toEqual({ relation: "behind", commits: 1 });
    expect(relation(app, record.commit)).toEqual({ relation: "current" });
  });

  test("refuses dirty trees and unlinked clones, and records failed captures", () => {
    const { home, app } = workspace();
    expect(() => main(["capture", "--apply"], app, undefined, print)).toThrow("not linked");
    expect(main(["link", "--apply"], app, undefined, print)).toBe(0);
    write(app, "src/wip.ts");
    expect(() => main(["capture", "--apply"], app, undefined, print)).toThrow("local changes");
    rmSync(path.join(app, "src"), { recursive: true });

    expect(main(["capture", "--apply"], app, { capture: () => 1 }, print)).toBe(1);
    const store = path.join(home, "matrix-artifacts/app/screenshots");
    expect(readRecord(store)).toMatchObject({ status: "failed", exitCode: 1 });

    // A capture that deletes the link and writes a real directory never reaches the store.
    const replacing: Runner = { capture(cwd) { rmSync(path.join(cwd, LINK)); write(cwd, ".screenshots/web/a.png"); return 0; } };
    expect(main(["capture", "--apply"], app, replacing, print)).toBe(1);
    expect(readRecord(store)?.status).toBe("failed");
  });

  test("a live lock blocks a second capture; a dead one on this host is replaced", () => {
    const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "take-screenshots-lock-")));
    temps.push(dir);
    const file = path.join(dir, LOCK);
    const info = { pid: process.pid, host: os.hostname(), checkout: dir, startedAt: "now" };
    const release = acquireLock(file, info);
    expect(() => acquireLock(file, { ...info, pid: process.pid + 1 })).toThrow("another capture");
    release();
    writeFileSync(file, JSON.stringify({ ...info, pid: 2 ** 22 + 12345 }));
    acquireLock(file, info)();
    expect(existsSync(file)).toBe(false);
    writeFileSync(file, JSON.stringify({ ...info, pid: 2 ** 22 + 12345, host: "another-host" }));
    expect(() => acquireLock(file, info)).toThrow("another-host");
  });

  test("parses commands and rejects options that do not apply", () => {
    expect(parseOptions(["capture", "app", "--apply", "--", "--project", "x"])).toMatchObject({ names: ["app"], apply: true, captureArgs: ["--project", "x"] });
    expect(() => parseOptions(["status", "--apply"])).toThrow("changes nothing");
    expect(() => parseOptions(["link", "--", "x"])).toThrow("only capture");
    expect(() => parseOptions(["link", "--allow-dirty"])).toThrow("only to capture");
    expect(() => parseOptions(["delete"])).toThrow("unknown command");
  });
});
