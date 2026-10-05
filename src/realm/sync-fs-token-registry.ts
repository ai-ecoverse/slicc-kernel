import type { KernelFs } from '../fs/types.ts';

export interface SyncFsTokenEntry {
  fs: KernelFs;
  cwd: string;
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
