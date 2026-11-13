import { lookedOutside } from '../../realm/sync-sab-bridge.ts';
import type { EmContext } from './context.ts';
import { putString } from './layout.ts';

const TZ_GROUPS: ReadonlyArray<readonly [string, Readonly<Record<string, string | number>>]> = [
  [
    'Europe/London Europe/Belfast Europe/Guernsey Europe/Isle_of_Man Europe/Jersey GB GB-Eire',
    { '0': 'GMT', d3600: 'BST' },
  ],
  ['Europe/Dublin Eire', { '0': 'GMT', d3600: 'IST' }],
  [
    'Europe/Lisbon Portugal Atlantic/Madeira Atlantic/Canary Atlantic/Faroe Atlantic/Faeroe WET',
    { '0': 'WET', d3600: 'WEST' },
  ],
  [
    'Europe/Amsterdam Europe/Andorra Europe/Belgrade Europe/Berlin Europe/Bratislava Europe/Brussels Europe/Budapest Europe/Busingen Europe/Copenhagen Europe/Gibraltar Europe/Ljubljana Europe/Luxembourg Europe/Madrid Europe/Malta Europe/Monaco Europe/Oslo Europe/Paris Europe/Podgorica Europe/Prague Europe/Rome Europe/San_Marino Europe/Sarajevo Europe/Skopje Europe/Stockholm Europe/Tirane Europe/Vaduz Europe/Vatican Europe/Vienna Europe/Warsaw Europe/Zagreb Europe/Zurich Africa/Ceuta Africa/Algiers Africa/Tunis Arctic/Longyearbyen Atlantic/Jan_Mayen Poland CET MET',
    { '3600': 'CET', d7200: 'CEST' },
  ],
  [
    'Europe/Athens Europe/Bucharest Europe/Chisinau Europe/Helsinki Europe/Kiev Europe/Kyiv Europe/Mariehamn Europe/Riga Europe/Sofia Europe/Tallinn Europe/Tiraspol Europe/Uzhgorod Europe/Vilnius Europe/Zaporozhye Europe/Nicosia Europe/Kaliningrad Asia/Beirut Asia/Nicosia Africa/Cairo Egypt EET',
    { '7200': 'EET', d10800: 'EEST' },
  ],
  ['Europe/Moscow Europe/Simferopol Europe/Kirov Europe/Volgograd W-SU', { '10800': 'MSK' }],
  ['Asia/Jerusalem Asia/Tel_Aviv Israel', { '7200': 'IST', d10800: 'IDT' }],
  ['Asia/Kolkata Asia/Calcutta', { '19800': 'IST' }],
  ['Asia/Karachi', { '18000': 'PKT', d21600: 'PKST', since: 31536000 }],
  ['Asia/Tokyo Japan', { '32400': 'JST', d36000: 'JDT' }],
  ['Asia/Seoul Asia/Pyongyang ROK', { '32400': 'KST', d36000: 'KDT' }],
  [
    'Asia/Shanghai Asia/Chongqing Asia/Chungking Asia/Harbin Asia/Taipei Asia/Macau Asia/Macao PRC ROC',
    { '28800': 'CST', d32400: 'CDT' },
  ],
  ['Asia/Manila', { '28800': 'PST', d32400: 'PDT' }],
  ['Asia/Hong_Kong Hongkong', { '28800': 'HKT', d32400: 'HKST' }],
  ['Asia/Jakarta Asia/Pontianak', { '25200': 'WIB' }],
  ['Asia/Makassar Asia/Ujung_Pandang', { '28800': 'WITA' }],
  ['Asia/Jayapura', { '32400': 'WIT' }],
  [
    'Australia/Sydney Australia/Melbourne Australia/Hobart Australia/Canberra Australia/ACT Australia/NSW Australia/Victoria Australia/Tasmania Australia/Currie Australia/Brisbane Australia/Lindeman Australia/Queensland Antarctica/Macquarie',
    { '36000': 'AEST', d39600: 'AEDT' },
  ],
  [
    'Australia/Adelaide Australia/Broken_Hill Australia/South Australia/Yancowinna Australia/Darwin Australia/North',
    { '34200': 'ACST', d37800: 'ACDT' },
  ],
  ['Australia/Perth Australia/West', { '28800': 'AWST', d32400: 'AWDT' }],
  [
    'Pacific/Auckland Antarctica/McMurdo Antarctica/South_Pole NZ',
    { '43200': 'NZST', d46800: 'NZDT' },
  ],
  ['Pacific/Guam Pacific/Saipan', { '36000': 'ChST', since: 977493600 }],
  ['Africa/Windhoek', { '7200': 'CAT', since: 637365600 }],
  ['Asia/Gaza Asia/Hebron', { '7200': 'EET', d10800: 'EEST', since: 820454400 }],
  ['Pacific/Pago_Pago Pacific/Midway Pacific/Samoa US/Samoa', { '-39600': 'SST' }],
  ['America/Adak America/Atka US/Aleutian', { '-36000': 'HST', 'd-32400': 'HDT' }],
  [
    'America/Hermosillo America/Mazatlan America/Chihuahua America/Ciudad_Juarez America/Ojinaga America/Dawson America/Whitehorse Mexico/BajaSur Canada/Yukon',
    { '-25200': 'MST', 'd-21600': 'MDT', intl: 1 },
  ],
  ['America/Havana Cuba', { '-18000': 'CST', 'd-14400': 'CDT' }],
  [
    'Etc/GMT Etc/GMT0 Etc/GMT+0 Etc/GMT-0 Etc/Greenwich GMT GMT0 GMT+0 GMT-0 Greenwich',
    { '0': 'GMT' },
  ],
  ['Antarctica/Troll', { '0': '+00', d7200: '+02' }],
  ['America/St_Johns Canada/Newfoundland', { '-12600': 'NST', 'd-9000': 'NDT' }],
  ['Africa/Johannesburg Africa/Maseru Africa/Mbabane', { '7200': 'SAST' }],
  [
    'Africa/Maputo Africa/Blantyre Africa/Bujumbura Africa/Gaborone Africa/Harare Africa/Kigali Africa/Lubumbashi Africa/Lusaka',
    { '7200': 'CAT' },
  ],
  ['Africa/Juba Africa/Khartoum', { '7200': 'CAT', '10800': 'EAT' }],
  [
    'Africa/Nairobi Africa/Addis_Ababa Africa/Asmara Africa/Asmera Africa/Dar_es_Salaam Africa/Djibouti Africa/Kampala Africa/Mogadishu Indian/Antananarivo Indian/Comoro Indian/Mayotte',
    { '10800': 'EAT' },
  ],
  [
    'Africa/Lagos Africa/Bangui Africa/Brazzaville Africa/Douala Africa/Kinshasa Africa/Libreville Africa/Luanda Africa/Malabo Africa/Niamey Africa/Porto-Novo Africa/Ndjamena',
    { '3600': 'WAT' },
  ],
];

