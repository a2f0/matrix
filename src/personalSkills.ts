// Personal skills that override managed ones. agent-tool installs the shared skills into each
// repository, and Claude Code (~/.claude/skills, or the skills/ of its config directory) and
// Antigravity CLI (~/.gemini/antigravity-cli/skills and ~/.gemini/skills) prefer a personal skill
// to a project skill of the same name, so a personal copy or a link to another clone's copy
// silently replaces every repository's pinned one. Health reports any that remain; removing one
// stays a person's decision.

import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { object } from "./packageJson";

/**
 * Claude Code configuration directories: the one `CLAUDE_CONFIG_DIR` names (Claude Code does not
 * expand `~`, so only an absolute path counts), `~/.claude`, then any other `~/.claude*`
 * directory holding `settings.json` or `.claude.json`, each once by real path, in that order.
 */
export function claudeConfigDirs(home = homedir(), env: NodeJS.ProcessEnv = process.env): string[] {
  const named = env.CLAUDE_CONFIG_DIR;
  const others = readdirSync(home)
    .filter(name => name.startsWith(".claude") && name !== ".claude")
    .sort()
    .map(name => path.join(home, name))
    .filter(directory => isDirectory(directory) && ["settings.json", ".claude.json"].some(marker => existsSync(path.join(directory, marker))));
  const candidates = [...(named && path.isAbsolute(named) ? [named] : []), path.join(home, ".claude"), ...others];
  const seen = new Set<string>();
  return candidates.filter(directory => {
    if (!isDirectory(directory)) return false;
    const real = realpathSync(directory);
    if (seen.has(real)) return false;
    seen.add(real);
    return true;
  });
}

function isDirectory(file: string): boolean {
  try {
    return statSync(file).isDirectory();
  } catch {
    return false;
  }
}

/** The skill names the workspace's `.agent-tool-skills.json` installs; undefined when it is missing or unreadable. */
export function managedSkillNames(root: string): string[] | undefined {
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(path.join(root, ".agent-tool-skills.json"), "utf8"));
  } catch {
    return undefined;
  }
  const files = object(object(manifest)?.files);
  if (!files) return undefined;
  const names = Object.keys(files).flatMap(file => /^\.(?:claude|agents)\/skills\/([^/]+)\//.exec(file)?.[1] ?? []);
  return [...new Set(names)].sort();
}

/**
 * Entries in `~/.agents/skills`, Antigravity CLI's `~/.gemini/antigravity-cli/skills` and
 * `~/.gemini/skills`, and each Claude Code configuration directory's `skills/` named like a
 * managed skill: links (dangling or not), directories, or files, as `~/...` paths.
 */
export function shadowingSkills(managed: string[], home = homedir(), env: NodeJS.ProcessEnv = process.env): string[] {
  const directories = [
    path.join(home, ".agents", "skills"),
    path.join(home, ".gemini", "antigravity-cli", "skills"),
    path.join(home, ".gemini", "skills"),
    ...claudeConfigDirs(home, env).map(directory => path.join(directory, "skills")),
  ];
  return directories.flatMap(directory =>
    managed
      .map(name => path.join(directory, name))
      .filter(entry => {
        try {
          lstatSync(entry);
          return true;
        } catch {
          return false;
        }
      })
      .map(entry => (entry.startsWith(`${home}/`) ? `~${entry.slice(home.length)}` : entry)),
  );
}
