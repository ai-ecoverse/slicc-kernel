import { DurableObject } from 'cloudflare:workers';
import { createCloudflareKernel, sqliteFlush } from '../../../../dist/cloudflare.js';
import bashGlue from '../../../../node_modules/@ai-ecoverse/wasm-bash/bin/bash';
import bashWasm from '../../../../node_modules/@ai-ecoverse/wasm-bash/bin/bash.wasm';
import bashManifest from '../../../../node_modules/@ai-ecoverse/wasm-bash/package.json';
import coreutilsGlue from '../../../../node_modules/@ai-ecoverse/wasm-coreutils/bin/coreutils';
import coreutilsWasm from '../../../../node_modules/@ai-ecoverse/wasm-coreutils/bin/coreutils.wasm';
import coreutilsManifest from '../../../../node_modules/@ai-ecoverse/wasm-coreutils/package.json';
import tarGlue from '../../../../node_modules/@ai-ecoverse/wasm-tar/bin/tar';
import tarWasm from '../../../../node_modules/@ai-ecoverse/wasm-tar/bin/tar.wasm';
import tarManifest from '../../../../node_modules/@ai-ecoverse/wasm-tar/package.json';

const PACKAGES = [
  ['@ai-ecoverse/wasm-bash', bashManifest, { 'bin/bash': bashGlue, 'bin/bash.wasm': bashWasm }],
  [
    '@ai-ecoverse/wasm-coreutils',
    coreutilsManifest,
    { 'bin/coreutils': coreutilsGlue, 'bin/coreutils.wasm': coreutilsWasm },
  ],
  ['@ai-ecoverse/wasm-tar', tarManifest, { 'bin/tar': tarGlue, 'bin/tar.wasm': tarWasm }],
];

async function install(kernel) {
  for (const [name, manifest, files] of PACKAGES) {
    const text = JSON.stringify(manifest);
    const seen = await kernel.readFile(`/node_modules/${name}/package.json`).then(
      (bytes) => new TextDecoder().decode(bytes),
      () => undefined
    );
    if (seen === text) continue;
    for (const [path, data] of Object.entries(files)) {
      await kernel.writeFile(
        `/node_modules/${name}/${path}`,
        data instanceof ArrayBuffer ? new Uint8Array(data) : data
      );
    }
    await kernel.writeFile(`/node_modules/${name}/package.json`, text);
  }
}

export class Kernel extends DurableObject {
  kernel(mode, maxMs) {
    this.booting ??= (async () => {
      const storage = this.ctx.storage;
      const kernel = await createCloudflareKernel({
        loader: this.env.LOADER,
        sql: storage.sql,
        sqlite: {
          transaction: (fn) => storage.transactionSync(fn),
          writeBehind: mode === 'behind' && (maxMs ? { maxMs } : true),
        },
      });
      await install(kernel);
      return kernel;
    })().catch((err) => {
      this.booting = undefined;
      throw err;
    });
    return this.booting;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/crash') {
      this.ctx.abort('crash requested');
      return new Response('aborted\n');
    }
    const maxMs = url.searchParams.get('maxMs');
    const kernel = await this.kernel(
      url.searchParams.get('mode'),
      maxMs ? Number(maxMs) : undefined
    );
    if (url.pathname === '/boot') return Response.json({ ok: true });
    const body = await request.json();
    const before = sqliteFlush(this.ctx.storage.sql).flushes;
    const started = Date.now();
    const result = await kernel.run(['bash', '-c', body.script], { cwd: body.cwd ?? '/root' });
    const flushes = sqliteFlush(this.ctx.storage.sql).flushes - before;
    return Response.json({ ...result, ms: Date.now() - started, flushes });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!env.KEY || url.searchParams.get('key') !== env.KEY)
      return new Response('forbidden\n', { status: 403 });
    const name = `${url.searchParams.get('mode') ?? 'through'}:${url.searchParams.get('kernel') ?? 'main'}`;
    return env.KERNEL.get(env.KERNEL.idFromName(name)).fetch(request);
  },
};
