import { describe, expect, it } from 'vitest';
import { parseSearchQuery } from '../../src/main/search/queryParser';
import { groupMatches } from '../../src/main/search/searchService';
import type { RawSearchMatchTyped } from '../../src/main/storage/repositories/searchRepository';

describe('parseSearchQuery', () => {
  it('quotes every term so FTS syntax cannot be injected', () => {
    expect(parseSearchQuery('pricing model').expression).toBe('"pricing" AND "model"');
    expect(parseSearchQuery('NEAR(a b)').expression).toBe('"NEAR(a" AND "b)"');
    expect(parseSearchQuery('-foo OR bar').expression).toBe('"-foo" AND "OR" AND "bar"');
  });

  it('escapes embedded quotes', () => {
    expect(parseSearchQuery('say "hi').expression).toBe('"say" AND "hi"');
  });

  it('supports quoted phrases', () => {
    expect(parseSearchQuery('"risk analysis" pricing').expression).toBe(
      '"risk analysis" AND "pricing"'
    );
  });

  it('honours a trailing asterisk as a prefix search', () => {
    expect(parseSearchQuery('pric*').expression).toBe('"pric"*');
  });

  it('returns null for empty input', () => {
    expect(parseSearchQuery('   ').expression).toBeNull();
    expect(parseSearchQuery('').terms).toEqual([]);
  });
});

function match(overrides: Partial<RawSearchMatchTyped>): RawSearchMatchTyped {
  return {
    version_id: 'v1',
    file_id: 'f1',
    path: 'notes/a.md',
    captured_at: 1000,
    event_type: 'modify',
    current_path: 'notes/a.md',
    file_status: 'active',
    is_current: 0,
    blob_hash: 'hash-1',
    snippet: 'text',
    rank: -1,
    ...overrides
  };
}

describe('groupMatches', () => {
  it('groups by logical file', () => {
    const result = groupMatches([
      match({ version_id: 'v1', file_id: 'f1', blob_hash: 'h1' }),
      match({ version_id: 'v2', file_id: 'f2', blob_hash: 'h2', current_path: 'notes/b.md' }),
      match({ version_id: 'v3', file_id: 'f1', blob_hash: 'h3' })
    ]);

    expect(result.groups).toHaveLength(2);
    expect(result.groups[0]?.fileId).toBe('f1');
    expect(result.groups[0]?.matches).toHaveLength(2);
    expect(result.totalMatches).toBe(3);
  });

  it('collapses identical repeated content inside one file', () => {
    const result = groupMatches([
      match({ version_id: 'v1', blob_hash: 'same' }),
      match({ version_id: 'v2', blob_hash: 'same' }),
      match({ version_id: 'v3', blob_hash: 'different' })
    ]);

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]?.matches.map((entry) => entry.versionId)).toEqual(['v1', 'v3']);
  });

  it('puts the current version first within a file', () => {
    const result = groupMatches([
      match({ version_id: 'old', blob_hash: 'h1', captured_at: 10 }),
      match({ version_id: 'cur', blob_hash: 'h2', captured_at: 5, is_current: 1 })
    ]);

    expect(result.groups[0]?.matches[0]?.versionId).toBe('cur');
    expect(result.groups[0]?.matches[0]?.isCurrent).toBe(true);
  });

  it('orders historical matches newest first', () => {
    const result = groupMatches([
      match({ version_id: 'a', blob_hash: 'h1', captured_at: 100 }),
      match({ version_id: 'b', blob_hash: 'h2', captured_at: 300 }),
      match({ version_id: 'c', blob_hash: 'h3', captured_at: 200 })
    ]);

    expect(result.groups[0]?.matches.map((entry) => entry.versionId)).toEqual(['b', 'c', 'a']);
  });

  it('carries the deleted status through so the UI can offer recovery', () => {
    const result = groupMatches([match({ file_status: 'deleted' })]);
    expect(result.groups[0]?.fileStatus).toBe('deleted');
  });
});