let tzTable: Map<string, Readonly<Record<string, string | number>>> | undefined;

function zones(): Map<string, Readonly<Record<string, string | number>>> {
  if (tzTable) return tzTable;
  const table = new Map<string, Readonly<Record<string, string | number>>>();
  for (const [names, labels] of TZ_GROUPS) {
    for (const zone of names.split(' ')) table.set(zone, labels);
  }
  tzTable = table;
  return table;
}

const lows = new Map<string, [number, number]>();

const MONTH = 2629800;

function tzIntl(zone: string, t: number): { value: number; label: string } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    timeZoneName: 'short',
  });
  const at = (s: number): { off: number; name: string } => {
    const parts: Record<string, string> = {};
    for (const p of fmt.formatToParts(new Date(s * 1000))) parts[p.type] = p.value;
    const wall =
      Date.UTC(
        Number(parts.year),
        Number(parts.month) - 1,
        Number(parts.day),
        Number(parts.hour),
        Number(parts.minute),
        Number(parts.second)
      ) / 1000;
    return { off: Math.round(wall - s), name: parts.timeZoneName ?? '' };
  };
  const now = at(t);
  const canon = fmt.resolvedOptions().timeZone;
  const names = zones().get(zone) ?? zones().get(canon);
  const key = `${zone}|${Math.floor(t / 86400)}`;
  let low = lows.get(key);
  if (!low) {
    low = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
    for (let m = 1; m <= 12; m++) {
      low[0] = Math.min(low[0], at(t - m * MONTH).off);
      low[1] = Math.min(low[1], at(t + m * MONTH).off);
    }
    if (lows.size > 4096) lows.clear();
    lows.set(key, low);
  }
  const dst = now.off > low[0] && now.off > low[1] ? 1 : 0;
  const since = names?.since;
  const fixed =
    names && !(typeof since === 'number' && t < since)
      ? names[`${dst ? 'd' : ''}${now.off}`]
      : undefined;
  const fixedLabel = typeof fixed === 'string' ? fixed : undefined;
  let label =
    fixedLabel && !names?.intl
      ? fixedLabel
      : /^[A-Za-z]{3,5}$/.test(now.name)
        ? now.name
        : fixedLabel;
  if (!label) {
    const a = Math.abs(now.off);
    const hh = String(Math.floor(a / 3600)).padStart(2, '0');
    const mm = Math.floor(a / 60) % 60;
    label = `${now.off < 0 ? '-' : '+'}${hh}${mm ? String(mm).padStart(2, '0') : ''}`;
  }
  return { value: now.off * 2 + dst, label };
}

const LEAP = [0, 31, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335];
const REGULAR = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];

