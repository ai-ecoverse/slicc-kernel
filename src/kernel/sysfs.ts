import { inSys } from '../fs/dev-removal.ts';
import type { SyncFsBridgeStat } from '../realm/sync-fs-wire.ts';
import { DEVICE_NAME, type DeviceNodeInfo } from './devices.ts';

export { inSys };

const HCD = '/sys/devices/platform/slicc_hcd.0';
const VIRTUAL = '/sys/devices/virtual/tty';
const CLASS = '/sys/class/tty';
const USB_BUS = '/sys/bus/usb';
const SERIAL_BUS = '/sys/bus/usb-serial';
const ALWAYS = ['/sys/class/tty', '/sys/bus/usb', '/sys/bus/usb-serial', '/sys/devices'];
const DIR_MODE = 0o40755;
const FILE_MODE = 0o100444;
const LINK_MODE = 0o120777;
const MAX_HOPS = 40;

type Entry =
  | { kind: 'dir'; names: Set<string> }
  | { kind: 'file'; text: string }
  | { kind: 'link'; target: string };

function sysError(code: string, path: string): Error & { code: string } {
  return Object.assign(new Error(`${code}: ${path}`), { code });
}

function relative(fromDir: string, to: string): string {
  const from = fromDir.split('/').filter(Boolean);
  const dest = to.split('/').filter(Boolean);
  let same = 0;
  while (same < from.length && from[same] === dest[same]) same++;
  if (same === dest.length) same--;
  return [...from.slice(same).map(() => '..'), ...dest.slice(same)].join('/');
}

function parentOf(path: string): string {
  return path.slice(0, path.lastIndexOf('/')) || '/';
}

function baseOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function inodeOf(path: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < path.length; i++) hash = Math.imul(hash ^ path.charCodeAt(i), 0x01000193);
  return hash >>> 0 || 1;
}

function product(vid: string, pid: string): string {
  return `${Number.parseInt(vid, 16).toString(16)}/${Number.parseInt(pid, 16).toString(16)}/0`;
}

class Layout {
  readonly entries = new Map<string, Entry>([['/', { kind: 'dir', names: new Set() }]]);

  dir(path: string): void {
    if (this.entries.has(path)) return;
    const parent = parentOf(path);
    this.dir(parent);
    (this.entries.get(parent) as { names: Set<string> }).names.add(baseOf(path));
    this.entries.set(path, { kind: 'dir', names: new Set() });
  }

  private put(path: string, entry: Entry): void {
    const parent = parentOf(path);
    this.dir(parent);
    (this.entries.get(parent) as { names: Set<string> }).names.add(baseOf(path));
    this.entries.set(path, entry);
  }

  file(path: string, text: string): void {
    this.put(path, { kind: 'file', text });
  }

  link(path: string, to: string): void {
    this.put(path, { kind: 'link', target: relative(parentOf(path), to) });
  }
}

function addNode(layout: Layout, node: DeviceNodeInfo): void {
  const name = node.path.slice('/dev/'.length);
  const family = DEVICE_NAME.exec(name)?.[1];
  const { sys } = node;
  const bus = family === 'USB' ? 1 : 2;
  const usb = `${HCD}/usb${bus}/${bus}-${node.minor + 1}`;
  const intf = `${usb}/${bus}-${node.minor + 1}:1.0`;
  const port = family === 'USB' ? `${intf}/${name}` : intf;
  const tty = sys ? `${port}/tty/${name}` : `${VIRTUAL}/${name}`;
  layout.link(`${CLASS}/${name}`, tty);
  layout.file(`${tty}/dev`, `${node.major}:${node.minor}\n`);
  layout.file(`${tty}/uevent`, `MAJOR=${node.major}\nMINOR=${node.minor}\nDEVNAME=${name}\n`);
  layout.link(`${tty}/subsystem`, CLASS);
  if (!sys) return;
  layout.link(`${tty}/device`, port);
  if (port !== intf) layout.link(`${port}/subsystem`, SERIAL_BUS);
  const id = product(sys.idVendor, sys.idProduct);
  layout.file(`${intf}/bInterfaceNumber`, '00\n');
  layout.file(`${intf}/uevent`, `DEVTYPE=usb_interface\nPRODUCT=${id}\n`);
  layout.link(`${intf}/subsystem`, USB_BUS);
  layout.file(`${usb}/idVendor`, `${sys.idVendor}\n`);
  layout.file(`${usb}/idProduct`, `${sys.idProduct}\n`);
  layout.file(`${usb}/bNumInterfaces`, ' 1\n');
  for (const key of ['manufacturer', 'product', 'serial'] as const) {
    const text = sys[key];
    if (text !== undefined) layout.file(`${usb}/${key}`, `${text}\n`);
  }
  layout.file(`${usb}/uevent`, `DEVTYPE=usb_device\nPRODUCT=${id}\n`);
  layout.link(`${usb}/subsystem`, USB_BUS);
}

