import type { KernelFs, NewOwner } from '../fs/types.ts';
import type { Cred } from '../kernel/cred.ts';
import type { Account } from '../users.ts';
import { parseCrontab, SPOOL_DIR } from './table.ts';

export const CRONTAB_MAX = 256 * 1024;
export const TAGS_PATH = '/var/spool/cron/tags';

export interface JobTags {
  tags: string[];
  base: number;
}

export interface CrontabCaller {
  tags?: readonly string[] | undefined;
  base?: number | undefined;
}

export async function readTags(fs: KernelFs): Promise<Record<string, JobTags>> {
  const text = await fs.readFile(TAGS_PATH).catch(() => '');
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, JobTags>) : {};
  } catch {
    return {};
  }
}

function merged(old: JobTags | undefined, caller: CrontabCaller): JobTags | undefined {
  const tags = [...new Set([...(old?.tags ?? []), ...(caller.tags ?? [])])];
  if (tags.length === 0) return undefined;
  const base = Math.min(
    old?.base ?? Number.POSITIVE_INFINITY,
    caller.base ?? caller.tags?.length ?? 0
  );
  return { tags, base: Number.isFinite(base) ? base : 0 };
}

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

  async request(
    cred: Readonly<Cred>,
    call: CrontabCall,
    caller: CrontabCaller = {}
  ): Promise<CrontabResult> {
    const self = await this.o.lookup(cred.ruid);
    if (!self) return { error: `crontab: your uid ${cred.ruid} is not in /etc/passwd` };
    let target = self;
    if (call.user !== undefined && call.user !== self.name) {
      if (cred.euid !== 0) return { error: 'crontab: must be privileged to use -u' };
      const found = await this.o.lookup(call.user);
      if (!found) return { error: `crontab: user ${call.user} unknown` };
      target = found;
    }
    const path = `${SPOOL_DIR}/${target.name}`;
    const none = { error: `no crontab for ${target.name}` };
    const { fs } = this.o;
    if (call.action === 'install') return this.install(path, target, call.text as string, caller);
    if (!(await fs.exists(path))) return none;
    if (call.action === 'list') return { text: await fs.readFile(path) };
    await this.retag(path, '', {});
    await fs.rm(path);
    return { text: '' };
  }

  private async retag(path: string, text: string, caller: CrontabCaller): Promise<void> {
    const { fs, owners } = this.o;
    const all = await readTags(fs);
    const before = await fs.readFile(path).catch(() => '');
    const old = new Set(parseCrontab(before, path).jobs.map((job) => job.id));
    const kept: Record<string, JobTags> = {};
    for (const [id, entry] of Object.entries(all)) if (!old.has(id)) kept[id] = entry;
    for (const { id } of parseCrontab(text, path).jobs) {
      const entry = merged(old.has(id) ? all[id] : undefined, caller);
      if (entry) kept[id] = entry;
    }
    const json = JSON.stringify(kept);
    if (json === JSON.stringify(all)) return;
    const owner: NewOwner | undefined = owners ? { uid: 0, gid: 0, mode: 0o600 } : undefined;
    const fresh = `${TAGS_PATH}.${crypto.randomUUID()}.new`;
    await fs.writeFile(fresh, json, owner);
    await fs.rename(fresh, TAGS_PATH);
  }

  private async install(
    path: string,
    target: Account,
    text: string,
    caller: CrontabCaller
  ): Promise<CrontabResult> {
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
    const fresh = `${SPOOL_DIR}/.${target.name}.${crypto.randomUUID()}.new`;
    const owner: NewOwner | undefined = owners
      ? { uid: target.uid, gid: target.gid, mode: 0o600 }
      : undefined;
    await this.retag(path, text, caller);
    await fs.writeFile(fresh, text, owner);
    await fs.rename(fresh, path);
    return { text: '' };
  }
}
