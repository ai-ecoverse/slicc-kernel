import { type KernelFs, resolvePath } from './fs/types.ts';

export type Abi = 'emscripten' | 'wasi' | 'js';

export interface Command {
  name: string;
  abi: Abi;
  glue: string;
  wasm: string;
  argv0: string;
  argv0Path?: boolean;
  argv0Fixed?: true;
  preopenRoot?: boolean;
  args?: string[];
  env?: Record<string, string>;
  unset?: string[];
  script?: string;
  bin?: true;
  imports?: string;
}

interface CommandEntry {
  abi?: unknown;
  glue?: unknown;
  wasm?: unknown;
  argv0?: unknown;
  argv0Path?: unknown;
  preopenRoot?: unknown;
  args?: unknown;
  env?: unknown;
  script?: unknown;
  imports?: unknown;
  module?: unknown;
}

interface Manifest {
  name?: unknown;
  bin?: unknown;
  slicc?: {
    abi?: unknown;
    commands?: unknown;
    env?: unknown;
    filesystems?: unknown;
    binfmt?: unknown;
    replaces?: unknown;
  };
}

const NAME = /^[A-Za-z0-9._+-]+$/;
const COMMAND_NAME = /^[^/\s\p{Cc}]+$/u;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PACKAGE = /\$\{package\}/g;

function commandName(name: string): boolean {
  return COMMAND_NAME.test(name) && name.isWellFormed() && name !== '.' && name !== '..';
}

function inside(pkg: string, rel: unknown): string | undefined {
  if (typeof rel !== 'string' || rel === '') return undefined;
  const clean = rel.replace(/^\.\//, '');
  if (clean.startsWith('/') || clean.split('/').includes('..')) return undefined;
  return `${pkg}/${clean}`;
}

type ManifestEnv = Record<string, string | null>;

function envOf(pkg: string, raw: unknown): ManifestEnv {
  const env: ManifestEnv = {};
  if (!raw || typeof raw !== 'object') return env;
  for (const [key, value] of Object.entries(raw)) {
    if (!ENV_KEY.test(key)) continue;
    if (typeof value === 'string') env[key] = value.replace(PACKAGE, pkg);
    else if (value === null) env[key] = null;
  }
  return env;
}

function envFields(merged: ManifestEnv): { env?: Record<string, string>; unset?: string[] } {
  const env: Record<string, string> = {};
  const unset: string[] = [];
  for (const [key, value] of Object.entries(merged)) {
    if (value === null) unset.push(key);
    else env[key] = value;
  }
  return {
    ...(Object.keys(env).length > 0 ? { env } : {}),
    ...(unset.length > 0 ? { unset } : {}),
  };
}

function argsOf(pkg: string, raw: unknown): string[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  if (!raw.every((arg) => typeof arg === 'string')) return undefined;
  return raw.map((arg) => arg.replace(PACKAGE, pkg));
}

function abiOf(raw: unknown, fallback: Abi): Abi | undefined {
  const abi = raw ?? fallback;
  return abi === 'emscripten' || abi === 'wasi' || abi === 'js' ? abi : undefined;
}

function commandOf(
  pkg: string,
  name: string,
  raw: CommandEntry,
  packageAbi: Abi,
  shared: ManifestEnv
): Command | undefined {
  const withEnv = envFields({ ...shared, ...envOf(pkg, raw.env) });
  const script = inside(pkg, raw.script);
  if (script) {
    return { name, abi: packageAbi, glue: script, wasm: script, argv0: name, script, ...withEnv };
  }
  const abi = abiOf(raw.abi, packageAbi);
  const fixed = typeof raw.argv0 === 'string' && raw.argv0 !== '';
  const argv0 = fixed ? (raw.argv0 as string) : name;
  const args = argsOf(pkg, raw.args);
  if (abi === 'js') {
    const module = inside(pkg, raw.module);
    if (!module) return undefined;
    return {
      name,
      abi,
      glue: module,
      wasm: module,
      argv0,
      ...(fixed ? { argv0Fixed: true as const } : {}),
      ...(raw.argv0Path === true ? { argv0Path: true } : {}),
      ...(args ? { args } : {}),
      ...withEnv,
    };
  }
  const wasm = inside(pkg, raw.wasm);
  const glue = abi === 'wasi' ? wasm : inside(pkg, raw.glue);
  if (!abi || !glue || !wasm) return undefined;
  const imports = abi === 'wasi' ? inside(pkg, raw.imports) : undefined;
  return {
    name,
    abi,
    glue,
    wasm,
    argv0,
    ...(fixed ? { argv0Fixed: true as const } : {}),
    ...(raw.argv0Path === true ? { argv0Path: true } : {}),
    ...(abi === 'wasi' && raw.preopenRoot === true ? { preopenRoot: true } : {}),
    ...(args ? { args } : {}),
    ...withEnv,
    ...(imports ? { imports } : {}),
  };
}

export function commandsOf(pkg: string, manifest: Manifest): Command[] {
  const slicc = manifest.slicc;
  if (!slicc || typeof slicc !== 'object') return [];
  const packageAbi = abiOf(slicc.abi, 'emscripten');
  const entries = slicc.commands;
  if (!packageAbi || !entries || typeof entries !== 'object') return [];
  const shared = envOf(pkg, slicc.env);
  const out: Command[] = [];
  for (const [name, raw] of Object.entries(entries as Record<string, CommandEntry>)) {
    if (!commandName(name) || !raw || typeof raw !== 'object') {
      continue;
    }
    const command = commandOf(pkg, name, raw, packageAbi, shared);
    if (command) out.push(command);
  }
  return out;
}

async function withPackagePaths(fs: KernelFs, pkg: string, command: Command): Promise<Command> {
  if (!command.env) return command;
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(command.env)) {
    const path = !value.startsWith('/') && value.includes('/') && inside(pkg, value);
    env[key] = path && (await fs.exists(path)) ? path : value;
  }
  return { ...command, env };
}

