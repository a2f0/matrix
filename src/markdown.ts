/** The small part of CommonMark that audits and guidance checks need. */

export function nonBlankLines(source: string): string[] { return source.split("\n").map(line => line.trim()).filter(Boolean); }

export interface Heading { readonly level: number; readonly text: string; readonly line: number }

const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** Whether a line closes the fence it opened: the same character, at least as many times, and nothing else. */
function closes(line: string, fence: string): boolean {
  const marker = FENCE.exec(line)?.[1];
  return marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker;
}

/**
 * Markdown headings outside fenced code blocks. As in CommonMark, a fence closes
 * only on the same character repeated at least as many times, so a longer fence
 * can show shorter ones as examples.
 */
export function headings(source: string): Heading[] {
  let fence: string | undefined;
  // The lines of the paragraph being read, which a Setext underline turns into a heading.
  let paragraph: { lines: string[]; start: number } | undefined;
  const found: Heading[] = [];
  for (const [index, line] of source.split("\n").entries()) {
    const marker = FENCE.exec(line)?.[1];
    if (fence === undefined) {
      const heading = /^ {0,3}(#{1,6})(?:\s+(.*?))?(?:\s+#+)?\s*$/.exec(line);
      const underline = /^ {0,3}(=+|-+)\s*$/.exec(line)?.[1];
      if (marker) fence = marker;
      // An ATX heading may end with closing hashes, which are not part of its text.
      else if (heading) found.push({ level: heading[1]!.length, text: heading[2] ?? "", line: index });
      // = underlines a level 1 heading and - a level 2 one; the heading is the whole paragraph.
      else if (underline && paragraph) found.push({ level: underline[0] === "=" ? 1 : 2, text: paragraph.lines.join(" "), line: paragraph.start });
      if (marker || heading || underline || !line.trim()) paragraph = undefined;
      else if (paragraph) paragraph.lines.push(line.trim());
      else paragraph = { lines: [line.trim()], start: index };
    } else if (closes(line, fence)) {
      fence = undefined;
    }
  }
  return found;
}

/** A section's body: the lines after its heading, up to the next heading at its level or above. */
export function section(source: string, name: string): string | undefined {
  const all = headings(source);
  const start = all.findIndex(heading => heading.level >= 2 && heading.text.toLowerCase() === name.toLowerCase());
  if (start === -1) return undefined;
  const end = all.slice(start + 1).find(heading => heading.level <= all[start]!.level)?.line;
  return source.split("\n").slice(all[start]!.line + 1, end).join("\n");
}

export function hasSection(source: string, name: string): boolean { return section(source, name) !== undefined; }

/** Inline, reference, and autolinks, and shortcut references the document defines. */
export function hasLink(text: string, document: string): boolean {
  if (/\]\(|\]\[|<https?:|https?:\/\//.test(text)) return true;
  return [...text.matchAll(/\[([^\]]+)\]/g)].some(([, label]) => {
    const escaped = label!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`^ {0,3}\\[${escaped}\\]:`, "im").test(document);
  });
}

/** Split a document into prose and code: fenced blocks and inline code spans. */
export function splitCode(source: string): { prose: string; code: string[] } {
  const code: string[] = [];
  const prose: string[] = [];
  let fence: string | undefined;
  let block: string[] = [];
  for (const line of source.split("\n")) {
    if (fence === undefined) {
      const marker = FENCE.exec(line)?.[1];
      if (marker) { fence = marker; block = []; continue; }
      // Inline code spans open and close with the same run of backticks.
      prose.push(line.replace(/(`+)(.+?)\1/g, (_, _ticks, span: string) => { code.push(span.trim()); return " "; }));
    } else if (closes(line, fence)) {
      fence = undefined;
      code.push(block.join("\n"));
    } else {
      block.push(line);
    }
  }
  return { prose: prose.join("\n"), code };
}

/** Link targets in prose, inline and from reference definitions, without their titles. */
export function linkTargets(source: string): string[] {
  const { prose } = splitCode(source);
  // Lines are joined so a link text that wraps still parses.
  const inline = [...prose.replace(/\n/g, " ").matchAll(/\]\(\s*<?([^\s)>]+)>?(?:\s+"[^"]*")?\s*\)/g)].map(([, target]) => target!);
  const definitions = [...prose.matchAll(/^ {0,3}\[[^\]]+\]:\s*<?([^\s>]+)>?/gm)].map(([, target]) => target!);
  return [...inline, ...definitions];
}

/** GitHub's anchor for a heading: lowercase, punctuation removed, spaces as hyphens. */
export function anchor(text: string): string {
  return text.replace(/`/g, "").trim().toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "").replace(/ /g, "-");
}

/** Every anchor a document defines, with GitHub's -1, -2 suffixes for repeated headings. */
export function anchors(source: string): Set<string> {
  const seen = new Map<string, number>();
  const result = new Set<string>();
  for (const heading of headings(source)) {
    const base = anchor(heading.text);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    result.add(count === 0 ? base : `${base}-${count}`);
  }
  return result;
}
