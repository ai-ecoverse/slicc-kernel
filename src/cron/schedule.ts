import { MAX_SHIFT_MS, MINUTE_MS, utcZone as UTC_ZONE, type Zone } from '../time-zone.ts';

export interface Schedule {
  fixed: boolean;
  minutes: ReadonlySet<number>;
  hours: ReadonlySet<number>;
  days: ReadonlySet<number>;
  months: ReadonlySet<number>;
  weekdays: ReadonlySet<number>;
  anyDay: boolean;
  anyWeekday: boolean;
}

export type When = { reboot: true } | { reboot: false; schedule: Schedule };

export const MISSED_CAP = 100_000;

const MACROS: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

interface Field {
  name: string;
  min: number;
  max: number;
  names?: string[];
  offset?: number;
}

const FIELDS: Field[] = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12, names: MONTHS, offset: 1 },
  { name: 'day of week', min: 0, max: 7, names: WEEKDAYS },
];

function value(text: string, field: Field): number {
  const named = field.names?.indexOf(text.toLowerCase()) ?? -1;
  if (named >= 0) return named + (field.offset ?? 0);
  if (!/^\d+$/.test(text)) throw new Error(`${field.name}: "${text}" is not a number`);
  const number = Number(text);
  if (number < field.min || number > field.max)
    throw new Error(`${field.name}: ${number} is outside ${field.min}-${field.max}`);
  return number;
}

function range(part: string, field: Field): [number, number] {
  if (part === '*') return [field.min, field.max];
  const [from, to, extra] = part.split('-');
  if (extra !== undefined) throw new Error(`${field.name}: "${part}" is not a range`);
  const start = value(from as string, field);
  const end = to === undefined ? start : value(to, field);
  if (end < start) throw new Error(`${field.name}: range ${part} runs backwards`);
  return [start, end];
}

function step(text: string | undefined, field: Field): number {
  if (text === undefined) return 1;
  if (!/^\d+$/.test(text) || Number(text) === 0)
    throw new Error(`${field.name}: step "${text}" must be a positive number`);
  return Number(text);
}

function field(text: string, spec: Field): Set<number> {
  const out = new Set<number>();
  for (const part of text.split(',')) {
    if (part === '') throw new Error(`${spec.name}: empty list item`);
    const [base, every, extra] = part.split('/');
    if (extra !== undefined) throw new Error(`${spec.name}: "${part}" has two steps`);
    const [start, end] = range(base as string, spec);
    const stride = step(every, spec);
    const last = every !== undefined && !(base as string).includes('-') ? spec.max : end;
    for (let n = start; n <= last; n += stride) out.add(n);
  }
  return out;
}

export function parseSchedule(expression: string): Schedule {
  const trimmed = expression.trim();
  const text = MACROS[trimmed.toLowerCase()] ?? trimmed;
  if (text.startsWith('@')) throw new Error(`unknown schedule ${trimmed}`);
  const parts = text.split(/\s+/);
  if (parts.length !== 5)
    throw new Error(
      `"${trimmed}" needs 5 fields (minute hour day month weekday), not ${parts.length}`
    );
  const [minutes, hours, days, months, weekdays] = parts.map((part, at) =>
    field(part, FIELDS[at] as Field)
  ) as [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>];
  if (weekdays.delete(7)) weekdays.add(0);
  return {
    fixed: !(parts[0] as string).startsWith('*') && !(parts[1] as string).startsWith('*'),
    minutes,
    hours,
    days,
    months,
    weekdays,
    anyDay: (parts[2] as string).startsWith('*'),
    anyWeekday: (parts[4] as string).startsWith('*'),
  };
}

export function parseWhen(expression: string): When {
  if (expression.trim().toLowerCase() === '@reboot') return { reboot: true };
  return { reboot: false, schedule: parseSchedule(expression) };
}

const UTC = {
  year: (d: Date) => d.getUTCFullYear(),
  month: (d: Date) => d.getUTCMonth(),
  date: (d: Date) => d.getUTCDate(),
  day: (d: Date) => d.getUTCDay(),
  hours: (d: Date) => d.getUTCHours(),
  minutes: (d: Date) => d.getUTCMinutes(),
  setMonth: (d: Date, month: number) => d.setUTCMonth(month, 1),
  setDate: (d: Date, date: number) => d.setUTCDate(date),
  setHours: (d: Date, hours: number) => d.setUTCHours(hours, 0, 0, 0),
  setMinutes: (d: Date, minutes: number) => d.setUTCMinutes(minutes, 0, 0),
};

