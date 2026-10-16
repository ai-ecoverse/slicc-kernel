import type { KernelFs, NewOwner } from '../fs/types.ts';
import type { Cred } from '../kernel/cred.ts';
import type { Account } from '../users.ts';
import { parseCrontab, SPOOL_DIR } from './table.ts';

export const CRONTAB_MAX = 256 * 1024;

export interface CrontabCall {
  op: 'proc-crontab';
  action: 'list' | 'remove' | 'install';
  user?: string;
  text?: string;
}

export type CrontabResult = { text: string } | { error: string };

export interface CrontabsOptions {
  fs: KernelFs;
  owners: boolean;
  lookup(user: string | number): Promise<Account | undefined>;
}

const ACTIONS = new Set(['list', 'remove', 'install']);

export function crontabCall(req: Partial<CrontabCall>): CrontabCall | undefined {
  const { action, user, text } = req;
  if (typeof action !== 'string' || !ACTIONS.has(action)) return undefined;
  if (user !== undefined && typeof user !== 'string') return undefined;
  if (action === 'install' && typeof text !== 'string') return undefined;
  return {
    op: 'proc-crontab',
    action: action as CrontabCall['action'],
    ...(user !== undefined ? { user } : {}),
    ...(action === 'install' ? { text: text as string } : {}),
  };
}

export class Crontabs {
  private readonly o: CrontabsOptions;

  constructor(options: CrontabsOptions) {
    this.o = options;
  }

  async request(cred: Readonly<Cred>, call: CrontabCall): Promise<CrontabResult> {
    const caller = await this.o.lookup(cred.ruid);
    if (!caller) return { error: `crontab: your uid ${cred.ruid} is not in /etc/passwd` };
    let target = caller;
    if (call.user !== undefined && call.user !== caller.name) {
      if (cred.euid !== 0) return { error: 'crontab: must be privileged to use -u' };
      const found = await this.o.lookup(call.user);
      if (!found) return { error: `crontab: user ${call.user} unknown` };
      target = found;
    }
    const path = `${SPOOL_DIR}/${target.name}`;
    const none = { error: `no crontab for ${target.name}` };
    const { fs } = this.o;
    if (call.action === 'install') return this.install(path, target, call.text as string);
    if (!(await fs.exists(path))) return none;
    if (call.action === 'list') return { text: await fs.readFile(path) };
    await fs.rm(path);
    return { text: '' };
  }

  private async install(path: string, target: Account, text: string): Promise<CrontabResult> {
    if (text.length > CRONTAB_MAX) return { error: 'crontab: the table is too long' };
    const { errors } = parseCrontab(text, path);
    if (errors.length > 0) {
      const lines = errors.map(({ line, message }) => `"-":${line}: ${message}`);
      return { error: ['crontab: errors in crontab file, cannot install', ...lines].join('\n') };
    }
    const { fs, owners } = this.o;
    if (!(await fs.exists(SPOOL_DIR))) {
      await fs.mkdir(SPOOL_DIR, { recursive: true });
      if (owners) await fs.chown?.(SPOOL_DIR, { uid: 0, gid: 0, mode: 0o700, follow: false });
    }
    const fresh = `${path}.new`;
    const owner: NewOwner | undefined = owners
      ? { uid: target.uid, gid: target.gid, mode: 0o600 }
      : undefined;
    await fs.rm(fresh, { force: true });
    await fs.writeFile(fresh, text, owner);
    await fs.rename(fresh, path);
    return { text: '' };
  }
}
