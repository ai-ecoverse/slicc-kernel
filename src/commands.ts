import type { KernelFs } from './fs/types.ts';

export type Abi = 'emscripten' | 'wasi' | 'js';

export interface Command {
  name: string;
  abi: Abi;
  glue: string;
  wasm: string;
  argv0: string;
  argv0Path?: boolean;
  preopenRoot?: boolean;
  args?: string[];
  env?: Record<string, string>;
  unset?: string[];
  script?: string;
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
  slicc?: { abi?: unknown; commands?: unknown; env?: unknown; filesystems?: unknown };
}

const NAME = /^[A-Za-z0-9._+-]+$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PACKAGE = /\$\{package\}/g;

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
  const argv0 = typeof raw.argv0 === 'string' && raw.argv0 ? raw.argv0 : name;
  const args = argsOf(pkg, raw.args);
  if (abi === 'js') {
    const module = inside(pkg, raw.module);
    if (!module) return undefined;
    return { name, abi, glue: module, wasm: module, argv0, ...(args ? { args } : {}), ...withEnv };
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
    if (!NAME.test(name) || name === '.' || name === '..' || !raw || typeof raw !== 'object') {
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
  const dirs: string[] = [];
  for (const name of names) {
    if (name.startsWith('.')) continue;
    if (!name.startsWith('@')) {
      dirs.push(`${modules}/${name}`);
      continue;
    }
    for (const inner of await fs.readdir(`${modules}/${name}`).catch(() => [])) {
      dirs.push(`${modules}/${name}/${inner}`);
    }
  }
  return dirs;
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

export async function scanCommands(
  fs: KernelFs,
  modules: string | string[]
): Promise<Map<string, Command>> {
  const found = new Map<string, Command>();
  for (const pkg of await packagesIn(fs, modules)) {
    let manifest: Manifest;
    try {
      manifest = JSON.parse(await fs.readFile(`${pkg}/package.json`));
    } catch {
      continue;
    }
    for (const command of commandsOf(pkg, manifest)) {
      if (!found.has(command.name))
        found.set(command.name, await withPackagePaths(fs, pkg, command));
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
