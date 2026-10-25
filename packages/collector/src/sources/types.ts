import type { BillingMode, Provider, UsageSource } from '../../../shared/src/index.ts';
import type { Store } from '../store.ts';

export interface ScanStats {
  roots: string[];
  files: number;
  filesRead: number;
  bytesRead: number;
  usageRows: number;
  changedEvents: number;
  malformedLines: number;
}

export interface SourceContext {
  /** Extra directories per provider, from `tokenburn config add-dir`. */
  extraDirs: Partial<Record<Provider, string[]>>;
  billingOverrides: Partial<Record<Provider, BillingMode>>;
}

/** A device-scoped source that reads files on this machine. */
export interface LocalSource {
  usageSource: UsageSource;
  provider: Provider;
  label: string;
  roots(ctx: SourceContext): string[];
  billing(ctx: SourceContext): { mode: BillingMode; basis: string };
  /** Incremental: only new or changed data is parsed. `onlyFiles` limits the scan (from file-watch events). */
  scan(store: Store, ctx: SourceContext, onlyFiles?: string[]): ScanStats;
  /** File extensions whose changes should trigger a rescan in watch mode. */
  watchExtensions: string[];
}
