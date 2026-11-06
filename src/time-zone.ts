export const MINUTE_MS = 60_000;

const HOUR_MS = 60 * MINUTE_MS;
const BUCKET_MS = 15 * MINUTE_MS;
const CACHE_MAX = 4096;
const ZERO = new Set(['UTC', 'Etc/UTC', 'Etc/GMT', 'GMT', 'Etc/Universal', 'Etc/Zulu']);

export interface Zone {
  readonly name: string;
  offset(at: number): number;
}

export function canonicalZone(name: unknown): string | undefined {
  if (typeof name !== 'string' || name === '' || name.length > 64) return undefined;
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: name }).resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

export function hostTimeZone(): string {
  let name: string | undefined;
  try {
    name = new Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    name = undefined;
  }
  return canonicalZone(name) ?? 'UTC';
}

export function systemTimeZone(given: string | undefined, fallback?: string): string {
  if (given !== undefined) {
    const zone = canonicalZone(given);
    if (zone === undefined) throw new Error(`not a time zone: ${String(given)}`);
    return zone;
  }
  return canonicalZone(fallback) ?? hostTimeZone();
}

export const utcZone: Zone = { name: 'UTC', offset: () => 0 };

function hostZone(name: string): Zone {
  return { name, offset: (at) => -new Date(at).getTimezoneOffset() * MINUTE_MS };
}

function intlZone(name: string): Zone {
  const format = new Intl.DateTimeFormat('en-US', {
    timeZone: name,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  });
  const exact = (at: number): number => {
    const parts: Record<string, number> = {};
    for (const part of format.formatToParts(at)) parts[part.type] = Number(part.value);
    const wall = Date.UTC(
      parts.year as number,
      (parts.month as number) - 1,
      parts.day as number,
      parts.hour as number,
      parts.minute as number,
      parts.second as number
    );
    return wall - Math.floor(at / 1000) * 1000;
  };
  const buckets = new Map<number, number | null>();
  return {
    name,
    offset(at) {
      const bucket = Math.floor(at / BUCKET_MS);
      let known = buckets.get(bucket);
      if (known === undefined) {
        const start = exact(bucket * BUCKET_MS);
        known = start === exact(bucket * BUCKET_MS + BUCKET_MS - MINUTE_MS) ? start : null;
        if (buckets.size >= CACHE_MAX) buckets.clear();
        buckets.set(bucket, known);
      }
      return known ?? exact(at);
    },
  };
}

const zones = new Map<string, Zone>();

export function zoneOf(name: string): Zone {
  if (ZERO.has(name)) return utcZone;
  if (name === hostTimeZone()) return hostZone(name);
  let zone = zones.get(name);
  if (!zone) {
    zone = intlZone(name);
    zones.set(name, zone);
  }
  return zone;
}

export const MAX_SHIFT_MS = 3 * HOUR_MS;
