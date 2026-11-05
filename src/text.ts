/** A thrown value's message; anything thrown that is not an Error is shown as a string. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `1 rule`, `2 rules`; nouns with an irregular plural pass it. */
export function plural(count: number, noun: string, nouns = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : nouns}`;
}
