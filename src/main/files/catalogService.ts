/**
 * Read-side catalog for the file list, a single file, and skipped-file reports.
 *
 * The IPC router talks to this service instead of reaching into repositories, so vault
 * scoping stays in one place.
 */
import type { ListFilesRequest } from '@shared/contracts/ipc';
import type { FileSummary, SkippedFileReport, TrackedFile } from '@shared/types/domain';
import type { Store } from '../storage/store';

export class CatalogService {
  constructor(
    private readonly store: Store,
    private readonly activeVaultId: () => string | null
  ) {}

  list(request: ListFilesRequest): FileSummary[] {
    const vaultId = this.activeVaultId();
    if (!vaultId) return [];
    return this.store.files.list(
      vaultId,
      request.filter,
      request.query,
      request.limit ?? 500,
      request.offset ?? 0
    );
  }

  byId(fileId: string): TrackedFile | null {
    return this.store.files.byId(fileId);
  }

  skipped(): SkippedFileReport[] {
    const vaultId = this.activeVaultId();
    return vaultId ? this.store.skipped.list(vaultId) : [];
  }
}
