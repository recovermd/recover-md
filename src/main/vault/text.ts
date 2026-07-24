/**
 * Text helpers.
 *
 * Recover.MD stores raw bytes and never rewrites them (§8 "exact recovery"). These helpers
 * only *interpret* bytes for preview, diff and search; nothing here is used on a write path.
 */

const UTF8_BOM = [0xef, 0xbb, 0xbf];

export function hasUtf8Bom(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 3 &&
    bytes[0] === UTF8_BOM[0] &&
    bytes[1] === UTF8_BOM[1] &&
    bytes[2] === UTF8_BOM[2]
  );
}

/** Decodes strictly; returns null for bytes that are not valid UTF-8 (FR-2). */
export function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
    return decoder.decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Splits text into lines, preserving neither the newline characters nor any assumption
 * about CRLF vs LF. A trailing newline does not produce a phantom empty final line.
 */
export function splitLines(text: string): string[] {
  if (text === '') return [];
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export function countLines(text: string): number {
  return splitLines(text).length;
}

/** True when the document ends without a trailing newline (shown in version details). */
export function endsWithoutNewline(text: string): boolean {
  return text.length > 0 && !text.endsWith('\n') && !text.endsWith('\r');
}
