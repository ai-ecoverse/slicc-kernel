import { permits, R_OK, W_OK } from '../fs/access.ts';
import { deny, type Guard } from '../fs/dac.ts';
import type { UsersMode } from '../fs/types.ts';
import { embedderFailure, interruptible, lineOf } from './embedder.ts';
import { KernelError, type OpenAccess, OpenFile, type PollState } from './fd-table.ts';
import {
  IOCTL,
  SERIAL_CFLAG,
  SERIAL_LFLAG,
  SERIAL_OFLAG,
  type SerialSettings,
  type SerialTermios,
  sameSettings,
  settingsOf,
  speedsOf,
  TIOCM,
} from './serial-ioctl.ts';
import { defaultTermios, KernelTty, type Termios } from './tty.ts';

export const DEVICE_NAME = /^tty(USB|ACM)(\d{1,3})$/;
export const BY_ID = '/dev/serial/by-id';
const LINK_NAME = /^[A-Za-z0-9._:+@=,-]{1,255}$/;
const MAJORS: Readonly<Record<string, number>> = { USB: 188, ACM: 166 };
const HIGH_WATER = 64 * 1024;
const CLOSING_WAIT_MS = 30_000;
const BREAK_MS = 250;
const MAX_ID = 4294967294;
const DEFAULT_SETTINGS = settingsOf(SERIAL_CFLAG, 9600);

export interface DeviceSignals {
  clearToSend: boolean;
  dataCarrierDetect: boolean;
  dataSetReady: boolean;
  ringIndicator: boolean;
}

export interface DeviceStreams {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  control(op: string, args?: object): unknown;
}

export interface DeviceStamp {
  pid: number;
  uid: number;
  gid: number;
  groups: number[];
  users: UsersMode;
  tag?: string;
  tags?: string[];
}

export interface DeviceOpenRequest {
  path: string;
  flags: number;
  stamp: DeviceStamp;
  signal: AbortSignal;
}

export interface DeviceHook {
  open(request: DeviceOpenRequest): DeviceStreams | Promise<DeviceStreams>;
}

export interface DeviceSpec {
  path: string;
  owner?: string | number;
  group?: string | number;
  mode?: number;
  links?: readonly string[];
}

export interface DeviceNodeInfo {
  path: string;
  uid: number;
  gid: number;
  mode: number;
  major: number;
  minor: number;
  links: string[];
  atimeMs: number;
  mtimeMs: number;
  ctimeMs: number;
}

export interface DeviceMetaChange {
  mode?: number;
  uid?: number;
  gid?: number;
  atimeMs?: number | null;
  mtimeMs?: number | null;
  now?: boolean;
}

export interface DeviceLookup {
  userId(name: string): Promise<number | undefined>;
  groupId(name: string): Promise<number | undefined>;
}

interface DeviceState {
  termios: Termios;
  ispeed: number;
  ospeed: number;
}

interface DeviceNode extends DeviceNodeInfo {
  id: number;
  client: number;
  channel?: DeviceChannel;
  opening: boolean;
  saved?: DeviceState;
}

export interface DeviceOpener {
  stamp: DeviceStamp;
  guard?: Guard;
  signal: AbortSignal;
}

function refused(code: 'EINVAL' | 'EEXIST' | 'ENOTSUP', text: string): Error & { code: string } {
  return Object.assign(new Error(`${code}: ${text}`), { code });
}

function invalid(what: string): Error {
  return refused('EINVAL', what);
}

function nodePath(path: unknown): { path: string; major: number; minor: number } {
  if (typeof path !== 'string') throw invalid('path must be a string');
  const name = path.startsWith('/dev/') ? path.slice(5) : path;
  const m = DEVICE_NAME.exec(name);
  const minor = Number(m?.[2]);
  if (!m || minor > 255) throw invalid(`not a serial device name: ${path}`);
  return { path: `/dev/${name}`, major: MAJORS[m[1] as string] as number, minor };
}

function linkPath(link: unknown): string {
  if (typeof link !== 'string') throw invalid('a link must be a string');
  const name = link.startsWith(`${BY_ID}/`) ? link.slice(BY_ID.length + 1) : link;
  if (!LINK_NAME.test(name) || name === '.' || name === '..')
    throw invalid(`not a link name: ${link}`);
  return `${BY_ID}/${name}`;
}

