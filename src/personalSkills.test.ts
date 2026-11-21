import { expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { claudeConfigDirs, managedSkillNames, shadowingSkills } from "./personalSkills";
import { tempDir } from "./testFixtures";

function home(): string {
  const directory = tempDir("matrix-home");
  mkdirSync(path.join(directory, ".claude", "skills", "synced"), { recursive: true });
  mkdirSync(path.join(directory, ".claude2", "skills"), { recursive: true });
  writeFileSync(path.join(directory, ".claude2", "settings.json"), "{}\n");
  // A backup without either marker is not a configuration directory.
  mkdirSync(path.join(directory, ".claude-backup", "skills", "space-cleanup"), { recursive: true });
  writeFileSync(path.join(directory, ".claude.json"), "{}\n");
  return directory;
}

test("finds Claude Code configuration directories as Claude Code and agent-tool do", () => {
  const dir = home();
  expect(claudeConfigDirs(dir, {})).toEqual([path.join(dir, ".claude"), path.join(dir, ".claude2")]);
  const named = tempDir("matrix-config");
  expect(claudeConfigDirs(dir, { CLAUDE_CONFIG_DIR: named })).toEqual([named, path.join(dir, ".claude"), path.join(dir, ".claude2")]);
  // Claude Code does not expand `~`, and the same directory twice is read once.
  expect(claudeConfigDirs(dir, { CLAUDE_CONFIG_DIR: "~/.claude2" })).toEqual([path.join(dir, ".claude"), path.join(dir, ".claude2")]);
  expect(claudeConfigDirs(dir, { CLAUDE_CONFIG_DIR: path.join(dir, ".claude2") })).toEqual([path.join(dir, ".claude2"), path.join(dir, ".claude")]);
});

test("reads the managed skill names from the workspace's skills manifest", () => {
  const root = tempDir("matrix-root");
  expect(managedSkillNames(root)).toBeUndefined();
  writeFileSync(path.join(root, ".agent-tool-skills.json"), "{ not json");
  expect(managedSkillNames(root)).toBeUndefined();
  writeFileSync(path.join(root, ".agent-tool-skills.json"), JSON.stringify({ schemaVersion: 1 }));
  expect(managedSkillNames(root)).toBeUndefined();
  const files = {
    ".claude/skills/ship-pr/SKILL.md": "x",
    ".agents/skills/ship-pr/SKILL.md": "x",
    ".agents/skills/space-cleanup/agents/openai.yaml": "x",
  };
  writeFileSync(path.join(root, ".agent-tool-skills.json"), JSON.stringify({ schemaVersion: 1, files }));
  expect(managedSkillNames(root)).toEqual(["ship-pr", "space-cleanup"]);
});

test("reports personal skills named like a managed skill, whatever holds the name", () => {
  const dir = home();
  mkdirSync(path.join(dir, ".agents", "skills"), { recursive: true });
  // A link into a clone whose copy was deleted still overrides the managed skill's name.
  symlinkSync(path.join(dir, "gone", "space-cleanup"), path.join(dir, ".agents", "skills", "space-cleanup"));
  mkdirSync(path.join(dir, ".claude", "skills", "seo-optimization"));
  symlinkSync(path.join(dir, "elsewhere"), path.join(dir, ".claude2", "skills", "take-screenshots"));
  mkdirSync(path.join(dir, ".claude2", "skills", "my-own"));
  expect(shadowingSkills(["seo-optimization", "space-cleanup", "take-screenshots"], dir, {})).toEqual([
    "~/.agents/skills/space-cleanup",
    "~/.claude/skills/seo-optimization",
    "~/.claude2/skills/take-screenshots",
  ]);
  expect(shadowingSkills([], dir, {})).toEqual([]);
});
