/** Extracts plain search terms for client-side highlighting (FR-9). */
export function parseTerms(input: string): string[] {
  const terms: string[] = [];
  let buffer = '';
  let inQuotes = false;

  const push = (): void => {
    const value = buffer.trim().replace(/\*$/, '');
    buffer = '';
    if (value.length > 0) terms.push(value);
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
  return terms;
}