function modeOf(mode: unknown): number {
  if (mode === undefined) return 0o600;
  if (!Number.isInteger(mode) || (mode as number) < 0 || (mode as number) > 0o7777)
    throw invalid('mode must be permission bits');
  return mode as number;
}

async function idOf(
  value: string | number | undefined,
  find: (name: string) => Promise<number | undefined>
): Promise<number> {
  if (value === undefined) return 0;
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0 || value > MAX_ID) throw invalid(`bad id ${value}`);
    return value;
  }
  const id = typeof value === 'string' ? await find(value) : undefined;
  if (id === undefined) throw invalid(`unknown owner or group ${String(value)}`);
  return id;
}

function quiet(): undefined {
  return undefined;
}

function want(access: OpenAccess): number {
  return access === 'read' ? R_OK : access === 'write' ? W_OK : R_OK | W_OK;
}

export function devicesHook(hook: DeviceHook): DeviceHook {
  if (typeof hook?.open !== 'function') throw new TypeError('devices needs open');
  return { open: (request) => hook.open(request) };
}

function checkMeta(
  node: DeviceNode,
  change: DeviceMetaChange,
  uid: number,
  gid: number,
  guard: Guard
): void {
  const { cred } = guard;
  const owner = cred.euid === 0 || cred.euid === node.uid;
  const member = cred.egid === gid || cred.groups.includes(gid);
  const chown = uid !== node.uid || gid !== node.gid;
  const times = (change.atimeMs ?? change.mtimeMs ?? null) !== null;
  if (change.mode !== undefined && !owner) deny(guard, 'chmod', node.path, 'EPERM');
  if (chown && cred.euid !== 0 && (uid !== node.uid || !owner || !member))
    deny(guard, 'chown', node.path, 'EPERM');
  if (times && !owner && !(change.now && permits(cred, node, W_OK, false)))
    deny(guard, 'utimes', node.path, change.now ? 'EACCES' : 'EPERM');
}

export class DeviceNodes {
  private readonly hooks = new Map<number, DeviceHook>();
  private readonly nodes = new Map<string, DeviceNode>();
  private readonly links = new Map<string, DeviceNode>();
  private readonly lookup: DeviceLookup;
  readonly users: UsersMode;
  private next = 0;

  constructor(users: UsersMode, lookup: DeviceLookup) {
    this.users = users;
    this.lookup = lookup;
  }

  register(client: number, hook: DeviceHook): () => void {
    this.hooks.set(client, hook);
    return () => {
      if (this.hooks.get(client) !== hook) return;
      this.hooks.delete(client);
      for (const node of [...this.nodes.values()]) if (node.client === client) this.drop(node);
    };
  }

  async add(spec: DeviceSpec, client: number): Promise<number> {
    if (typeof spec !== 'object' || spec === null) throw invalid('add needs a spec');
    const { path, major, minor } = nodePath(spec.path);
    const mode = modeOf(spec.mode);
    if (spec.links !== undefined && !Array.isArray(spec.links))
      throw invalid('links must be a list');
    const links = (spec.links ?? []).map(linkPath);
    const uid = await idOf(spec.owner, (name) => this.lookup.userId(name));
    const gid = await idOf(spec.group, (name) => this.lookup.groupId(name));
    if (!this.hooks.has(client)) throw refused('ENOTSUP', 'this client has no devices hook');
    if (this.nodes.has(path)) throw refused('EEXIST', `${path} exists`);
    const taken = links.find((l, i) => this.links.has(l) || links.indexOf(l) !== i);
    if (taken !== undefined) throw refused('EEXIST', `${taken} exists`);
    const node: DeviceNode = {
      id: ++this.next,
      client,
      path,
      uid,
      gid,
      mode,
      major,
      minor,
      links,
      opening: false,
      atimeMs: Date.now(),
      mtimeMs: Date.now(),
      ctimeMs: Date.now(),
    };
    this.nodes.set(path, node);
    for (const link of links) this.links.set(link, node);
    return node.id;
  }

