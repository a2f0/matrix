import { type Checkout, excludeManaged } from "./auditCheckout";
import { git } from "./git";

/**
 * Guidance that a shared command replaced. Matrix stopped carrying these
 * fallbacks once every checkout pinned MINIMUM_AGENT_TOOL; a hit in a
 * checkout's own Markdown is stale guidance. Patterns are POSIX extended
 * regular expressions for `git grep -E`.
 */
const SUPERSEDED: ReadonlyArray<{ id: string; pattern: string; replacement: string; exempt?: RegExp }> = [
  { id: "review-reply-endpoint", pattern: "pulls/([^/[:space:]`]+/)?comments/[^/[:space:]`]+/replies", replacement: "agent-tool pr threads reply" },
  { id: "untracked-branch-switch", pattern: "git switch --no-track", replacement: "agent-tool branch create" },
  { id: "pr-checks-watch", pattern: "gh pr checks[^`]*--watch", replacement: "agent-tool pr checks --wait" },
  // agent-tool 0.1.50 removed the legacy action, whose optional reviewed head let a merge skip preflight.
  { id: "squash-merge-action", pattern: "agent-tool squashMerge", replacement: "agent-tool pr merge <subject> <reviewed-head> <base-branch>" },
  { id: "push-head-upstream", pattern: "git push (-u|--set-upstream) origin HEAD", replacement: "agent-tool branch push <reviewed-head> --remote origin" },
  // A leased deletion is the stronger cleanup some checkouts require, not the hook-running push it replaced.
  { id: "push-delete", pattern: "git push [^`]*--delete", replacement: "agent-tool repo cleanup", exempt: /--force-with-lease/ },
  // Rewriting GitHub SSH URLs to HTTPS reaches the keychain credential helper (a2f0/matrix#61).
  {
    id: "https-insteadof",
    pattern: 'url\\."?https://github\\.com/?"?\\.[iI]nstead[oO]f',
    replacement: "SSH through ssh.github.com:443 (matrix docs/health.md#github-over-ssh)",
  },
];

/**
 * Superseded commands in a checkout's tracked Markdown, skipping managed skills
 * and any other paths given, one finding per pattern.
 */
export function supersededGuidance(checkout: Checkout, skip: string[] = []): string[] {
  const exclusions = excludeManaged(checkout, skip);
  const found: string[] = [];
  for (const entry of SUPERSEDED) {
    // -z separates path, line number, and text with NUL, so a path may contain colons.
    const result = git(checkout.directory, ["grep", "-z", "-n", "-I", "-E", "-e", entry.pattern, "--", "*.md", ...exclusions]);
    if (result.status === 1) continue;
    if (result.status !== 0) throw new Error(`git grep failed in ${checkout.repo}: ${result.stderr}`);
    const hits = result.stdout
      .split("\n")
      .map(line => line.split("\0"))
      .filter(([, , ...text]) => !entry.exempt?.test(text.join("\0")))
      .map(([file, line]) => `${file}:${line}`);
    if (hits.length === 0) continue;
    found.push(`${entry.id} at ${hits.slice(0, 5).join(", ")}${hits.length > 5 ? ` and ${hits.length - 5} more` : ""} (use ${entry.replacement})`);
  }
  return found;
}
