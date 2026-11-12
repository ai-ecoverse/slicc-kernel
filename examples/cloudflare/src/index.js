import { DurableObject } from 'cloudflare:workers';
import { createCloudflareKernel } from '../../../dist/cloudflare.js';
import { PACKAGES } from './packages.js';

const HEADER = 'x-slicc-key';

function keyOf(request) {
  const auth = request.headers.get('authorization') ?? '';
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  return request.headers.get(HEADER) ?? new URL(request.url).searchParams.get('key');
}

function same(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function installed(kernel, name, manifest) {
  try {
    const text = new TextDecoder().decode(
      await kernel.readFile(`/node_modules/${name}/package.json`)
    );
    return text === manifest;
  } catch {
    return false;
  }
}

async function install(kernel) {
  let wrote = 0;
  for (const { name, files } of PACKAGES) {
    const { 'package.json': manifest, ...rest } = files;
    if (await installed(kernel, name, manifest)) continue;
    for (const [path, data] of Object.entries(rest)) {
      const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
      await kernel.writeFile(`/node_modules/${name}/${path}`, bytes);
    }
    await kernel.writeFile(`/node_modules/${name}/package.json`, manifest);
    wrote++;
  }
  return wrote;
}

export class Kernel extends DurableObject {
  booting;
  bootMs;
  installed;

  kernel() {
    this.booting ??= (async () => {
      const started = Date.now();
      const storage = this.ctx.storage;
      const kernel = await createCloudflareKernel({
        loader: this.env.LOADER,
        sql: storage.sql,
        sqlite: { transaction: (fn) => storage.transactionSync(fn) },
      });
      this.installed = await install(kernel);
      this.bootMs = Date.now() - started;
      return kernel;
    })().catch((err) => {
      this.booting = undefined;
      throw err;
    });
    return this.booting;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const cold = this.booting === undefined;
    const kernel = await this.kernel();
    if (url.pathname === '/boot') {
      return Response.json({
        cold,
        bootMs: this.bootMs,
        installed: this.installed,
        images: kernel.images.size,
      });
    }
    if (url.pathname !== '/run' || request.method !== 'POST') {
      return new Response('routes: POST /run, GET /boot\n', { status: 404 });
    }
    const body = await request.json();
    if (!Array.isArray(body?.argv) || body.argv.length === 0) {
      return Response.json({ error: 'argv must be a non-empty array' }, { status: 400 });
    }
    const started = Date.now();
    const result = await kernel.run(body.argv, {
      cwd: body.cwd ?? '/root',
      ...(body.stdin !== undefined ? { stdin: body.stdin } : {}),
      ...(body.env ? { env: body.env } : {}),
    });
    return Response.json({
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      ...(result.signal ? { signal: result.signal } : {}),
      ms: Date.now() - started,
      ...(cold ? { bootMs: this.bootMs, installed: this.installed } : {}),
    });
  }
}

export default {
  async fetch(request, env) {
    if (!env.KEY || !same(keyOf(request), env.KEY)) {
      return new Response('forbidden\n', { status: 403 });
    }
    const name = new URL(request.url).searchParams.get('kernel') ?? 'main';
    return env.KERNEL.get(env.KERNEL.idFromName(name)).fetch(request);
  },
};
