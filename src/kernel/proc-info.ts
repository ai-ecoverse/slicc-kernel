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
  state: 'S' | 'Z';
  memory: number;
  umask?: number;
  cred?: Cred;
  sigIgn?: number;
  sigCgt?: number;
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
}
