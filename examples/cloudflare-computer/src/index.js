import { DurableObject } from 'cloudflare:workers';
import { Workspace } from '@cloudflare/computer';
import {
  attachKernel,
  compiledTlsEngine,
  createCloudflareKernel,
  fetchTransport,
  sliccBackend,
} from '../../../dist/cloudflare.js';
import createTlsEngine from '../../../node_modules/@ai-ecoverse/wasm-tls-engine/dist/slicc-tls-engine.mjs';
import tlsWasm from '../../../node_modules/@ai-ecoverse/wasm-tls-engine/dist/slicc-tls-engine.wasm';
import { PACKAGES } from './packages.js';

const MOUNT = '/workspace';
const ECHO = 'echo.test';

function outbound(url, init) {
  if (new URL(url).hostname !== ECHO) return fetch(url, init);
  return new Response(`${init.method} ${url}\n`, { headers: { 'x-answered-by': 'the Worker' } });
}

function keyOf(request) {
  const auth = request.headers.get('authorization') ?? '';
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  return request.headers.get('x-slicc-key') ?? new URL(request.url).searchParams.get('key');
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

function inside(path) {
  if (typeof path !== 'string' || !path.startsWith('/')) return undefined;
  return path;
}

function failure(err, status = 500) {
  return Response.json(
    { error: err instanceof Error ? err.message : String(err), code: err?.code },
    { status: err?.code === 'ENOENT' ? 404 : status }
  );
}

function ndjson(handle) {
  const encoder = new TextEncoder();
  return new Response(
    handle.pipeThrough(
      new TransformStream({
        transform(event, controller) {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        },
      })
    ),
    { headers: { 'content-type': 'application/x-ndjson', 'x-exec-id': handle.id } }
  );
}

export class Computer extends DurableObject {
  booting;
  installed;
  workspace;
  opened = 0;

  constructor(ctx, env) {
    super(ctx, env);
    this.workspace = this.open();
  }

  now() {
    return Date.now();
  }

  kernel() {
    this.booting ??= (async () => {
      const storage = this.ctx.storage;
      const self = () => this.env.COMPUTER.get(this.ctx.id);
      const kernel = await createCloudflareKernel({
        loader: this.env.LOADER,
        clock: () => self().now(),
        sql: storage.sql,
        sqlite: { transaction: (fn) => storage.transactionSync(fn) },
        network: {
          transport: fetchTransport({ fetch: outbound, redirect: 'manual' }),
          tlsEngine: compiledTlsEngine(createTlsEngine, tlsWasm),
        },
      });
      this.installed = await install(kernel);
      return kernel;
    })().catch((err) => {
      this.booting = undefined;
      throw err;
    });
    return this.booting;
  }

  open() {
    this.opened++;
    return new Workspace({
      storage: this.ctx.storage,
      sessionId: this.ctx.id.toString(),
      backends: [sliccBackend({ kernel: () => this.kernel(), mountPoint: MOUNT })],
    });
  }

  async exec(request) {
    const body = await request.json();
    if (typeof body?.source !== 'string') {
      return Response.json({ error: 'source must be a string' }, { status: 400 });
    }
    const handle = await this.workspace.runtime.exec(body.source, {
      backend: 'slicc',
      encoding: 'utf8',
      ...(body.id ? { id: body.id } : {}),
      ...(body.cwd ? { cwd: body.cwd } : {}),
      ...(body.env ? { env: body.env } : {}),
      ...(body.stdin !== undefined ? { stdin: body.stdin } : {}),
      ...(body.timeoutMs !== undefined ? { timeoutMs: body.timeoutMs } : {}),
    });
    if (body.stream) return ndjson(handle);
    const result = await handle.result();
    return Response.json({
      id: handle.id,
      status: result.status,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    });
  }

  async client(request) {
    const body = await request.json();
    const kernel = await this.kernel();
    const client = await attachKernel(await kernel.connect(), { locks: null });
    try {
      const stdout = [];
      const stderr = [];
      const stdin = Uint8Array.from(atob(body.stdinBase64 ?? ''), (c) => c.charCodeAt(0));
      const child = await client.spawn(body.argv, {
        cwd: body.cwd ?? '/root',
        stdin,
        onStdout: (bytes) => stdout.push(bytes),
        onStderr: (bytes) => stderr.push(bytes),
      });
      const ended = await child.ended;
      const text = (parts) =>
        new TextDecoder().decode(new Uint8Array(parts.flatMap((p) => [...p])));
      let wrote;
      if (body.write) {
        await client.fs.writeFile(body.write.path, body.write.text);
        wrote = await client.fs.readText(body.write.path);
      }
      return Response.json({
        status: ended.status,
        stdout: text(stdout),
        stderr: text(stderr),
        ...(body.write ? { wrote } : {}),
        ...(body.read ? { read: await client.fs.readText(body.read) } : {}),
      });
    } finally {
      await client.close();
    }
  }

  async route(request, url) {
    const path = inside(url.searchParams.get('path') ?? '');
    switch (`${request.method} ${url.pathname}`) {
      case 'GET /boot': {
        const cold = this.booting === undefined;
        const kernel = await this.kernel();
        await this.workspace.ready('slicc');
        return Response.json({
          cold,
          installed: this.installed,
          images: kernel.images.size,
          opened: this.opened,
          mounts: (await kernel.mounts()).map((entry) => `${entry.type} ${entry.target}`),
        });
      }
      case 'PUT /file':
        if (!path) return Response.json({ error: 'path must be absolute' }, { status: 400 });
        await this.workspace.fs.mkdir(path.slice(0, path.lastIndexOf('/')) || '/', {
          recursive: true,
        });
        await this.workspace.fs.writeFile(path, new Uint8Array(await request.arrayBuffer()));
        return Response.json({ path, size: (await this.workspace.fs.stat(path)).size });
      case 'GET /file':
        if (!path) return Response.json({ error: 'path must be absolute' }, { status: 400 });
        return new Response(await this.workspace.fs.readFile(path));
      case 'POST /exec':
        return this.exec(request);
      case 'POST /client':
        return this.client(request);
      case 'POST /kill': {
        const body = await request.json();
        await this.workspace.runtime.killExec(body.id, {
          backend: 'slicc',
          ...(body.signal ? { signal: body.signal } : {}),
        });
        return Response.json({ killed: body.id });
      }
      case 'POST /reopen': {
        const close = url.searchParams.get('close') !== 'false';
        if (close) await this.workspace.close();
        this.workspace = this.open();
        return Response.json({ closed: close, opened: this.opened });
      }
      case 'POST /abort':
        this.ctx.abort('restart requested');
        return Response.json({ aborted: true });
      default:
        return new Response(
          'routes: GET /boot, PUT|GET /file?path=, POST /exec, POST /client, POST /kill, POST /reopen, POST /abort\n',
          { status: 404 }
        );
    }
  }

  async fetch(request) {
    try {
      return await this.route(request, new URL(request.url));
    } catch (err) {
      return failure(err);
    }
  }
}

export default {
  async fetch(request, env) {
    if (env.EXPIRES && Date.now() > Number(env.EXPIRES)) {
      return new Response('this staging Worker has expired\n', { status: 410 });
    }
    if (!env.KEY || !same(keyOf(request), env.KEY)) {
      return new Response('forbidden\n', { status: 403 });
    }
    const name = new URL(request.url).searchParams.get('computer') ?? 'main';
    return env.COMPUTER.get(env.COMPUTER.idFromName(name)).fetch(request);
  },
};
