import type { KernelFs } from './fs/types.ts';

export interface Command {
  name: string;
  glue: string;
  wasm: string;
  argv0: string;
  args?: string[];
  env?: Record<string, string>;
}

interface CommandEntry {
  abi?: unknown;
  glue?: unknown;
  wasm?: unknown;
  argv0?: unknown;
  args?: unknown;
  env?: unknown;
}

interface Manifest {
  slicc?: { abi?: unknown; commands?: unknown; env?: unknown };
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

function envOf(pkg: string, raw: unknown): Record<string, string> {
  const env: Record<string, string> = {};
  if (!raw || typeof raw !== 'object') return env;
  for (const [key, value] of Object.entries(raw)) {
    if (ENV_KEY.test(key) && typeof value === 'string') env[key] = value.replace(PACKAGE, pkg);
  }
  return env;
}

function argsOf(pkg: string, raw: unknown): string[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  if (!raw.every((arg) => typeof arg === 'string')) return undefined;
  return raw.map((arg) => arg.replace(PACKAGE, pkg));
}

export function commandsOf(pkg: string, manifest: Manifest): Command[] {
  const slicc = manifest.slicc;
  if (!slicc || typeof slicc !== 'object' || (slicc.abi ?? 'emscripten') !== 'emscripten')
    return [];
  const entries = slicc.commands;
  if (!entries || typeof entries !== 'object') return [];
  const shared = envOf(pkg, slicc.env);
  const out: Command[] = [];
  for (const [name, raw] of Object.entries(entries as Record<string, CommandEntry>)) {
    if (!NAME.test(name) || name === '.' || name === '..' || !raw || typeof raw !== 'object') {
      continue;
    }
    const glue = inside(pkg, raw.glue);
    const wasm = inside(pkg, raw.wasm);
    if ((raw.abi ?? 'emscripten') !== 'emscripten' || !glue || !wasm) continue;
    const argv0 = typeof raw.argv0 === 'string' && raw.argv0 ? raw.argv0 : name;
    const args = argsOf(pkg, raw.args);
    const env = { ...shared, ...envOf(pkg, raw.env) };
    out.push({
      name,
      glue,
      wasm,
      argv0,
      ...(args ? { args } : {}),
      ...(Object.keys(env).length > 0 ? { env } : {}),
    });
  }
  return out;
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

export async function scanCommands(fs: KernelFs, modules: string): Promise<Map<string, Command>> {
  const found = new Map<string, Command>();
  for (const pkg of await packages(fs, modules)) {
    let manifest: Manifest;
    try {
      manifest = JSON.parse(await fs.readFile(`${pkg}/package.json`));
    } catch {
      continue;
    }
    for (const command of commandsOf(pkg, manifest)) {
      if (!found.has(command.name)) found.set(command.name, command);
    }
  }
  if (!found.has('sh') && found.has('bash')) {
    found.set('sh', { ...(found.get('bash') as Command), name: 'sh', argv0: 'sh' });
  }
  return found;
}
