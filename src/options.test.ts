import { expect, test } from "bun:test";
import { count, parseOptions } from "./options";

const spec = { topic: "value", note: "list", markdown: "boolean" } as const;

test("parses values, repeated lists, flags, and positional arguments", () => {
  const parsed = parseOptions(["chore/x", "--topic", "Demo", "--note=a", "one", "--note", "b=c", "--markdown"], spec, "sweep");
  expect(parsed.positional).toEqual(["chore/x", "one"]);
  expect(parsed.values).toEqual({ topic: "Demo" });
  expect(parsed.lists).toEqual({ note: ["a", "b=c"] });
  expect([...parsed.booleans]).toEqual(["markdown"]);
});

test("rejects unknown, repeated, or incomplete options", () => {
  expect(() => parseOptions(["--apply"], spec, "sweep start")).toThrow("Unknown sweep start option '--apply'.");
  expect(() => parseOptions(["-x"], spec, "sweep")).toThrow("Unknown sweep option '-x'.");
  expect(() => parseOptions(["--topic"], spec, "sweep")).toThrow("needs a value");
  expect(() => parseOptions(["--topic", "a", "--topic", "b"], spec, "sweep")).toThrow("given twice");
  expect(() => parseOptions(["--markdown=yes"], spec, "sweep")).toThrow("takes no value");
});

test("reads positive integers", () => {
  expect(count(undefined, "last", 5)).toBe(5);
  expect(count("12", "last", 5)).toBe(12);
  for (const value of ["0", "-1", "1.5", "two"]) expect(() => count(value, "last", 5)).toThrow("--last must be a positive integer.");
});
