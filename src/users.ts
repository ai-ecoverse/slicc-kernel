import type { KernelFs } from './fs/types.ts';
import { fsError } from './fs/types.ts';
import { type Cred, userCred } from './kernel/cred.ts';

export const PASSWD = '/etc/passwd';
export const GROUP = '/etc/group';

export const DEFAULT_PASSWD =
  'root:x:0:0:root:/root:/bin/bash\nnobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin\n';
export const DEFAULT_GROUP = 'root:x:0:\nsudo:x:27:\nusers:x:100:\nnogroup:x:65534:\n';

const NAME = /^[a-z_][a-z0-9_.-]*$/;
const MAX_NAME = 255;
const FIRST_UID = 1000;
const LAST_UID = 60000;
const USERS_GROUP = 'users';
const HOME_DIR = /^\/home\/[^/]+$/;
export const SYSTEM_PNPM_HOME = '/usr/local/share/pnpm';

export interface Account {
  name: string;
  uid: number;
  gid: number;
  home: string;
  shell: string;
  groups: number[];
  umask?: number;
}

export interface AddUser {
  name: string;
  home?: string;
  groups?: string[];
  umask?: number;
}

export interface RemoveUser {
  keepHome?: boolean;
}

interface PasswdRow {
  name: string;
  uid: number;
  gid: number;
  gecos: string;
  home: string;
  shell: string;
}

interface GroupRow {
  name: string;
  gid: number;
  members: string[];
}

type Rows<T> = Array<T | string>;

const isId = (text: string | undefined) => text !== undefined && /^\d+$/.test(text);

function lines(text: string): string[] {
  return text.split('\n').filter((line, i, all) => line !== '' || i < all.length - 1);
}

export function parsePasswd(text: string): Rows<PasswdRow> {
  return lines(text).map((line) => {
    const [name, , uid, gid, gecos = '', home = '/', shell = '/bin/sh'] = line.split(':');
    if (!name || !isId(uid) || !isId(gid)) return line;
    return { name, uid: Number(uid), gid: Number(gid), gecos, home, shell };
  });
}

export function parseGroup(text: string): Rows<GroupRow> {
  return lines(text).map((line) => {
    const [name, , gid, members = ''] = line.split(':');
    if (!name || !isId(gid)) return line;
    return { name, gid: Number(gid), members: members.split(',').filter(Boolean) };
  });
}

function formatPasswd(rows: Rows<PasswdRow>): string {
  const line = (r: PasswdRow) => `${r.name}:x:${r.uid}:${r.gid}:${r.gecos}:${r.home}:${r.shell}`;
  return `${rows.map((r) => (typeof r === 'string' ? r : line(r))).join('\n')}\n`;
}

function formatGroup(rows: Rows<GroupRow>): string {
  const line = (r: GroupRow) => `${r.name}:x:${r.gid}:${r.members.join(',')}`;
  return `${rows.map((r) => (typeof r === 'string' ? r : line(r))).join('\n')}\n`;
}

const parsed = <T>(rows: Rows<T>): T[] => rows.filter((r): r is T => typeof r !== 'string');

export function credOf(account: Account): Cred {
  return userCred(account.uid, account.gid, account.groups);
}

export function pnpmHomeOf(account: Account, system = SYSTEM_PNPM_HOME): string {
  return account.uid === 0 ? system : `${account.home}/.local/share/pnpm`;
}

export function userEnv(account: Account, system?: string): Record<string, string> {
  const pnpm = pnpmHomeOf(account, system);
  return {
    HOME: account.home,
    USER: account.name,
    LOGNAME: account.name,
    PNPM_HOME: pnpm,
    PATH: `${pnpm}/bin:/usr/local/bin:/usr/bin:/bin`,
  };
}

export class UserDb {
  private readonly fs: KernelFs;
  private readonly umasks = new Map<string, number>();
  private writing: Promise<unknown> = Promise.resolve();

  constructor(fs: KernelFs) {
    this.fs = fs;
  }

  private async read(path: string, fallback: string): Promise<string> {
    try {
      return await this.fs.readFile(path);
    } catch (err) {
      if ((err as { code?: unknown })?.code === 'ENOENT') return fallback;
      throw err;
    }
  }

  private async tables(): Promise<{ passwd: Rows<PasswdRow>; group: Rows<GroupRow> }> {
    return {
      passwd: parsePasswd(await this.read(PASSWD, DEFAULT_PASSWD)),
      group: parseGroup(await this.read(GROUP, DEFAULT_GROUP)),
    };
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.writing.then(work);
    this.writing = next.catch(() => undefined);
    return next;
  }

