import type { KernelFs } from '../fs/types.ts';
import type { KeptFile } from '../fs/unlinked.ts';

export interface SyncFsTokenEntry {
  fs: KernelFs;
  cwd: string;
  statfs?: (path: string) => Promise<{ quota: number; usage: number } | undefined>;
  hold?: (path: string, held: boolean, open: boolean, real?: string) => void;
  gate?: <T>(path: string, op: () => Promise<T>) => Promise<T>;
  unlinked?: (path: string) => KeptFile | undefined;
  own?: <T>(path: string, op: () => Promise<T>) => Promise<T>;
  revoked?: (path: string) => boolean;
  renamed?: (from: string, to: string) => void;
}

const registry = new Map<string, SyncFsTokenEntry>();

export function mintSyncFsToken(entry: SyncFsTokenEntry): string {
  const token = crypto.randomUUID();
  registry.set(token, entry);
  return token;
}

export function resolveSyncFsToken(token: string): SyncFsTokenEntry | null {
  return registry.get(token) ?? null;
}

export function revokeSyncFsToken(token: string): void {
  registry.delete(token);
}