  remove(id: number): boolean {
    const node = [...this.nodes.values()].find((n) => n.id === id);
    if (!node) return false;
    this.drop(node);
    return true;
  }

  private drop(node: DeviceNode): void {
    this.nodes.delete(node.path);
    for (const link of node.links) this.links.delete(link);
    node.channel?.lost(new KernelError('EIO', `${node.path} was removed`));
  }

  list(): DeviceNodeInfo[] {
    return [...this.nodes.values()]
      .sort((a, b) => (a.path < b.path ? -1 : 1))
      .map(({ path, uid, gid, mode, major, minor, links, atimeMs, mtimeMs, ctimeMs }) => ({
        path,
        uid,
        gid,
        mode,
        major,
        minor,
        links: [...links],
        atimeMs,
        mtimeMs,
        ctimeMs,
      }));
  }

  meta(path: string, change: DeviceMetaChange, guard?: Guard): void {
    const node = this.find(path);
    if (!node) throw new KernelError('ENOENT');
    const uid = change.uid === undefined || change.uid === -1 ? node.uid : change.uid >>> 0;
    const gid = change.gid === undefined || change.gid === -1 ? node.gid : change.gid >>> 0;
    if (guard) checkMeta(node, change, uid, gid, guard);
    const now = Date.now();
    if (change.mode !== undefined) node.mode = change.mode & 0o7777;
    node.uid = uid;
    node.gid = gid;
    const at = (ms: number | null | undefined, kept: number): number =>
      ms === undefined || ms === null ? kept : change.now ? now : ms;
    node.atimeMs = at(change.atimeMs, node.atimeMs);
    node.mtimeMs = at(change.mtimeMs, node.mtimeMs);
    node.ctimeMs = now;
    if (node.channel) node.channel.tty.owner = { uid: node.uid, gid: node.gid, mode: node.mode };
  }

  find(path: string): DeviceNode | undefined {
    return this.nodes.get(path) ?? this.links.get(path);
  }

  openTty(path: string): KernelTty | undefined {
    return this.nodes.get(path)?.channel?.tty;
  }

  async open(path: string, flags: number, opener: DeviceOpener): Promise<OpenFile> {
    const node = this.find(path);
    if (!node) throw new KernelError('ENOENT');
    const access: OpenAccess = (flags & 3) === 0 ? 'read' : (flags & 3) === 1 ? 'write' : 'both';
    if (opener.guard && !permits(opener.guard.cred, node, want(access), false))
      deny(opener.guard, 'open', node.path);
    if (node.channel || node.opening) throw new KernelError('EBUSY');
    const hook = this.hooks.get(node.client) as DeviceHook;
    node.opening = true;
    const asked = Promise.resolve().then(() =>
      hook.open({ path: node.path, flags: flags & 3, stamp: opener.stamp, signal: opener.signal })
    );
    let streams: DeviceStreams;
    try {
      streams = await interruptible(asked, opener.signal);
    } catch (err) {
      if (err instanceof KernelError && err.code === 'EINTR') {
        void asked.then(abandon, quiet).finally(() => (node.opening = false));
      } else node.opening = false;
      throw embedderFailure(err);
    }
    node.opening = false;
    if (!isStreams(streams)) throw new KernelError('EIO', 'the devices hook gave no streams');
    if (this.nodes.get(node.path) !== node) {
      void abandon(streams);
      throw new KernelError('ENOENT');
    }
    const channel = new DeviceChannel(node.path, streams, node.saved, (saved) => {
      node.saved = saved;
      if (node.channel === channel) delete node.channel;
    });
    channel.tty.owner = { uid: node.uid, gid: node.gid, mode: node.mode };
    node.channel = channel;
    try {
      await channel.restore();
    } catch (err) {
      await channel.close();
      throw err;
    }
    return channel.file(access);
  }
}

function isStreams(value: unknown): value is DeviceStreams {
  const s = value as Partial<DeviceStreams> | null;
  return (
    !!s &&
    s.readable instanceof ReadableStream &&
    s.writable instanceof WritableStream &&
    typeof s.control === 'function'
  );
}

