import type { Cred } from './cred.ts';

export interface ProcessInfo {
  pid: number;
  tid: number;
  ppid: number;
  pgid: number;
  sid: number;
  argv: string[];
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
}