export function sysLayout(nodes: readonly DeviceNodeInfo[]): Map<string, Entry> {
  const layout = new Layout();
  for (const dir of ALWAYS) layout.dir(dir);
  for (const node of nodes) addNode(layout, node);
  return layout.entries;
}

const SKELETON = sysLayout([]);
const FIXED: ReadonlySet<string> = new Set([
  '/',
  '/sys',
  '/sys/class',
  '/sys/bus',
  '/sys/bus/usb',
  '/sys/bus/usb-serial',
]);
const BORN = Date.now();

function walk(entries: Map<string, Entry>, path: string, follow: boolean): string {
  const done: string[] = [];
  let todo = path.split('/').filter((part) => part !== '' && part !== '.');
  let hops = 0;
  while (todo.length > 0) {
    const part = todo.shift() as string;
    if (part === '..') {
      done.pop();
      continue;
    }
    const here = entries.get(`/${done.join('/')}`);
    if (here?.kind !== 'dir') throw sysError('ENOTDIR', path);
    const entry = entries.get(`/${[...done, part].join('/')}`);
    if (!entry) throw sysError('ENOENT', path);
    if (entry.kind === 'link' && (follow || todo.length > 0)) {
      if (++hops > MAX_HOPS) throw sysError('ELOOP', path);
      todo = [...entry.target.split('/').filter((p) => p !== '' && p !== '.'), ...todo];
      continue;
    }
    done.push(part);
  }
  return `/${done.join('/')}`;
}

function walked(path: string, follow: boolean): string | undefined {
  try {
    return walk(SKELETON, path, follow);
  } catch {
    return undefined;
  }
}

export class SysTree {
  private readonly source: () => readonly DeviceNodeInfo[];
  private built: Map<string, Entry> | undefined;

  constructor(source: () => readonly DeviceNodeInfo[]) {
    this.source = source;
  }

  private layout(): Map<string, Entry> {
    this.built ??= sysLayout(this.source());
    return this.built;
  }

  private find(path: string, follow: boolean, listing = false): { at: string; entry: Entry } {
    const known = walked(path, follow);
    if (known !== undefined && (!listing || FIXED.has(known)))
      return { at: known, entry: SKELETON.get(known) as Entry };
    const entries = this.layout();
    const at = walk(entries, path, follow);
    return { at, entry: entries.get(at) as Entry };
  }

  resolve(path: string, follow = true): string {
    return this.find(path, follow).at;
  }

  stat(path: string, follow = true): SyncFsBridgeStat {
    const { at, entry } = this.find(path, follow);
    const size =
      entry.kind === 'file'
        ? new TextEncoder().encode(entry.text).length
        : entry.kind === 'link'
          ? entry.target.length
          : 0;
    return {
      isFile: entry.kind === 'file',
      isDirectory: entry.kind === 'dir',
      isSymbolicLink: entry.kind === 'link',
      size,
      mode: entry.kind === 'dir' ? DIR_MODE : entry.kind === 'file' ? FILE_MODE : LINK_MODE,
      mtimeMs: BORN,
      atimeMs: BORN,
      ctimeMs: BORN,
      ino: inodeOf(at),
      nlink: entry.kind === 'dir' ? 2 : 1,
      uid: 0,
      gid: 0,
      readonly: true,
    };
  }

  read(path: string): Uint8Array {
    const { entry } = this.find(path, true);
    if (entry.kind !== 'file') throw sysError('EISDIR', path);
    return new TextEncoder().encode(entry.text);
  }

  readdir(path: string): string[] {
    const { entry } = this.find(path, true, true);
    if (entry.kind !== 'dir') throw sysError('ENOTDIR', path);
    return [...entry.names].sort();
  }

  readlink(path: string): string {
    const { entry } = this.find(path, false);
    if (entry.kind !== 'link') throw sysError('EINVAL', path);
    return entry.target;
  }

  exists(path: string, follow = true): boolean {
    try {
      this.resolve(path, follow);
      return true;
    } catch (err) {
      if ((err as { code?: unknown }).code === undefined) throw err;
      return false;
    }
  }

  access(path: string, mode: number): void {
    const { entry } = this.find(path, true);
    if (mode & 2) throw sysError('EROFS', path);
    if (mode & 1 && entry.kind !== 'dir') throw sysError('EACCES', path);
  }
}