async function abandon(streams: DeviceStreams): Promise<void> {
  if (!isStreams(streams)) return;
  await streams.readable.cancel('closed').catch(quiet);
  await streams.writable.abort('closed').catch(quiet);
  await Promise.resolve()
    .then(() => streams.control('close'))
    .catch(quiet);
}

function serialTermios(): SerialTermios {
  const base = defaultTermios();
  return {
    c_iflag: 0,
    c_oflag: SERIAL_OFLAG,
    c_cflag: SERIAL_CFLAG,
    c_lflag: SERIAL_LFLAG,
    c_cc: base.c_cc,
  };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return interruptible(new Promise<void>((resolve) => setTimeout(resolve, ms)), signal);
}

export class DeviceChannel {
  readonly tty: KernelTty;
  readonly path: string;
  private readonly inner: OpenFile;
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  private readonly streams: DeviceStreams;
  private readonly onClosed: (state: DeviceState) => void;
  private readonly gone = Promise.withResolvers<never>();
  private failure: KernelError | undefined;
  private readonly pending = new Set<Promise<void>>();
  private queued = 0;
  private resume: (() => void) | undefined;
  private waiters: Array<() => void> = [];
  private closed = false;
  ispeed = 9600;
  ospeed = 9600;
  dtr = true;
  rts = true;

  constructor(
    path: string,
    streams: DeviceStreams,
    saved: DeviceState | undefined,
    onClosed: (state: DeviceState) => void
  ) {
    this.path = path;
    this.streams = streams;
    this.onClosed = onClosed;
    this.gone.promise.catch(quiet);
    this.tty = new KernelTty({ write: (bytes) => this.send(bytes) }, quiet);
    this.tty.name = path;
    this.tty.setSize(0, 0);
    this.tty.tcsets(saved?.termios ?? serialTermios());
    if (saved) {
      this.ispeed = saved.ispeed;
      this.ospeed = saved.ospeed;
      this.dtr = this.rts = saved.ospeed !== 0;
    }
    this.inner = this.tty.file();
    this.reader = streams.readable.getReader();
    this.writer = streams.writable.getWriter();
    void this.pump();
  }

  file(access: OpenAccess): OpenFile {
    return new OpenFile({
      ...(access === 'write' ? {} : { read: (max, signal) => this.read(max, signal) }),
      ...(access === 'read' ? {} : { write: (bytes, signal) => this.write(bytes, signal) }),
      poll: () => this.poll(),
      changed: (signal) => this.changed(signal),
      close: () => this.close(),
      tty: this.tty,
      device: this,
    });
  }

  lost(err: KernelError): void {
    if (this.failure) return;
    this.failure = err;
    this.gone.reject(err);
    this.tty.hangup();
    this.wake();
  }

  private control(op: string, args?: object): Promise<unknown> {
    return Promise.resolve().then(() => this.streams.control(op, args));
  }

  private buffered(): number {
    return this.inner.file.poll?.().nread ?? 0;
  }

  private async pump(): Promise<void> {
    for (;;) {
      while (this.buffered() >= HIGH_WATER && !this.closed && !this.failure) {
        await new Promise<void>((resolve) => {
          this.resume = resolve;
        });
      }
      if (this.closed || this.failure) return;
      let got: ReadableStreamReadResult<Uint8Array>;
      try {
        got = await this.reader.read();
      } catch (err) {
        if (!this.closed) this.lost(new KernelError('EIO', lineOf(err)));
        return;
      }
      if (got.done) {
        this.tty.hangup();
        this.wake();
        return;
      }
      this.tty.receive(got.value);
      this.wake();
    }
  }

  private send(bytes: Uint8Array): void {
    if (this.closed || this.failure) return;
    const n = bytes.length;
    this.queued += n;
    const sent = this.writer.write(bytes.slice()).catch((err: unknown) => {
      this.lost(new KernelError('EIO', lineOf(err)));
    });
    const tracked = sent.finally(() => {
      this.queued -= n;
      this.pending.delete(tracked);
      this.wake();
    });
    this.pending.add(tracked);
  }

  private check(): void {
    if (this.failure) throw this.failure;
  }

  private async read(max: number, signal?: AbortSignal): Promise<Uint8Array> {
    this.check();
    const read = this.inner.file.read as NonNullable<OpenFile['file']['read']>;
    const got = await read(max, signal);
    this.resume?.();
    this.resume = undefined;
    if (got.length === 0) this.check();
    return got;
  }