function dayMatches(schedule: Schedule, date: Date): boolean {
  const day = schedule.days.has(UTC.date(date));
  const weekday = schedule.weekdays.has(UTC.day(date));
  if (schedule.anyDay || schedule.anyWeekday) return day && weekday;
  return day || weekday;
}

const LIMIT_YEARS = 8;
const LIMIT_MS = (LIMIT_YEARS + 1) * 366 * 24 * 60 * MINUTE_MS;
const SCAN_MS = 6 * 60 * MINUTE_MS;

function nextWall(schedule: Schedule, from: number): number | null {
  const date = new Date(Math.ceil(from / MINUTE_MS) * MINUTE_MS);
  const limit = UTC.year(date) + LIMIT_YEARS;
  while (UTC.year(date) <= limit) {
    if (!schedule.months.has(UTC.month(date) + 1)) {
      UTC.setMonth(date, UTC.month(date) + 1);
      UTC.setHours(date, 0);
    } else if (!dayMatches(schedule, date)) {
      UTC.setDate(date, UTC.date(date) + 1);
      UTC.setHours(date, 0);
    } else if (!schedule.hours.has(UTC.hours(date))) {
      UTC.setHours(date, UTC.hours(date) + 1);
    } else if (!schedule.minutes.has(UTC.minutes(date))) {
      UTC.setMinutes(date, UTC.minutes(date) + 1);
    } else return date.getTime();
  }
  return null;
}

function firstChange(zone: Zone, from: number, to: number, offset: number): number {
  let lo = from;
  let hi = to;
  for (let at = from + SCAN_MS; at < to; at += SCAN_MS) {
    if (zone.offset(at) !== offset) {
      hi = at;
      break;
    }
    lo = at;
  }
  while (hi - lo > MINUTE_MS) {
    const mid = lo + Math.floor((hi - lo) / 2 / MINUTE_MS) * MINUTE_MS;
    if (zone.offset(mid) === offset) lo = mid;
    else hi = mid;
  }
  return hi;
}

function afterRepeat(zone: Zone, at: number): number {
  const offset = zone.offset(at);
  const earlier = zone.offset(at - MAX_SHIFT_MS);
  if (earlier <= offset) return at;
  const shift = firstChange(zone, at - MAX_SHIFT_MS, at, earlier);
  const end = shift + (earlier - zone.offset(shift));
  return Math.max(at, end);
}

export function nextFire(schedule: Schedule, after: number, zone: Zone = UTC_ZONE): number | null {
  let at = Math.floor(after / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  const limit = at + LIMIT_MS;
  while (at <= limit) {
    if (schedule.fixed) {
      const end = afterRepeat(zone, at);
      if (end > at) {
        at = end;
        continue;
      }
    }
    const offset = zone.offset(at);
    const before = zone.offset(at - MINUTE_MS);
    if (schedule.fixed && before < offset && offset - before <= MAX_SHIFT_MS) {
      const skipped = nextWall(schedule, at + before);
      if (skipped !== null && skipped < at + offset) return at;
    }
    const wall = nextWall(schedule, at + offset);
    if (wall === null) return null;
    const found = at + (wall - (at + offset));
    const change = firstChange(zone, at, found, offset);
    if (change >= found && zone.offset(found) === offset) return found;
    at = change;
  }
  return null;
}

export interface Missed {
  count: number;
  last: number | null;
  more: boolean;
}

export function missedFires(
  schedule: Schedule,
  from: number,
  until: number,
  zone: Zone = UTC_ZONE,
  cap = MISSED_CAP
): Missed {
  let count = 0;
  let last: number | null = null;
  let at: number | null = from;
  while (count < cap) {
    at = nextFire(schedule, at, zone);
    if (at === null || at > until) return { count, last, more: false };
    last = at;
    count++;
  }
  const next = nextFire(schedule, last as number, zone);
  if (next === null || next > until) return { count, last, more: false };
  return { count, last: latestFire(schedule, last as number, until, zone), more: true };
}

export function latestFire(
  schedule: Schedule,
  from: number,
  until: number,
  zone: Zone = UTC_ZONE
): number {
  let found = from;
  for (let span = 60_000; ; span *= 2) {
    const start = Math.max(from, until - span);
    const first = nextFire(schedule, start, zone);
    if (first !== null && first <= until) {
      found = first;
      break;
    }
    if (start === from) return from;
  }
  for (let at = nextFire(schedule, found, zone); at !== null && at <= until; ) {
    found = at;
    at = nextFire(schedule, at, zone);
  }
  return found;
}
