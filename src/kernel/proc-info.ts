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
}

export interface MountLine {
  type: string;
  source: string;
  target: string;
  options: Record<string, string>;
  state: 'ok' | 'failed' | 'nomedium';
}

export interface ProcessListing {
  boot: number;
  processes: ProcessInfo[];
}