async function packages(fs: KernelFs, modules: string): Promise<string[]> {
  const names = await fs.readdir(modules).catch(() => []);
  const packageNames: string[] = [];
  for (const name of names) {
    if (name.startsWith('.')) continue;
    if (!name.startsWith('@')) {
      packageNames.push(name);
      continue;
    }
    for (const inner of await fs.readdir(`${modules}/${name}`).catch(() => [])) {
      packageNames.push(`${name}/${inner}`);
    }
  }
  packageNames.sort();
  return packageNames.map((name) => `${modules}/${name}`);
}

export async function pnpmGlobalRoots(fs: KernelFs, home: string): Promise<string[]> {
  const roots: string[] = [];
  const global = `${home}/global`;
  for (const version of (await fs.readdir(global).catch(() => [])).sort()) {
    for (const group of (await fs.readdir(`${global}/${version}`).catch(() => [])).sort()) {
      const dir = `${global}/${version}/${group}`;
      const st = await fs.lstat(dir).catch(() => undefined);
      if (st?.isDirectory && (await fs.exists(`${dir}/node_modules`)))
        roots.push(`${dir}/node_modules`);
    }
  }
  return roots;
}

async function packagesIn(fs: KernelFs, roots: string | string[]): Promise<string[]> {
  const dirs: string[] = [];
  for (const root of typeof roots === 'string' ? [roots] : roots)
    dirs.push(...(await packages(fs, root)));
  return dirs;
}

function binEntries(manifest: Manifest): [string, unknown][] {
  const { bin, name } = manifest;
  if (typeof bin === 'string') {
    return typeof name === 'string' ? [[name.slice(name.lastIndexOf('/') + 1), bin]] : [];
  }
  return bin && typeof bin === 'object' ? Object.entries(bin) : [];
}

interface Found {
  path: string;
  file: boolean;
}

type Physical = (path: string) => Promise<Found | undefined>;

const MAX_HOPS = 40;

function physicalResolver(fs: KernelFs): Physical {
  const known = new Map<string, Promise<Found | undefined>>();
  const pending = new Set<string>();
  let hops = 0;
  const step = async (path: string): Promise<Found | undefined> => {
    if (path === '/') return { path, file: false };
    const slash = path.lastIndexOf('/');
    const parent = await resolve(path.slice(0, slash) || '/');
    if (parent === undefined) return undefined;
    const at = resolvePath(parent.path, path.slice(slash + 1));
    const st = await fs.lstat(at).catch(() => undefined);
    if (!st?.isSymbolicLink) return st ? { path: at, file: st.isFile === true } : undefined;
    const target = await fs.readlink(at).catch(() => undefined);
    if (target === undefined || ++hops > MAX_HOPS) return undefined;
    return resolve(resolvePath(parent.path, target));
  };
  const resolve = (path: string): Promise<Found | undefined> => {
    if (pending.has(path)) return Promise.resolve(undefined);
    let found = known.get(path);
    if (!found) {
      pending.add(path);
      found = step(path).finally(() => pending.delete(path));
      known.set(path, found);
    }
    return found;
  };
  return (path) => {
    hops = 0;
    return resolve(path);
  };
}

async function binCommandsOf(
  physical: Physical,
  pkg: string,
  manifest: Manifest,
  taken: ReadonlySet<string>
): Promise<Command[]> {
  const entries = binEntries(manifest);
  if (entries.length === 0) return [];
  const home = (await physical(pkg))?.path;
  const out: Command[] = [];
  for (const [name, rel] of entries) {
    if (taken.has(name) || !commandName(name)) continue;
    const script = inside(pkg, rel);
    if (!script) continue;
    const real = await physical(script);
    if (!real?.file || !real.path.startsWith(`${home}/`)) continue;
    out.push({
      name,
      abi: 'emscripten',
      glue: script,
      wasm: script,
      argv0: name,
      script,
      bin: true,
    });
  }
  return out;
}

const PACKAGE_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

function replacesOf(manifest: Manifest): string[] {
  const replaces = manifest.slicc?.replaces;
  if (!Array.isArray(replaces)) return [];
  return replaces.every((name) => typeof name === 'string' && PACKAGE_NAME.test(name))
    ? replaces
    : [];
}