  async ensure(): Promise<void> {
    await this.fs.mkdir('/etc', { recursive: true });
    for (const [path, text] of [
      [PASSWD, DEFAULT_PASSWD],
      [GROUP, DEFAULT_GROUP],
    ]) {
      if (!(await this.fs.exists(path))) await this.fs.writeFile(path, text);
    }
    if (!(await this.fs.exists('/root'))) {
      await this.fs.mkdir('/root', { recursive: true });
      await this.fs.chmod('/root', 0o700);
    }
  }

  private account(row: PasswdRow, groups: GroupRow[]): Account {
    const extra = groups.filter((g) => g.members.includes(row.name) && g.gid !== row.gid);
    const umask = this.umasks.get(row.name);
    return {
      name: row.name,
      uid: row.uid,
      gid: row.gid,
      home: row.home,
      shell: row.shell,
      groups: [row.gid, ...extra.map((g) => g.gid)],
      ...(umask !== undefined ? { umask } : {}),
    };
  }

  async lookup(user: string | number): Promise<Account | undefined> {
    const { passwd, group } = await this.tables();
    const key = typeof user === 'number' ? 'uid' : 'name';
    const row = parsed(passwd).find((r) => r[key] === user);
    return row && this.account(row, parsed(group));
  }

  async list(): Promise<Account[]> {
    const { passwd, group } = await this.tables();
    const groups = parsed(group);
    return parsed(passwd).map((row) => this.account(row, groups));
  }

  add(options: AddUser): Promise<Account> {
    return this.serial(async () => {
      const { name } = options;
      if (typeof name !== 'string' || name.length > MAX_NAME || !NAME.test(name)) {
        throw fsError('EINVAL', `not a user name: ${String(name)}`);
      }
      if (options.umask !== undefined) this.umasks.set(name, options.umask & 0o777);
      const { passwd, group } = await this.tables();
      const users = parsed(passwd);
      const groups = parsed(group);
      const found = users.find((r) => r.name === name);
      if (found) return this.account(found, groups);
      const extra = [USERS_GROUP, ...(options.groups ?? [])].map((g) => {
        const row = groups.find((r) => r.name === g);
        if (!row) throw fsError('ENOENT', `no group ${g}`);
        return row;
      });
      if (groups.some((r) => r.name === name)) throw fsError('EEXIST', `group ${name} exists`);
      const taken = new Set([...users.map((r) => r.uid), ...groups.map((r) => r.gid)]);
      let uid = FIRST_UID;
      while (taken.has(uid)) uid++;
      if (uid > LAST_UID) throw fsError('ENOSPC', 'no free user id');
      const home = options.home ?? `/home/${name}`;
      const row = { name, uid, gid: uid, gecos: name, home, shell: '/bin/bash' };
      for (const g of extra) if (!g.members.includes(name)) g.members.push(name);
      group.push({ name, gid: uid, members: [] });
      passwd.push(row);
      const before = await this.read(GROUP, DEFAULT_GROUP);
      await this.fs.mkdir(home, { recursive: true });
      await this.fs.mkdir('/etc', { recursive: true });
      await this.fs.writeFile(GROUP, formatGroup(group));
      try {
        await this.fs.writeFile(PASSWD, formatPasswd(passwd));
      } catch (err) {
        await this.fs.writeFile(GROUP, before);
        throw err;
      }
      return this.account(row, parsed(group));
    });
  }

  remove(name: string, options: RemoveUser = {}): Promise<boolean> {
    return this.serial(async () => {
      const { passwd, group } = await this.tables();
      const row = parsed(passwd).find((r) => r.name === name);
      if (!row) return false;
      if (row.uid < FIRST_UID || row.uid > LAST_UID) {
        throw fsError('EPERM', `${name} is a system account`);
      }
      const keptGroups = group.filter(
        (r) => typeof r === 'string' || !(r.name === name && r.gid === row.gid)
      );
      for (const r of parsed(keptGroups)) r.members = r.members.filter((m) => m !== name);
      const before = await this.read(GROUP, DEFAULT_GROUP);
      await this.fs.writeFile(GROUP, formatGroup(keptGroups));
      try {
        await this.fs.writeFile(PASSWD, formatPasswd(passwd.filter((r) => r !== row)));
      } catch (err) {
        await this.fs.writeFile(GROUP, before);
        throw err;
      }
      this.umasks.delete(name);
      const home = this.fs.resolvePath('/', row.home);
      if (!options.keepHome && HOME_DIR.test(home)) {
        await this.fs.rm(home, { recursive: true, force: true });
      }
      return true;
    });
  }
}
