import { readdir, readFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const STUB = `data:text/javascript,${encodeURIComponent(
  [
    'export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
    'export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }',
    'export class RpcTarget {}',
  ].join('\n')
)}`;

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'cloudflare:workers') return { url: STUB, shortCircuit: true };
    return next(specifier, context);
  },
});

export const repo = new URL('../../../', import.meta.url).pathname;

const computer = await import('@cloudflare/computer');
export const { Workspace } = computer;
export const { createNodeKernel } = await import(join(repo, 'dist/node.js'));
export const { sliccBackend, workspaceDriver } = await import(join(repo, 'dist/cloudflare.js'));

const bindable = (value) => {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
};

export function nodeStorage() {
  const db = new DatabaseSync(':memory:');
  const cache = new Map();
  return {
    sql: {
      exec(query, ...bindings) {
        let stmt = cache.get(query);
        if (!stmt) {
          stmt = db.prepare(query);
          cache.set(query, stmt);
        }
        const rows = stmt.all(...bindings.map(bindable)) ?? [];
        return { toArray: () => rows };
      },
    },
    transactionSync(closure) {
      db.exec('BEGIN');
      try {
        const result = closure();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    close: () => db.close(),
  };
}

async function install(kernel, name) {
  const from = join(repo, 'node_modules', name);
  async function walk(rel) {
    for (const entry of await readdir(join(from, rel), { withFileTypes: true })) {
      const at = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(at);
      else await kernel.writeFile(`/node_modules/${name}/${at}`, await readFile(join(from, at)));
    }
  }
  await walk('');
}

export async function shellKernel() {
  const kernel = await createNodeKernel();
  for (const name of ['@ai-ecoverse/wasm-bash', '@ai-ecoverse/wasm-coreutils']) {
    await install(kernel, name);
  }
  return kernel;
}

export async function computerWith(options = {}) {
  const kernel = options.kernel ?? (await shellKernel());
  const storage = nodeStorage();
  const slicc = sliccBackend({ kernel: () => kernel, ...options.backend });
  const wrap = options.wrapFs;
  const backend = wrap
    ? {
        id: slicc.id,
        type: slicc.type,
        callable: slicc.callable,
        description: slicc.description,
        connect: (host) => slicc.connect({ fs: wrap(host.fs) }),
      }
    : slicc;
  const workspace = new Workspace({ storage, backends: [backend] });
  await workspace.ready();
  return {
    kernel,
    backend,
    workspace,
    async close() {
      await workspace.close();
      kernel.terminate();
      storage.close();
    },
  };
}

export async function run(workspace, source, options = {}) {
  const handle = await workspace.runtime.exec(source, {
    backend: 'slicc',
    encoding: 'utf8',
    ...options,
  });
  return handle.result();
}