interface Provided {
  name: string;
  pkg: string;
  replaces: string[];
  commands: Command[];
}

async function tierPackages(
  fs: KernelFs,
  physical: Physical,
  roots: string[],
  bins: boolean
): Promise<Provided[]> {
  const out: Provided[] = [];
  for (const root of roots) {
    for (const pkg of await packages(fs, root)) {
      let manifest: Manifest;
      try {
        manifest = JSON.parse(await fs.readFile(`${pkg}/package.json`));
      } catch {
        continue;
      }
      const own = commandsOf(pkg, manifest);
      const named = new Set(own.map((command) => command.name));
      const extra = bins ? await binCommandsOf(physical, pkg, manifest, named) : [];
      out.push({
        name: pkg.slice(root.length + 1),
        pkg,
        replaces: replacesOf(manifest),
        commands: [...own, ...extra],
      });
    }
  }
  return out;
}

function winners(tier: Provided[]): Map<string, { pkg: string; command: Command }> {
  const providers = new Map<string, Provided[]>();
  for (const entry of tier) {
    for (const command of entry.commands) {
      const list = providers.get(command.name) ?? [];
      if (!list.includes(entry)) list.push(entry);
      providers.set(command.name, list);
    }
  }
  const out = new Map<string, { pkg: string; command: Command }>();
  for (const [name, list] of providers) {
    const kept = list.filter(
      (entry) => !list.some((other) => other !== entry && other.replaces.includes(entry.name))
    );
    const entry = kept[0] ?? (list[0] as Provided);
    const command = entry.commands.find((c) => c.name === name) as Command;
    out.set(name, { pkg: entry.pkg, command });
  }
  return out;
}

export async function scanCommands(
  fs: KernelFs,
  modules: string | (string | string[])[],
  binsFrom = Number.POSITIVE_INFINITY
): Promise<Map<string, Command>> {
  const found = new Map<string, Command>();
  const physical = physicalResolver(fs);
  const tiers = (typeof modules === 'string' ? [modules] : modules).map((tier) =>
    typeof tier === 'string' ? [tier] : tier
  );
  for (const [index, roots] of tiers.entries()) {
    const tier = await tierPackages(fs, physical, roots, index >= binsFrom);
    for (const [name, { pkg, command }] of winners(tier)) {
      if (!found.has(name)) found.set(name, await withPackagePaths(fs, pkg, command));
    }
  }
  if (!found.has('sh') && found.has('bash')) {
    found.set('sh', { ...(found.get('bash') as Command), name: 'sh', argv0: 'sh' });
  }
  return found;
}

export async function scanFilesystems(
  fs: KernelFs,
  modules: string | string[]
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  for (const pkg of await packagesIn(fs, modules)) {
    let manifest: Manifest;
    try {
      manifest = JSON.parse(await fs.readFile(`${pkg}/package.json`));
    } catch {
      continue;
    }
    const declared = manifest.slicc?.filesystems;
    if (!declared || typeof declared !== 'object') continue;
    for (const [type, entry] of Object.entries(declared)) {
      const module = inside(pkg, (entry as { module?: unknown } | null)?.module);
      if (NAME.test(type) && module && !found.has(type)) found.set(type, module);
    }
  }
  return found;
}

const SUFFIX = /^\.[A-Za-z0-9_+-][A-Za-z0-9._+-]*$/;

export async function scanBinfmts(
  fs: KernelFs,
  modules: string | string[],
  warn: (message: string) => void = () => {},
  owners = new Map<string, string>()
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  for (const pkg of await packagesIn(fs, modules)) {
    let manifest: Manifest;
    try {
      manifest = JSON.parse(await fs.readFile(`${pkg}/package.json`));
    } catch {
      continue;
    }
    const declared = manifest.slicc?.binfmt;
    if (!declared || typeof declared !== 'object') continue;
    for (const [suffix, command] of Object.entries(declared)) {
      if (!SUFFIX.test(suffix) || typeof command !== 'string' || !NAME.test(command)) continue;
      const owner = owners.get(suffix);
      if (owner === undefined) {
        found.set(suffix, command);
        owners.set(suffix, pkg);
      } else if (found.get(suffix) !== command) {
        warn(
          `binfmt ${suffix}: ${owner} maps it to ${found.get(suffix)}, so ${pkg}'s ${command} is ignored`
        );
      }
    }
  }
  return found;
}

export function binfmtSuffix(
  binfmts: ReadonlyMap<string, string>,
  path: string
): string | undefined {
  const name = path.slice(path.lastIndexOf('/') + 1);
  let best: string | undefined;
  for (const suffix of binfmts.keys()) {
    if (name.length > suffix.length && name.endsWith(suffix)) {
      if (best === undefined || suffix.length > best.length) best = suffix;
    }
  }
  return best;
}

export function binfmtOf(binfmts: ReadonlyMap<string, string>, path: string): string | undefined {
  const best = binfmtSuffix(binfmts, path);
  return best === undefined ? undefined : binfmts.get(best);
}
