import { expect, test } from "bun:test";
import { anchors, headings, linkTargets, section, splitCode } from "./markdown";

test("finds ATX and Setext headings outside code fences", () => {
  const source = "# Title #\n\nIntro\n=====\n\n````md\n```\n## Not a heading\n```\n````\n\nTwo\nlines\n---\n";
  expect(headings(source).map(({ level, text }) => [level, text])).toEqual([[1, "Title"], [1, "Intro"], [2, "Two lines"]]);
});

test("reads a section up to the next heading at its level or above", () => {
  const source = "# Doc\n\n## Output capture\n\nOne\n\n### Detail\n\nTwo\n\n## Next\n\nThree\n";
  expect(section(source, "output capture")).toBe("\nOne\n\n### Detail\n\nTwo\n");
  expect(section(source, "Missing")).toBeUndefined();
});

test("separates prose from inline code and fenced blocks", () => {
  const { prose, code } = splitCode("Run `bun run sync` or ``a `b` c``.\n\n```sh\nbun run status\n```\nAfter.\n");
  expect(code).toEqual(["bun run sync", "a `b` c", "bun run status"]);
  expect(prose).not.toContain("bun run");
});

test("lists link targets in prose only, across wrapped lines", () => {
  const source = "See [the\nguide](docs/guide.md#setup \"Title\") and [site](https://example.com).\n`[code](not-a-link.md)`\n\n[ref]: docs/ref.md \"Ref\"\n";
  expect(linkTargets(source)).toEqual(["docs/guide.md#setup", "https://example.com", "docs/ref.md"]);
});

test("derives GitHub anchors, numbering repeated headings", () => {
  expect([...anchors("# `matrix` sync/status\n## Plan helper: older checkouts\n## Notes\n## Notes\n")])
    .toEqual(["matrix-syncstatus", "plan-helper-older-checkouts", "notes", "notes-1"]);
});
