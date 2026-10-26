import type { Cred } from './cred.ts';

export interface ProcessInfo {
  pid: number;
  tid: number;
  ppid: number;
  pgid: number;
  sid: number;
  argv: string[];
  exe?: string;
  exeId?: string;
  tty: string | null;
  started: number;
  state: 'S' | 'T' | 'Z';

  threads?: Array<{ tid: number; state: 'R' | 'S' }>;
  memory: number;
  utime?: number;
  stime?: number;
  cutime?: number;
  cstime?: number;
  umask?: number;
  cred?: Cred;
  sigIgn?: number;
  sigCgt?: number;
  sigBlk?: number;
  tag?: string;
  tags?: string[];
}

export interface MountLine {
  type: string;
  source: string;
  target: string;
  options: Record<string, string>;
  state: 'ok' | 'failed' | 'nomedium' | 'pending';
}

export interface ProcessListing {
  boot: number;
  processes: ProcessInfo[];
  load?: readonly [number, number, number];
  cpu?: { utime: number; stime: number; idle: number };
  wasm?: { live: number; ceiling: number; source?: string };
  peers?: number;
  fsCalls?: number;
  opfsCalls?: number;
  opfsOps?: number;
  cwdChecks?: number;
  staleFds?: number;
  fileIds?: number;
  holds?: { mine: number; peers: number; sent: number; held?: readonly string[] };
  swaps?: { swaps: number; longestMs: number; waits: number; waitedMs: number };
  renameAcks?: {
    acks: number;
    busy: number;
    waits: number;
    queries: number;
    ackMs: readonly number[];
  };
}

export function mayTrace(viewer: ProcessInfo | undefined, target: ProcessInfo): boolean {
  const by = viewer?.cred;
  const of = target.cred;
  if (!by || !of || by.euid === 0) return true;
  const uid = of.ruid === by.euid && of.euid === by.euid && of.suid === by.euid;
  return uid && of.rgid === by.egid && of.egid === by.egid && of.sgid === by.egid;
}

export function fileIdentity(
  ino: number | undefined,
  mtimeMs: number | undefined
): string | undefined {
  if (ino === undefined || mtimeMs === undefined || !Number.isFinite(mtimeMs)) return undefined;
  return `${ino}:${Math.trunc(mtimeMs)}`;
}