  private async ready(signal?: AbortSignal): Promise<void> {
    this.check();
    try {
      await interruptible(Promise.race([this.writer.ready, this.gone.promise]), signal);
    } catch (err) {
      if (err instanceof KernelError) throw err;
      throw new KernelError('EIO', lineOf(err));
    }
  }

  private async write(bytes: Uint8Array, signal?: AbortSignal): Promise<number> {
    this.check();
    if (!((this.writer.desiredSize ?? 0) > 0)) await this.ready(signal);
    const write = this.inner.file.write as NonNullable<OpenFile['file']['write']>;
    return write(bytes, signal);
  }

  private poll(): PollState {
    if (this.failure)
      return { readable: true, writable: true, hangup: true, error: true, nread: 0 };
    const inner = this.inner.file.poll?.() as PollState;
    const writable = (this.writer.desiredSize ?? 0) > 0;
    return { ...inner, writable };
  }

  private changed(signal?: AbortSignal): Promise<void> {
    const mine = new Promise<void>((resolve) => this.waiters.push(resolve));
    const theirs = this.inner.file.changed?.(signal) as Promise<void>;
    return interruptible(Promise.race([mine, theirs]), signal);
  }

  private wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve();
  }

  async drain(signal?: AbortSignal): Promise<void> {
    while (this.pending.size > 0) {
      this.check();
      await interruptible(
        Promise.race([Promise.all([...this.pending]), this.gone.promise]),
        signal
      );
    }
    this.check();
  }

  async restore(): Promise<void> {
    const settings = this.settings();
    if (settings.baudRate === 0)
      return this.signals({ dataTerminalReady: false, requestToSend: false });
    if (sameSettings(settings, DEFAULT_SETTINGS)) return;
    try {
      await this.control('configure', settings);
    } catch (err) {
      throw embedderFailure(err);
    }
  }

  settings(): SerialSettings {
    return settingsOf(this.tty.tcgets().c_cflag, this.ospeed);
  }

  termios(): SerialTermios {
    return { ...this.tty.tcgets(), c_ispeed: this.ispeed, c_ospeed: this.ospeed };
  }

  async setTermios(
    termios: SerialTermios,
    how: { drain?: boolean; flush?: boolean; extended?: boolean },
    signal?: AbortSignal
  ): Promise<void> {
    this.check();
    if (how.drain) await this.drain(signal);
    const before = this.settings();
    const old = { termios: this.tty.tcgets(), ispeed: this.ispeed, ospeed: this.ospeed };
    const speeds = speedsOf(termios, this, how.extended === true);
    this.tty.tcsets(termios, how.flush === true);
    this.ispeed = speeds.ispeed;
    this.ospeed = speeds.ospeed;
    try {
      if (speeds.ospeed === 0) await this.setModem(this.bits() & ~(TIOCM.DTR | TIOCM.RTS));
      else {
        if (!sameSettings(before, this.settings()))
          await this.control('configure', this.settings());
        if (old.ospeed === 0) await this.setModem(this.bits() | TIOCM.DTR | TIOCM.RTS);
      }
      if (how.flush) await this.control('flush', { input: true, output: false });
    } catch (err) {
      this.tty.tcsets(old.termios);
      this.ispeed = old.ispeed;
      this.ospeed = old.ospeed;
      throw embedderFailure(err);
    }
  }

  private bits(): number {
    return (this.dtr ? TIOCM.DTR : 0) | (this.rts ? TIOCM.RTS : 0);
  }

  async modem(): Promise<number> {
    this.check();
    const s = (await this.control('signals').catch((err: unknown) => {
      throw embedderFailure(err);
    })) as Partial<DeviceSignals> | null;
    return (
      this.bits() |
      (s?.clearToSend ? TIOCM.CTS : 0) |
      (s?.dataSetReady ? TIOCM.DSR : 0) |
      (s?.dataCarrierDetect ? TIOCM.CD : 0) |
      (s?.ringIndicator ? TIOCM.RI : 0)
    );
  }

  async setModem(bits: number): Promise<void> {
    this.check();
    const dataTerminalReady = (bits & TIOCM.DTR) !== 0;
    const requestToSend = (bits & TIOCM.RTS) !== 0;
    await this.signals({ dataTerminalReady, requestToSend });
    this.dtr = dataTerminalReady;
    this.rts = requestToSend;
  }

  private async signals(args: object): Promise<void> {
    try {
      await this.control('setSignals', args);
    } catch (err) {
      throw embedderFailure(err);
    }
  }

  async sendBreak(ms: number, signal?: AbortSignal): Promise<void> {
    await this.drain(signal);
    await this.signals({ break: true });
    try {
      await sleep(ms, signal);
    } finally {
      await this.signals({ break: false });
    }
  }

  async flush(input: boolean, output: boolean): Promise<void> {
    this.check();
    if (input) this.tty.tcsets(this.tty.tcgets(), true);
    try {
      await this.control('flush', { input, output });
    } catch (err) {
      throw embedderFailure(err);
    }
  }

  async ioctl(request: number, arg: unknown, signal?: AbortSignal): Promise<unknown> {
    this.check();
    switch (request) {
      case IOCTL.TCGETS:
      case IOCTL.TCGETS2:
        return this.termios();
      case IOCTL.TCSETS:
      case IOCTL.TCSETSW:
      case IOCTL.TCSETSF:
      case IOCTL.TCSETS2:
      case IOCTL.TCSETSW2:
      case IOCTL.TCSETSF2: {
        const extended = request > 0xffff;
        const kind = (request & 0xff) - (extended ? 0x2b : 0x02);
        await this.setTermios(
          arg as SerialTermios,
          { drain: kind > 0, flush: kind === 2, extended },
          signal
        );
        return null;
      }
      case IOCTL.TIOCMGET:
        return this.modem();
      case IOCTL.TIOCMSET:
        await this.setModem(Number(arg));
        return null;
      case IOCTL.TIOCMBIS:
        await this.setModem(this.bits() | Number(arg));
        return null;
      case IOCTL.TIOCMBIC:
        await this.setModem(this.bits() & ~Number(arg));
        return null;
      case IOCTL.TIOCSBRK:
      case IOCTL.TIOCCBRK:
        await this.signals({ break: request === IOCTL.TIOCSBRK });
        return null;
      case IOCTL.TCSBRK:
        if (Number(arg) === 0) await this.sendBreak(BREAK_MS, signal);
        else await this.drain(signal);
        return null;
      case IOCTL.TCSBRKP:
        await this.sendBreak(Number(arg) > 0 ? Number(arg) * 100 : BREAK_MS, signal);
        return null;
      case IOCTL.TCFLSH: {
        const queue = Number(arg);
        if (queue < 0 || queue > 2) throw new KernelError('EINVAL');
        await this.flush(queue !== 1, queue !== 0);
        return null;
      }
      case IOCTL.FIONREAD:
        return this.buffered();
      case IOCTL.TIOCOUTQ:
        return this.queued;
      case IOCTL.TIOCEXCL:
      case IOCTL.TIOCNXCL:
        return null;
      case IOCTL.TIOCGWINSZ: {
        const [rows, cols] = this.tty.winsize();
        return { rows, cols };
      }
      case IOCTL.TIOCSWINSZ: {
        const size = arg as { rows: number; cols: number };
        this.tty.setSize(Number(size?.cols) & 0xffff, Number(size?.rows) & 0xffff);
        return null;
      }
      case IOCTL.TIOCSCTTY:
        throw new KernelError('EPERM');
      default:
        throw new KernelError('ENOTTY');
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    try {
      if (!this.failure) {
        await interruptible(this.drain(), AbortSignal.timeout(CLOSING_WAIT_MS)).catch(quiet);
      }
      this.closed = true;
      this.resume?.();
      this.wake();
      await this.reader.cancel('closed').catch(quiet);
      this.reader.releaseLock();
      await this.writer.abort('closed').catch(quiet);
      this.writer.releaseLock();
      await this.control('close').catch(quiet);
    } finally {
      this.closed = true;
      this.onClosed({ termios: this.tty.tcgets(), ispeed: this.ispeed, ospeed: this.ospeed });
    }
  }
}
