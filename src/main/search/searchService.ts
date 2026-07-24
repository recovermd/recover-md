/**
 * Historical search (FR-9).
 *
 * Lexical, not semantic. Results are grouped by logical file so a note that changed fifty
 * times does not push everything else off the page, and identical repeated content inside
 * one file collapses to its earliest occurrence.
 */
import { SEARCH_PAGE_SIZE } from '@shared/constants';
import type {
  FileStatus,
  SearchMatch,
  SearchQuery,
  SearchResultGroup,
  SearchResults
} from '@shared/types/domain';
import { decodeUtf8 } from '../vault/text';
import { basenameOf } from '../vault/paths';
import type { RawSearchMatchTyped } from '../storage/repositories/searchRepository';
import type { Store } from '../storage/store';
import type { Logger } from '../logging/logger';
import { parseSearchQuery } from './queryParser';

export interface GroupedResult {
  groups: SearchResultGroup[];
  totalMatches: number;
}

/**
 * Groups raw matches by file, preserving relevance order across groups.
 * Exported separately from the database so it can be unit tested directly.
 */
export function groupMatches(matches: readonly RawSearchMatchTyped[]): GroupedResult {
  const groups = new Map<string, SearchResultGroup>();
  const seenContent = new Map<string, Set<string>>();
  let total = 0;

  for (const match of matches) {
    const blobKey = match.blob_hash ?? `v:${match.version_id}`;
    const seen = seenContent.get(match.file_id) ?? new Set<string>();
    if (seen.has(blobKey)) continue; // identical duplicate versions must not flood results
    seen.add(blobKey);
    seenContent.set(match.file_id, seen);

    const entry: SearchMatch = {
      versionId: match.version_id,
      fileId: match.file_id,
      filename: basenameOf(match.path),
      path: match.path,
      snippet: match.snippet,
      capturedAt: match.captured_at,
      eventType: match.event_type,
      isCurrent: match.is_current === 1,
      fileStatus: match.file_status as FileStatus
    };

    const existing = groups.get(match.file_id);
    if (existing) {
      existing.matches.push(entry);
    } else {
      groups.set(match.file_id, {
        fileId: match.file_id,
        currentPath: match.current_path,
        fileStatus: match.file_status as FileStatus,
        matches: [entry]
      });
    }
    total += 1;
  }

  // Within a file: the current version first, then newest history (FR-9).
  for (const group of groups.values()) {
    group.matches.sort((a, b) => {
      if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
      return b.capturedAt - a.capturedAt;
    });
  }

  return { groups: [...groups.values()], totalMatches: total };
}

export class SearchService {
  constructor(
    private readonly store: Store,
    private readonly logger: Logger
  ) {}

  search(query: SearchQuery): SearchResults {
    const parsed = parseSearchQuery(query.text);
    if (!parsed.expression) {
      return { groups: [], totalMatches: 0, hasMore: false };
    }

    const limit = query.limit ?? SEARCH_PAGE_SIZE;
    const offset = query.offset ?? 0;

    let rows: RawSearchMatchTyped[];
    try {
      rows = this.store.search.search({
        matchExpression: parsed.expression,
        scope: query.scope,
        fromDate: query.fromDate ?? null,
        toDate: query.toDate ?? null,
        // Over-fetch by one so "has more" is accurate after de-duplication.
        limit: limit + 1,
        offset
      });
    } catch (error) {
      this.logger.warn('Search failed', {
        error: error instanceof Error ? error.message : String(error)
      });
      return { groups: [], totalMatches: 0, hasMore: false };
    }

    const hasMore = rows.length > limit;
    const grouped = groupMatches(rows.slice(0, limit));
    return { groups: grouped.groups, totalMatches: grouped.totalMatches, hasMore };
  }

  /**
   * Rebuilds the derived index from stored versions (FR-9, FR-11). History is untouched:
   * this can be run at any time to recover from a damaged index.
   */
  async rebuildIndex(onProgress?: (done: number) => void): Promise<{ indexedVersions: number }> {
    if (this.store.safeMode) return { indexedVersions: 0 };

    this.store.settings.setSearchIndexStale(true);
    this.store.db.transaction(() => this.store.search.clear());

    let indexed = 0;
    for (const batch of this.store.versions.iterateAll(200)) {
      const prepared: {
        versionId: string;
        fileId: string;
        filename: string;
        path: string;
        content: string | null;
      }[] = [];

      for (const version of batch) {
        // Tombstones point at the previous version's blob; indexing them would duplicate it.
        if (version.eventType === 'delete' || !version.blobHash) {
          prepared.push({
            versionId: version.id,
            fileId: version.fileId,
            filename: basenameOf(version.path),
            path: version.path,
            content: null
          });
          continue;
        }
        const bytes = await this.store.blobs.get(version.blobHash).catch(() => null);
        prepared.push({
          versionId: version.id,
          fileId: version.fileId,
          filename: basenameOf(version.path),
          path: version.path,
          content: bytes ? decodeUtf8(bytes) : null
        });
      }

      this.store.db.transaction(() => {
        for (const entry of prepared) this.store.search.index(entry);
      });
      indexed += prepared.length;
      onProgress?.(indexed);
    }

    this.store.settings.setSearchIndexStale(false);
    this.logger.info('Search index rebuilt', { versions: indexed });
    return { indexedVersions: indexed };
  }
}
