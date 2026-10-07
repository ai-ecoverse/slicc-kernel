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
}

export interface ProcessListing {
  boot: number;
  processes: ProcessInfo[];
}
