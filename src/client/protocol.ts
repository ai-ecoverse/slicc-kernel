import type { WatchChange } from '../fs/watch.ts';
import type { TransportCall, TransportReply } from '../kernel/net/remote-transport.ts';
import type { RealmTransportTraits } from '../kernel/net/transport.ts';
import type { MountSpec } from '../mount/mount-fs.ts';

export const PROTOCOL: readonly [number, number] = [1, 4];

export interface ClientHello {
  protocol: readonly [number, number];
  lock?: string;
}

export interface KernelHello {
  protocol: readonly [number, number];
  lock?: string;
  traits?: RealmTransportTraits;
  error?: string;
}

export interface SpawnRequestOptions {
  cwd?: string;
  env?: Record<string, string>;
  stdin?: Uint8Array;
  pgid?: number;
}

export interface TerminalRequestOptions {
  cwd?: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
}

export type TerminalAction =
  | { action: 'write'; bytes: Uint8Array }
  | { action: 'resize'; cols: number; rows: number }
  | { action: 'signal'; signal: string }
  | { action: 'close' };

export const FS_METHODS = [
  'readFile',
  'writeFile',
  'stat',
  'lstat',
  'readdir',
  'mkdir',
  'rm',
  'rename',
  'realpath',
  'symlink',
  'readlink',
  'exists',
] as const;

export type FsMethod = (typeof FS_METHODS)[number];

export type ClientCall =
  | { op: 'spawn'; argv: string[]; options: SpawnRequestOptions }
  | { op: 'open-terminal'; argv: string[]; options: TerminalRequestOptions }
  | ({ op: 'terminal'; terminal: number } & TerminalAction)
  | { op: 'kill'; pid: number; signal: string }
  | { op: 'ps' }
  | { op: 'fs'; method: FsMethod; args: unknown[] }
  | { op: 'watch'; paths: string[]; recursive: boolean }
  | { op: 'unwatch'; watch: number }
  | { op: 'mount'; spec: MountSpec }
  | { op: 'umount'; target: string }
  | { op: 'mounts' }
  | { op: 'dial'; port: number; host?: string }
  | { op: 'detach'; kill?: boolean };

export type ClientRequest = ClientCall & { id: number };

export interface ClientReply {
  id: number;
  result?: unknown;
  error?: string;
  code?: string;
  fd?: 1 | 2;
  bytes?: Uint8Array;
  started?: number;
}

export type ClientMessage = { hello: ClientHello } | ClientRequest | TransportCall;

export interface WatchEvent {
  watch: number;
  change: WatchChange;
}

export type KernelMessage = { hello: KernelHello } | ClientReply | WatchEvent | TransportReply;

export interface ProcessEntry {
  pid: number;
  ppid: number;
  pgid: number;
  sid: number;
  argv: string[];
  tty: string | null;
  started: number;
  state: 'S' | 'Z';
  memory: number;
}

export interface MessagePortLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message' | 'close', handler: (event: MessageEvent) => void): void;
  start?(): void;
  close?(): void;
}

export interface LockManagerLike {
  request(name: string, callback: () => Promise<unknown> | unknown): Promise<unknown>;
}

export function locksOf(scope: object = globalThis): LockManagerLike | undefined {
  const locks = (scope as { navigator?: { locks?: LockManagerLike } }).navigator?.locks;
  return typeof locks?.request === 'function' ? locks : undefined;
}

export function versionError(theirs: unknown): string | undefined {
  const major = Array.isArray(theirs) ? theirs[0] : undefined;
  if (major === PROTOCOL[0]) return undefined;
  const named = typeof major === 'number' ? `${major}.x` : 'without a version';
  return `slicc-kernel client protocol ${named} is not supported: this side speaks ${PROTOCOL.join('.')}`;
}
