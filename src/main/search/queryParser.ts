/**
 * Turns user input into a safe FTS5 MATCH expression (FR-9).
 *
 * User text is never interpolated into FTS syntax directly: every token is quoted, so
 * characters that mean something to FTS5 (`*`, `:`, `NEAR`, `-`, `(`…) cannot change the
 * shape of the query. A trailing `*` typed by the user is honoured as a prefix search
 * because that is a familiar and harmless affordance.
 */

export interface ParsedQuery {
  /** Null when the input contains nothing searchable. */
  expression: string | null;
  /** Terms without quoting, used for client-side highlighting. */
  terms: string[];
}

function tokenize(input: string): { text: string; prefix: boolean }[] {
  const tokens: { text: string; prefix: boolean }[] = [];
  let buffer = '';
  let inQuotes = false;

  const push = (): void => {
    const trimmed = buffer.trim();
    buffer = '';
    if (trimmed.length === 0) return;
    const prefix = trimmed.endsWith('*') && trimmed.length > 1;
    const text = prefix ? trimmed.slice(0, -1) : trimmed;
    if (text.length === 0) return;
    tokens.push({ text, prefix });
  };

  for (const char of input) {
    if (char === '"') {
      if (inQuotes) push();
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && /\s/.test(char)) {
      push();
      continue;
    }
    buffer += char;
  }
  push();
  return tokens;
}

export function parseSearchQuery(input: string): ParsedQuery {
  const tokens = tokenize(input);
  if (tokens.length === 0) return { expression: null, terms: [] };

  const parts = tokens.map((token) => {
    const escaped = token.text.replace(/"/g, '""');
    return token.prefix ? `"${escaped}"*` : `"${escaped}"`;
  });

  return { expression: parts.join(' AND '), terms: tokens.map((token) => token.text) };
}
