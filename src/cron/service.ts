import type { FsStat, NewOwner } from '../fs/types.ts';
import { type KernelFs, normalizePath } from '../fs/types.ts';
import { PathGate } from '../fs/unlinked.ts';
import type { Account } from '../users.ts';
import { type CronClock, systemCronClock } from './clock.ts';
import { missedFires, nextFire } from './schedule.ts';
import { type CronJob, parseCrontab, SPOOL_DIR, SYSTEM_CRONTAB } from './table.ts';

export const CRON_DIR = '/var/spool/cron';
export const STAMP_PATH = `${CRON_DIR}/stamp`;
export const LOG_DIR = '/var/log/cron';
export const ERR_LOG = `${LOG_DIR}/cron.err`;
export const LOG_CAP = 256 * 1024;
export const JOBS_PER_USER = 16;
export const WAKE_MS = 60_000;
export const BACK_JUMP_MS = 120_000;
export const DEFAULT_SHELL = '/bin/bash';

export interface CronLocks {
  request(
    name: string,
    options: { signal?: AbortSignal },
    callback: () => Promise<void>
  ): Promise<unknown>;
}

export interface CronRun {
  account: Account;
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  output: (bytes: Uint8Array) => void;
}

export interface CronHost {
  fs: KernelFs;
  owners: boolean;
  lock: string;
  bootId: string;
  clock?: CronClock;
  locks?: CronLocks | undefined;
  ready?: () => Promise<unknown>;
  lookup(name: string): Promise<Account | undefined>;
  watch(paths: string[], notify: () => void): Promise<() => void>;
  run(job: CronRun): Promise<{ status: number; signal?: string }>;
}

interface Loaded {
  source: string;
  account: Account;
  job: CronJob;
}

interface Stamp {
  jobs: Record<string, number>;
  reboot: Record<string, string>;
}

interface Due {
  entry: Loaded;
  due: number;
  missed: number;
}

const encoder = new TextEncoder();

const messageOf = (err: unknown) => (err as Error)?.message ?? String(err);

const keyOf = ({ source, job }: Loaded) => `${source}\t${job.id}`;

