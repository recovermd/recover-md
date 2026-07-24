import { describe, expect, it } from 'vitest';
import { createIgnoreMatcher } from '../../src/main/vault/ignore';

describe('ignore rules', () => {
  const matcher = createIgnoreMatcher([], 'linux');

  it('excludes the documented defaults', () => {
    expect(matcher.ignoresFile('.git/config')).toBe(true);
    expect(matcher.ignoresFile('node_modules/pkg/readme.md')).toBe(true);
    expect(matcher.ignoresFile('.obsidian/cache/data.json')).toBe(true);
    expect(matcher.ignoresFile('.trash/old.md')).toBe(true);
    expect(matcher.ignoresFile('trash/old.md')).toBe(true);
  });

  it('prunes the directories those patterns describe', () => {
    expect(matcher.ignoresDirectory('.git')).toBe(true);
    expect(matcher.ignoresDirectory('node_modules')).toBe(true);
    expect(matcher.ignoresDirectory('.obsidian/cache')).toBe(true);
  });

  it('excludes operating-system and editor temporary files', () => {
    expect(matcher.ignoresFile('notes/.DS_Store')).toBe(true);
    expect(matcher.ignoresFile('Thumbs.db')).toBe(true);
    expect(matcher.ignoresFile('notes/draft.md.tmp')).toBe(true);
    expect(matcher.ignoresFile('notes/.#draft.md')).toBe(true);
    expect(matcher.ignoresFile('notes/draft.md~')).toBe(true);
  });

  it('does not exclude hidden directories wholesale — vaults keep notes in them', () => {
    expect(matcher.ignoresFile('.config/notes/plan.md')).toBe(false);
    expect(matcher.ignoresDirectory('.config')).toBe(false);
    expect(matcher.ignoresFile('.obsidian/templates/daily.md')).toBe(false);
  });

  it('accepts user patterns in addition to the defaults', () => {
    const custom = createIgnoreMatcher(['archive/**', '**/*.draft.md'], 'linux');
    expect(custom.ignoresFile('archive/2020/old.md')).toBe(true);
    expect(custom.ignoresFile('notes/thing.draft.md')).toBe(true);
    expect(custom.ignoresFile('notes/thing.md')).toBe(false);
  });

  it('applies case-insensitive matching on case-insensitive platforms', () => {
    const win = createIgnoreMatcher(['Archive/**'], 'win32');
    expect(win.ignoresFile('archive/old.md')).toBe(true);
    const linux = createIgnoreMatcher(['Archive/**'], 'linux');
    expect(linux.ignoresFile('archive/old.md')).toBe(false);
  });
});
