export const DRIVER_PROTOCOL: readonly [number, number] = [1, 1];

export interface DriverCapabilities {
  readonly?: boolean;
  symlinks?: boolean;
  chmod?: boolean;
  linkTimes?: boolean;
  ranges?: boolean;
  listingStats?: boolean;
  caseInsensitive?: boolean;
  normalization?: 'none' | 'nfc' | 'nfd-insensitive';
  maxIo?: number;
  maxFile?: number;
  attrTtl?: number;
  entryTtl?: number;
}

export interface DriverAttr {
  kind: 'file' | 'directory' | 'symlink';
  size: number;
  mtime: number;
  mode?: number;
  ino?: number;
  etag?: string;
}

export interface DriverEntry {
  name: string;
  kind: DriverAttr['kind'];
  attr?: DriverAttr;
}

export interface DriverStatfs {
  bsize: number;
  blocks: number;
  bfree: number;
}

export interface MountRequestInfo {
  source: string;
  options: Record<string, string>;
}

export type DriverCall =
  | { op: 'getattr'; path: string }
  | { op: 'readdir'; path: string }
  | {
      op: 'open';
      path: string;
      write: boolean;
      create: boolean;
      truncate: boolean;
      exclusive: boolean;
      ifMatch?: string;
    }
  | { op: 'read'; fh: number; offset: number; size: number }
  | { op: 'write'; fh: number; offset: number; bytes: Uint8Array }
  | { op: 'release'; fh: number }
  | { op: 'mkdir'; path: string }
  | { op: 'rmdir'; path: string }
  | { op: 'unlink'; path: string }
  | { op: 'rename'; from: string; to: string }
  | { op: 'symlink'; target: string; path: string }
  | { op: 'readlink'; path: string }
  | { op: 'setattr'; path: string; mode?: number; mtime?: number; size?: number }
  | { op: 'statfs' };

export type DriverRequest = DriverCall & { id: number };

export interface DriverReply {
  id: number;
  result?: unknown;
  errno?: string;
  message?: string;
}

export interface KernelDriverHello {
  protocol: readonly [number, number];
  mount: MountRequestInfo;
}

export interface DriverHello {
  protocol: readonly [number, number];
  capabilities?: DriverCapabilities;
  error?: string;
  errno?: string;
}

export type KernelToDriver = { hello: KernelDriverHello } | DriverRequest;

export type DriverToKernel = { hello: DriverHello } | DriverReply | { invalidate: string[] | true };

export function driverVersionError(theirs: unknown): string | undefined {
  const major = Array.isArray(theirs) ? theirs[0] : undefined;
  if (major === DRIVER_PROTOCOL[0]) return undefined;
  const named = typeof major === 'number' ? `${major}.x` : 'without a version';
  return `slicc-kernel driver protocol ${named} is not supported: this side speaks ${DRIVER_PROTOCOL.join('.')}`;
}