function tail(bytes: Uint8Array, cap = LOG_CAP): Uint8Array {
  return bytes.length > cap ? bytes.slice(bytes.length - cap) : bytes;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

class Output {
  private parts: Uint8Array[] = [];
  private size = 0;

  push(bytes: Uint8Array): void {
    this.parts.push(bytes.slice());
    this.size += bytes.length;
    if (this.size > LOG_CAP * 2) {
      const kept = tail(concat(this.parts));
      this.parts = [kept];
      this.size = kept.length;
    }
  }

  bytes(): Uint8Array {
    return tail(concat(this.parts));
  }
}

function readStamp(text: string | undefined): Stamp {
  try {
    const parsed = JSON.parse(text ?? '') as Partial<Stamp>;
    const jobs = parsed.jobs && typeof parsed.jobs === 'object' ? parsed.jobs : {};
    const reboot = parsed.reboot && typeof parsed.reboot === 'object' ? parsed.reboot : {};
    return { jobs: { ...jobs }, reboot: { ...reboot } };
  } catch {
    return { jobs: {}, reboot: {} };
  }
}

export class CronService {
  private readonly host: CronHost;
  private readonly clock: CronClock;
  private readonly stopping = new AbortController();
  private readonly gate = new PathGate();
  private readonly running = new Map<number, number>();
  private readonly reported = new Map<string, string>();
  private wake = new AbortController();
  private started: Promise<void> | undefined;
  private rebooted = false;

  constructor(host: CronHost) {
    this.host = host;
    this.clock = host.clock ?? systemCronClock;
  }

  start(): Promise<void> {
    this.started ??= this.begin();
    return this.started;
  }

  stop(): void {
    this.stopping.abort();
    this.wake.abort();
  }

  private async begin(): Promise<void> {
    await this.host.ready?.().catch(() => undefined);
    if (this.stopping.signal.aborted) return;
    const { locks } = this.host;
    const fire = () =>
      this.fire().catch((err: unknown) => {
        console.warn(`slicc-kernel cron: stopped: ${messageOf(err)}`);
      });
    if (!locks) return fire();
    await locks
      .request(this.host.lock, { signal: this.stopping.signal }, fire)
      .catch(() => undefined);
  }

  private poke = () => this.wake.abort();

  private async fire(): Promise<void> {
    await this.provision();
    const unwatch = await this.host.watch([SYSTEM_CRONTAB, SPOOL_DIR], this.poke);
    try {
      while (!this.stopping.signal.aborted) await this.pass();
    } finally {
      unwatch();
    }
  }

  private async pass(): Promise<void> {
    let until: number;
    try {
      until = await this.tick();
    } catch (err) {
      await this.error(`cron: ${messageOf(err)}`);
      until = this.clock.now() + WAKE_MS;
    }
    if (this.stopping.signal.aborted) return;
    if (this.wake.signal.aborted) this.wake = new AbortController();
    await this.clock.sleep(until, this.wake.signal);
  }

  private async provision(): Promise<void> {
    const { fs, owners } = this.host;
    for (const [dir, mode] of [
      [CRON_DIR, 0o755],
      [SPOOL_DIR, 0o700],
      [LOG_DIR, 0o755],
    ] as const) {
      if (await fs.exists(dir)) continue;
      await fs.mkdir(dir, { recursive: true });
      if (owners) await fs.chown?.(dir, { uid: 0, gid: 0, mode, follow: false });
    }
  }

  private async tick(): Promise<number> {
    const { fs } = this.host;
    const loaded = await this.load();
    const stamp = readStamp(await fs.readFile(STAMP_PATH).catch(() => undefined));
    const now = this.clock.now();
    const utc = this.clock.utc === true;
    const due: Due[] = [];
    const keys = new Set<string>();
    let next = now + WAKE_MS;
    for (const entry of loaded) {
      const key = keyOf(entry);
      keys.add(key);
      const { when } = entry.job;
      if (when.reboot) {
        if (this.rebooted || stamp.reboot[key] === this.host.bootId) continue;
        stamp.reboot[key] = this.host.bootId;
        due.push({ entry, due: now, missed: 0 });
        continue;
      }
      const last = stamp.jobs[key];
      if (typeof last !== 'number' || last > now + BACK_JUMP_MS) stamp.jobs[key] = now;
      else {
        const missed = missedFires(when.schedule, last, now, utc);
        if (missed.last !== null) {
          stamp.jobs[key] = now;
          due.push({ entry, due: missed.last, missed: missed.count - 1 });
        }
      }
      const coming = nextFire(when.schedule, Math.max(now, stamp.jobs[key] as number), utc);
      if (coming !== null && coming < next) next = coming;
    }
    this.rebooted = true;
    for (const map of [stamp.jobs, stamp.reboot])
      for (const key of Object.keys(map)) if (!keys.has(key)) delete map[key];
    await this.writeStamp(stamp);
    for (const each of due) void this.spawn(each);
    return next;
  }

  private async writeStamp(stamp: Stamp): Promise<void> {
    const { fs, owners } = this.host;
    const text = JSON.stringify(stamp);
    if ((await fs.readFile(STAMP_PATH).catch(() => undefined)) === text) return;
    const fresh = `${STAMP_PATH}.new`;
    const owner: NewOwner | undefined = owners ? { uid: 0, gid: 0, mode: 0o600 } : undefined;
    await fs.writeFile(fresh, text, owner);
    await fs.rename(fresh, STAMP_PATH);
  }

  private async load(): Promise<Loaded[]> {
    const { fs } = this.host;
    const out: Loaded[] = [];
    const system = await this.table(SYSTEM_CRONTAB, 0, true);
    for (const job of system?.jobs ?? []) {
      const account = await this.host.lookup(job.user as string);
      if (account) out.push({ source: 'system', account, job });
    }
    const names = await fs.readdir(SPOOL_DIR).catch(() => [] as string[]);
    for (const name of names.sort()) {
      if (name.startsWith('.') || name.endsWith('~') || name.endsWith('.new')) continue;
      const path = `${SPOOL_DIR}/${name}`;
      const account = await this.host.lookup(name);
      if (!account) {
        await this.once(path, 'no user', [`${path}: skipped: there is no user ${name}`]);
        continue;
      }
      const table = await this.table(path, account.uid, false);
      for (const job of table?.jobs ?? []) out.push({ source: name, account, job });
    }
    return out;
  }

  private async table(path: string, uid: number, system: boolean) {
    const { fs, owners } = this.host;
    const st = await fs.lstat(path).catch(() => undefined);
    if (!st) {
      this.reported.delete(path);
      return undefined;
    }
    const trusted =
      st.isFile && (!owners || ((st.uid === uid || st.uid === 0) && (st.mode & 0o022) === 0));
    if (!trusted) {
      const who = uid === 0 ? 'root' : 'its user or root';
      const why = `${path}: skipped: it must be a file of ${who}, writable by its owner only`;
      await this.once(path, 'untrusted', [why]);
      return undefined;
    }
    const text = await fs.readFile(path).catch(() => '');
    const table = parseCrontab(text, path, system);
    const errors = table.errors.map(({ line, message }) => `${path}:${line}: ${message}`);
    for (const job of table.jobs) {
      if (job.user !== undefined && !(await this.host.lookup(job.user)))
        errors.push(`${path}:${job.line}: there is no user ${job.user}`);
    }
    await this.once(path, text, errors);
    return table;
  }

  private async once(path: string, version: string, lines: string[]): Promise<void> {
    if (this.reported.get(path) === version) return;
    this.reported.set(path, version);
    for (const line of lines) await this.error(line);
  }

  private async error(line: string): Promise<void> {
    if (this.stopping.signal.aborted) return;
    const stamp = new Date(this.clock.now()).toISOString();
    await this.append(ERR_LOG, encoder.encode(`${stamp} ${line}\n`), 0, 0).catch(() => undefined);
  }

  private async append(path: string, bytes: Uint8Array, uid: number, gid: number) {
    const { fs, owners } = this.host;
    await this.gate.run(path, async () => {
      const dir = path.slice(0, path.lastIndexOf('/'));
      if (!(await fs.lstat(dir).catch(() => undefined))) {
        await fs.mkdir(dir, { recursive: true });
        if (owners) await fs.chown?.(dir, { uid: 0, gid: 0, mode: 0o755, follow: false });
      }
      const st = await fs.lstat(path).catch(() => undefined);
      if (owners) await this.trustLog(dir, path, st, uid);
      const old = st ? await fs.readFileBuffer(path) : undefined;
      const next = tail(old ? concat([old, bytes]) : bytes);
      const owner: NewOwner | undefined = owners ? { uid, gid, mode: 0o600 } : undefined;
      await fs.writeFile(path, next, old === undefined ? owner : undefined);
    });
  }

  private async trustLog(dir: string, path: string, st: FsStat | undefined, uid: number) {
    const parent = await this.host.fs.lstat(dir);
    if (!parent.isDirectory || parent.isSymbolicLink || parent.uid !== 0)
      throw new Error(`${path} not written: ${dir} must be a directory of root`);
    if (st && (!st.isFile || st.isSymbolicLink || (st.uid !== uid && st.uid !== 0)))
      throw new Error(`${path} not written: it must be a file of uid ${uid} or root`);
  }

  private logOf({ account, job }: Loaded): string {
    return normalizePath(`${LOG_DIR}/${account.name}/${job.id}.log`);
  }

  private async spawn({ entry, due, missed }: Due): Promise<void> {
    const { account, job } = entry;
    const log = this.logOf(entry);
    const iso = new Date(due).toISOString();
    const count = this.running.get(account.uid) ?? 0;
    if (count >= JOBS_PER_USER) {
      const why = `${JOBS_PER_USER} cron jobs of ${account.name} are running`;
      await this.append(
        log,
        encoder.encode(`--- ${iso} skipped: ${why} ---\n`),
        account.uid,
        account.gid
      ).catch((err: unknown) => this.error(messageOf(err)));
      await this.error(`${account.name}/${job.id}: run due ${iso} skipped: ${why}`);
      return;
    }
    this.running.set(account.uid, count + 1);
    const output = new Output();
    let ended: { status: number; signal?: string };
    try {
      const cwd = (await this.host.fs.exists(account.home)) ? account.home : '/';
      const shell = job.env.SHELL ?? DEFAULT_SHELL;
      ended = await this.host.run({
        account,
        argv: [shell, '-c', job.command],
        cwd,
        env: {
          SHELL: shell,
          ...job.env,
          SLICC_CRON: '1',
          SLICC_CRON_JOB: job.id,
          SLICC_CRON_DUE: iso,
          SLICC_CRON_MISSED: String(missed),
        },
        output: (bytes) => output.push(bytes),
      });
    } catch (err) {
      output.push(encoder.encode(`cron: ${messageOf(err)}\n`));
      ended = { status: 127 };
    } finally {
      this.running.set(account.uid, (this.running.get(account.uid) ?? 1) - 1);
    }
    if (this.stopping.signal.aborted) return;
    const exit = ended.signal ? `signal=${ended.signal}` : `exit=${ended.status}`;
    const header = encoder.encode(`--- ${iso} ${exit} missed=${missed} ---\n`);
    const body = output.bytes();
    const newline =
      body.length > 0 && body[body.length - 1] !== 10 ? encoder.encode('\n') : new Uint8Array();
    await this.append(log, concat([header, body, newline]), account.uid, account.gid).catch(
      (err: unknown) => this.error(messageOf(err))
    );
  }
}
