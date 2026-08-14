/**
 * Periodic reconcile/disk-space checks and the daily backup clock.
 *
 * Extracted from the vault coordinator so lifecycle timers are not mixed with capture
 * wiring.
 */
export interface VaultTimerHandlers {
  onPeriodic: () => void;
  onBackup: () => void;
}

export class VaultTimers {
  private periodic: ReturnType<typeof setInterval> | null = null;
  private backup: ReturnType<typeof setInterval> | null = null;

  start(periodicMs: number, backupMs: number, handlers: VaultTimerHandlers): void {
    this.stop();
    this.periodic = setInterval(handlers.onPeriodic, periodicMs);
    this.periodic.unref?.();
    this.backup = setInterval(handlers.onBackup, backupMs);
    this.backup.unref?.();
  }

  stop(): void {
    if (this.periodic) clearInterval(this.periodic);
    if (this.backup) clearInterval(this.backup);
    this.periodic = null;
    this.backup = null;
  }
}
