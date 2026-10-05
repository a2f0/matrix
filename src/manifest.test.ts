import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { checkoutPath, cloneUrl, parseGitHubRepo, parseManifest, selectRepos } from "./manifest";

const valid = {
  schemaVersion: 1,
  protocol: "ssh",
  discover: { owner: "a2f0", visibility: "public", exclude: ["a2f0/matrix"] },
  repos: ["a2f0/a2f0.net", "a2f0/tearleads"],
};
const parse = (value: unknown) => parseManifest(JSON.stringify(value));

describe("parseManifest", () => {
  test("accepts the committed manifest", () => {
    const manifest = parseManifest(readFileSync(path.join(import.meta.dir, "..", "matrix.json"), "utf8"));
    expect(manifest.repos).toContain("a2f0/tearleads");
    expect(manifest.repos).not.toContain("a2f0/matrix");
  });

  test("rejects unknown, missing, and invalid settings", () => {
    expect(() => parse({ ...valid, extra: true })).toThrow("manifest.extra is not a known setting");
    const { repos: _repos, ...withoutRepos } = valid;
    expect(() => parse(withoutRepos)).toThrow("manifest.repos is required");
    expect(() => parse({ ...valid, schemaVersion: 2 })).toThrow("schemaVersion must be 1");
    expect(() => parse({ ...valid, protocol: "git" })).toThrow("protocol must be one of");
    expect(() => parse({ ...valid, discover: { ...valid.discover, visibility: "internal" } })).toThrow("discover.visibility");
  });

  test("rejects malformed repositories and checkout name collisions", () => {
    for (const repo of ["tearleads", "a2f0/", "a2f0/..", "../a2f0/x", "a2f0/a/b"]) {
      expect(() => parse({ ...valid, repos: [repo] })).toThrow("must be owner/name");
    }
    expect(() => parse({ ...valid, repos: ["a2f0/tools", "other/Tools"] })).toThrow("reuses checkout name 'Tools'");
    expect(parse({ ...valid, discover: { ...valid.discover, exclude: ["a2f0/tools", "other/tools"] } }).discover.exclude).toHaveLength(2);
    expect(() => parseManifest("{")).toThrow("matrix.json: manifest is not JSON");
  });
});

describe("repository helpers", () => {
  test("builds clone URLs and checkout paths", () => {
    expect(cloneUrl("a2f0/nc", "ssh")).toBe("git@github.com:a2f0/nc.git");
    expect(cloneUrl("a2f0/nc", "https")).toBe("https://github.com/a2f0/nc.git");
    expect(checkoutPath("/w", "a2f0/a2f0.net")).toBe(path.join("/w", "checkouts", "a2f0.net"));
  });

  test("normalizes GitHub remote URLs", () => {
    for (const url of ["git@github.com:a2f0/nc.git", "git@github.com:a2f0/nc", "ssh://git@github.com/a2f0/nc.git", "https://github.com/a2f0/nc", "https://token@github.com/a2f0/nc.git/"]) {
      expect(parseGitHubRepo(url)).toBe("a2f0/nc");
    }
    expect(parseGitHubRepo("https://gitlab.com/a2f0/nc.git")).toBeUndefined();
    expect(parseGitHubRepo("/tmp/remote.git")).toBeUndefined();
  });

  test("selects repositories by full or checkout name", () => {
    const manifest = parse(valid);
    expect(selectRepos(manifest, [])).toEqual(manifest.repos);
    expect(selectRepos(manifest, ["Tearleads", "a2f0/a2f0.net"])).toEqual(["a2f0/tearleads", "a2f0/a2f0.net"]);
    expect(() => selectRepos(manifest, ["missing"])).toThrow("'missing' is not a managed repository");
  });
});