function leap(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function yday(date: Date): number {
  const table = leap(date.getFullYear()) ? LEAP : REGULAR;
  return (table[date.getMonth()] as number) + date.getDate() - 1;
}

function i53(value: bigint): number {
  return value < -9007199254740992n || value > 9007199254740992n ? Number.NaN : Number(value);
}

function zoneName(offset: number): string {
  const sign = offset >= 0 ? '-' : '+';
  const abs = Math.abs(offset);
  return `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}${String(abs % 60).padStart(2, '0')}`;
}

export function timeImports(ctx: EmContext): WebAssembly.ModuleImports {
  const { mem } = ctx;
  const i32 = (at: number) => mem.view().getInt32(at, true);
  const put = (at: number, value: number) => mem.view().setInt32(at, value, true);
  return {
    emscripten_date_now: () => {
      lookedOutside();
      return Date.now();
    },
    emscripten_get_now: () => {
      lookedOutside();
      return performance.now();
    },
    _tzset_js: (timezone: number, daylight: number, std: number, dst: number) => {
      const year = new Date().getFullYear();
      const winter = new Date(year, 0, 1).getTimezoneOffset();
      const summer = new Date(year, 6, 1).getTimezoneOffset();
      mem.view().setUint32(timezone, Math.max(winter, summer) * 60, true);
      put(daylight, Number(winter !== summer));
      const winterName = zoneName(winter);
      const summerName = zoneName(summer);
      if (summer < winter) {
        putString(mem, std, winterName, 17);
        putString(mem, dst, summerName, 17);
      } else {
        putString(mem, dst, winterName, 17);
        putString(mem, std, summerName, 17);
      }
    },
    _localtime_js: (time: bigint, tm: number) => {
      const date = new Date(i53(time) * 1000);
      put(tm, date.getSeconds());
      put(tm + 4, date.getMinutes());
      put(tm + 8, date.getHours());
      put(tm + 12, date.getDate());
      put(tm + 16, date.getMonth());
      put(tm + 20, date.getFullYear() - 1900);
      put(tm + 24, date.getDay());
      put(tm + 28, yday(date) | 0);
      put(tm + 36, -(date.getTimezoneOffset() * 60));
      const summer = new Date(date.getFullYear(), 6, 1).getTimezoneOffset();
      const winter = new Date(date.getFullYear(), 0, 1).getTimezoneOffset();
      const isDst =
        summer !== winter && date.getTimezoneOffset() === Math.min(winter, summer) ? 1 : 0;
      put(tm + 32, isDst);
    },
    _gmtime_js: (time: bigint, tm: number) => {
      const date = new Date(i53(time) * 1000);
      put(tm, date.getUTCSeconds());
      put(tm + 4, date.getUTCMinutes());
      put(tm + 8, date.getUTCHours());
      put(tm + 12, date.getUTCDate());
      put(tm + 16, date.getUTCMonth());
      put(tm + 20, date.getUTCFullYear() - 1900);
      put(tm + 24, date.getUTCDay());
      const start = Date.UTC(date.getUTCFullYear(), 0, 1, 0, 0, 0, 0);
      put(tm + 28, ((date.getTime() - start) / 86400000) | 0);
    },
    _mktime_js: (tm: number) => {
      const date = new Date(
        i32(tm + 20) + 1900,
        i32(tm + 16),
        i32(tm + 12),
        i32(tm + 8),
        i32(tm + 4),
        i32(tm),
        0
      );
      const dst = i32(tm + 32);
      const guessed = date.getTimezoneOffset();
      const start = new Date(date.getFullYear(), 0, 1);
      const summer = new Date(date.getFullYear(), 6, 1).getTimezoneOffset();
      const winter = start.getTimezoneOffset();
      const dstOffset = Math.min(winter, summer);
      if (dst < 0) {
        put(tm + 32, Number(summer !== winter && dstOffset === guessed));
      } else if (dst > 0 !== (dstOffset === guessed)) {
        const nonDst = Math.max(winter, summer);
        const trueOffset = dst > 0 ? dstOffset : nonDst;
        date.setTime(date.getTime() + (trueOffset - guessed) * 60000);
      }
      put(tm + 24, date.getDay());
      put(tm + 28, yday(date) | 0);
      put(tm, date.getSeconds());
      put(tm + 4, date.getMinutes());
      put(tm + 8, date.getHours());
      put(tm + 12, date.getDate());
      put(tm + 16, date.getMonth());
      put(tm + 20, date.getFullYear() - 1900);
      const ms = date.getTime();
      return BigInt(Number.isNaN(ms) ? -1 : Math.trunc(ms / 1000));
    },
    _timegm_js: (tm: number) => {
      const time = Date.UTC(
        i32(tm + 20) + 1900,
        i32(tm + 16),
        i32(tm + 12),
        i32(tm + 8),
        i32(tm + 4),
        i32(tm),
        0
      );
      const date = new Date(time);
      put(tm + 24, date.getUTCDay());
      const start = Date.UTC(date.getUTCFullYear(), 0, 1, 0, 0, 0, 0);
      put(tm + 28, ((date.getTime() - start) / 86400000) | 0);
      return BigInt(Math.trunc(date.getTime() / 1000));
    },
    slicc_tz_intl: (name: number, t: number, abbr: number, abbrlen: number) => {
      try {
        const { value, label } = tzIntl(mem.cString(name), t);
        if (abbr) putString(mem, abbr, label, abbrlen);
        return value;
      } catch {
        return 0x7fffffff;
      }
    },
  };
}
