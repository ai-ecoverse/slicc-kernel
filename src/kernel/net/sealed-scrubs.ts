import type { Scrubber } from '@ai-ecoverse/slicc-scrub';
import { type ScrubSecret, scrubberOf } from '../scrub-file.ts';

interface Entry {
  secrets: ScrubSecret[];
  version: number;
  scrubber: Scrubber | undefined;
}

export interface SessionScrub {
  version: number;
  scrubber: Scrubber;
}

export class SessionScrubs {
  private readonly by = new Map<string, Entry>();

  private static key(pid: number, host: string): string {
    return `${pid}\0${host}`;
  }

  add(pid: number, host: string, secrets: readonly ScrubSecret[]): void {
    const key = SessionScrubs.key(pid, host);
    const entry = this.by.get(key) ?? { secrets: [], version: 0, scrubber: undefined };
    const fresh = secrets.filter((s) => !entry.secrets.some((e) => e.value === s.value));
    if (fresh.length === 0) return;
    entry.secrets = [...entry.secrets, ...fresh];
    entry.version += 1;
    entry.scrubber = undefined;
    this.by.set(key, entry);
  }

  of(pid: number, host: string): SessionScrub | undefined {
    const entry = this.by.get(SessionScrubs.key(pid, host));
    if (!entry) return undefined;
    entry.scrubber ??= scrubberOf(entry.secrets);
    return entry.scrubber ? { version: entry.version, scrubber: entry.scrubber } : undefined;
  }

  drop(pid: number): void {
    for (const key of [...this.by.keys()]) if (key.startsWith(`${pid}\0`)) this.by.delete(key);
  }
}
