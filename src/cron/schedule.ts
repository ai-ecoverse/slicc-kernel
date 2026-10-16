export interface Schedule {
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
    minutes,
    hours,
    days,
    months,
    weekdays,
    anyDay: parts[2] === '*',
    anyWeekday: parts[4] === '*',
  };
}

export function parseWhen(expression: string): When {
  if (expression.trim().toLowerCase() === '@reboot') return { reboot: true };
  return { reboot: false, schedule: parseSchedule(expression) };
}

interface Calendar {
  year(d: Date): number;
  month(d: Date): number;
  date(d: Date): number;
  day(d: Date): number;
  hours(d: Date): number;
  minutes(d: Date): number;
  setMonth(d: Date, month: number): void;
  setDate(d: Date, date: number): void;
  setHours(d: Date, hours: number): void;
  setMinutes(d: Date, minutes: number): void;
}

const LOCAL: Calendar = {
  year: (d) => d.getFullYear(),
  month: (d) => d.getMonth(),
  date: (d) => d.getDate(),
  day: (d) => d.getDay(),
  hours: (d) => d.getHours(),
  minutes: (d) => d.getMinutes(),
  setMonth: (d, month) => d.setMonth(month, 1),
  setDate: (d, date) => d.setDate(date),
  setHours: (d, hours) => d.setHours(hours, 0, 0, 0),
  setMinutes: (d, minutes) => d.setMinutes(minutes, 0, 0),
};

const UTC: Calendar = {
  year: (d) => d.getUTCFullYear(),
  month: (d) => d.getUTCMonth(),
  date: (d) => d.getUTCDate(),
  day: (d) => d.getUTCDay(),
  hours: (d) => d.getUTCHours(),
  minutes: (d) => d.getUTCMinutes(),
  setMonth: (d, month) => d.setUTCMonth(month, 1),
  setDate: (d, date) => d.setUTCDate(date),
  setHours: (d, hours) => d.setUTCHours(hours, 0, 0, 0),
  setMinutes: (d, minutes) => d.setUTCMinutes(minutes, 0, 0),
};

function dayMatches(schedule: Schedule, cal: Calendar, date: Date): boolean {
  const day = schedule.days.has(cal.date(date));
  const weekday = schedule.weekdays.has(cal.day(date));
  if (schedule.anyDay) return weekday;
  if (schedule.anyWeekday) return day;
  return day || weekday;
}

const LIMIT_YEARS = 8;

export function nextFire(schedule: Schedule, after: number, utc = false): number | null {
  const cal = utc ? UTC : LOCAL;
  const date = new Date(Math.floor(after / 60_000) * 60_000 + 60_000);
  const limit = cal.year(date) + LIMIT_YEARS;
  while (cal.year(date) <= limit) {
    if (!schedule.months.has(cal.month(date) + 1)) {
      cal.setMonth(date, cal.month(date) + 1);
      cal.setHours(date, 0);
    } else if (!dayMatches(schedule, cal, date)) {
      cal.setDate(date, cal.date(date) + 1);
      cal.setHours(date, 0);
    } else if (!schedule.hours.has(cal.hours(date))) {
      cal.setHours(date, cal.hours(date) + 1);
    } else if (!schedule.minutes.has(cal.minutes(date))) {
      cal.setMinutes(date, cal.minutes(date) + 1);
    } else return date.getTime();
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
  utc = false,
  cap = MISSED_CAP
): Missed {
  let count = 0;
  let last: number | null = null;
  let at: number | null = from;
  while (count < cap) {
    at = nextFire(schedule, at, utc);
    if (at === null || at > until) return { count, last, more: false };
    last = at;
    count++;
  }
  const next = nextFire(schedule, last as number, utc);
  return { count, last, more: next !== null && next <= until };
}
