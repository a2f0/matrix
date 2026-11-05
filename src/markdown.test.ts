import { expect, test } from "bun:test";
import { anchors, headings, linkTargets, section, splitCode } from "./markdown";

test("finds ATX and Setext headings outside code fences", () => {
  const source = "# Title #\n\nIntro\n=====\n\n````md\n```\n## Not a heading\n```\n````\n\nTwo\nlines\n---\n";
  expect(headings(source).map(({ level, text }) => [level, text])).toEqual([
    [1, "Title"],
    [1, "Intro"],
    [2, "Two lines"],
  ]);
});

test("keeps heading edge cases: empty, interrupting, unclosed fences, and bare underlines", () => {
  const source = [
    "#",
    "#5 is prose",
    "---",
    "Para one",
    "## Breaks in",
    "---",
    "~~~~",
    "~~~",
    "# Hidden by the longer fence",
    "```",
    "~~~~",
    "   ###   Indented ###   ",
    "    # Too indented",
    "line a",
    "  line b",
    "===",
    "",
    "===",
    "```js",
    "``` not a close",
    "# Hidden",
  ].join("\n");
  expect(headings(source)).toEqual([
    { level: 1, text: "", line: 0 },
    { level: 2, text: "#5 is prose", line: 1 },
    { level: 2, text: "Breaks in", line: 4 },
    { level: 3, text: "Indented", line: 11 },
    { level: 1, text: "# Too indented line a line b", line: 12 },
  ]);
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
  const source = 'See [the\nguide](docs/guide.md#setup "Title") and [site](https://example.com).\n`[code](not-a-link.md)`\n\n[ref]: docs/ref.md "Ref"\n';
  expect(linkTargets(source)).toEqual(["docs/guide.md#setup", "https://example.com", "docs/ref.md"]);
});

test("derives GitHub anchors, numbering repeated headings", () => {
  expect([...anchors("# `matrix` sync/status\n## Plan helper: older checkouts\n## Notes\n## Notes\n")]).toEqual([
    "matrix-syncstatus",
    "plan-helper-older-checkouts",
    "notes",
    "notes-1",
  ]);
});
