import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  basenameOf,
  isInsideVault,
  isMarkdownPath,
  normalizeRelative,
  recoveryCandidateName,
  toDisplayPath,
  toNormalizedPath
} from '../../src/main/vault/paths';

const root = path.resolve('/vault');

describe('path normalization', () => {
  it('produces forward-slash, vault-relative display paths', () => {
    expect(toDisplayPath(root, path.join(root, 'notes', 'a.md'))).toBe('notes/a.md');
  });

  it('lower-cases identity paths on case-insensitive platforms only', () => {
    const target = path.join(root, 'Notes', 'A.md');
    expect(toNormalizedPath(root, target, 'win32')).toBe('notes/a.md');
    expect(toNormalizedPath(root, target, 'darwin')).toBe('notes/a.md');
    expect(toNormalizedPath(root, target, 'linux')).toBe('Notes/A.md');
  });

  it('normalizes already-relative paths consistently', () => {
    expect(normalizeRelative('Notes\\A.md', 'win32')).toBe('notes/a.md');
    expect(normalizeRelative('Notes/A.md', 'linux')).toBe('Notes/A.md');
  });
});

describe('vault containment', () => {
  it('accepts paths inside the vault, including the root itself', () => {
    expect(isInsideVault(root, path.join(root, 'a.md'))).toBe(true);
    expect(isInsideVault(root, path.join(root, 'deep', 'nested', 'a.md'))).toBe(true);
    expect(isInsideVault(root, root)).toBe(true);
  });

  it('rejects traversal out of the vault', () => {
    expect(isInsideVault(root, path.join(root, '..', 'escape.md'))).toBe(false);
    expect(isInsideVault(root, path.resolve('/elsewhere/a.md'))).toBe(false);
  });

  it('rejects sibling directories with a shared prefix', () => {
    expect(isInsideVault(path.resolve('/vault'), path.resolve('/vault-backup/a.md'))).toBe(false);
  });
});

describe('markdown detection', () => {
  it('matches .md case-insensitively where the platform does', () => {
    expect(isMarkdownPath('a.md', 'linux')).toBe(true);
    expect(isMarkdownPath('A.MD', 'win32')).toBe(true);
    expect(isMarkdownPath('A.MD', 'linux')).toBe(false);
    expect(isMarkdownPath('a.markdown', 'win32')).toBe(false);
    expect(isMarkdownPath('a.txt', 'win32')).toBe(false);
  });
});

describe('recovery names', () => {
  it('builds "(recovered)" names and numbers repeats', () => {
    expect(recoveryCandidateName('note.md', 1)).toBe('note (recovered).md');
    expect(recoveryCandidateName('note.md', 3)).toBe('note (recovered 3).md');
    expect(recoveryCandidateName('no-extension', 1)).toBe('no-extension (recovered)');
  });
});

describe('basename', () => {
  it('returns the last segment', () => {
    expect(basenameOf('a/b/c.md')).toBe('c.md');
    expect(basenameOf('c.md')).toBe('c.md');
  });
});
