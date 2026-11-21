import { expect, test } from "bun:test";
import { parseUserSkillReport, summarizeCheck, summarizeSync, tilde, type UserSkillLink } from "./userSkills";

const HOME = "/home/me";

function link(status: string, skill = "space-cleanup", directory = `${HOME}/.claude2/skills`, extra: Partial<UserSkillLink> = {}): UserSkillLink {
  return { skill, path: `${directory}/${skill}`, target: `${HOME}/github/matrix/skills/${skill}`, status, ...extra };
}

test("reads the changes of a skills link or check-links report, and nothing else", () => {
  const changes = [link("create"), { ...link("unchanged"), directory: `${HOME}/.claude/skills`, current: "x" }];
  expect(parseUserSkillReport(JSON.stringify({ applied: false, changes }))).toEqual(changes);
  expect(parseUserSkillReport(JSON.stringify({ ok: true, changes: [] }))).toEqual([]);
  expect(parseUserSkillReport("Error: Declared user skill 'x' has no source.")).toBeUndefined();
  expect(parseUserSkillReport(JSON.stringify({ changes: [{ skill: "x" }] }))).toBeUndefined();
  expect(parseUserSkillReport(JSON.stringify([]))).toBeUndefined();
});

test("shortens paths under the home directory only", () => {
  expect(tilde(`${HOME}/.claude2/skills/x`, HOME)).toBe("~/.claude2/skills/x");
  expect(tilde(HOME, HOME)).toBe("~");
  expect(tilde("/home/meadow/x", HOME)).toBe("/home/meadow/x");
});

test("sync lists links it wrote and reports conflicts, failed writes, and unreadable repositories", () => {
  const summary = summarizeSync(
    [
      {
        repo: "workspace",
        report: {
          links: [
            link("create", "space-cleanup", undefined, { result: "written" }),
            link("unchanged", "take-screenshots"),
            link("kept", "performance-pass"),
            link("repair", "explicit-state-machines", undefined, { result: "failed", error: "EACCES" }),
          ],
        },
      },
      { repo: "a2f0/balebase", report: { links: [link("conflict", "seo-optimization", `${HOME}/.agents/skills`)] } },
      { repo: "a2f0/old", report: { error: "Unknown sync option" } },
      // The same link reported twice is listed once.
      { repo: "a2f0/again", report: { links: [link("create", "space-cleanup", undefined, { result: "written" })] } },
    ],
    HOME,
  );
  expect(summary).toEqual({
    linked: ["~/.claude2/skills/space-cleanup -> ~/github/matrix/skills/space-cleanup"],
    problems: [
      "~/.claude2/skills/explicit-state-machines: EACCES",
      "~/.agents/skills/seo-optimization (held by something other than a link to seo-optimization)",
      "a2f0/old: Unknown sync option",
    ],
  });
});

test("health counts links to create or repair, conflicts, and repositories it could not read", () => {
  expect(
    summarizeCheck(
      [
        {
          repo: "workspace",
          report: { links: [link("create"), link("repair", "take-screenshots"), link("unchanged", "performance-pass"), link("kept", "x")] },
        },
        { repo: "a2f0/balebase", report: { links: [link("conflict", "audit-trails")] } },
        { repo: "a2f0/old", report: { error: "agent-tool exited 2" } },
      ],
      HOME,
    ),
  ).toEqual({
    missing: ["~/.claude2/skills/space-cleanup", "~/.claude2/skills/take-screenshots"],
    conflicts: ["~/.claude2/skills/audit-trails (held by something other than a link to audit-trails)"],
    unreadable: ["a2f0/old: agent-tool exited 2"],
  });
  expect(summarizeCheck([{ repo: "workspace", report: { links: [link("unchanged")] } }], HOME)).toEqual({ missing: [], conflicts: [], unreadable: [] });
});
