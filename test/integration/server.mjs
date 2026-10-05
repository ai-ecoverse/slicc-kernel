import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { argv, env } from 'node:process';
import { fileURLToPath } from 'node:url';

const here = (path) => fileURLToPath(new URL(path, import.meta.url));

export const roots = [
  ['/dist/', here('../../dist/')],
  ['/node_modules/@ai-ecoverse/', here('../../node_modules/@ai-ecoverse/')],
  ['/fixtures/', here('./fixtures/')],
  ['/', here('./page/')],
];

export const isolation = {
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-embedder-policy': 'require-corp',
  'cross-origin-resource-policy': 'same-origin',
};

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.mjs': 'text/javascript; charset=utf-8',
};

export function locate(pathname) {
  const [prefix, root] = roots.find(([prefix]) => pathname.startsWith(prefix));
  const rel = pathname.slice(prefix.length);
  const file = join(root, normalize(rel === '' || rel.endsWith('/') ? `${rel}index.html` : rel));
  return file.startsWith(root) ? file : null;
}

export async function serve(port = 0) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const { pathname } = new URL(request.url, 'http://localhost');
    requests.push(pathname);
    const file = locate(decodeURIComponent(pathname));
    const found = file && (await stat(file).catch(() => null))?.isFile();
    if (!found) return response.writeHead(404, isolation).end();
    response.writeHead(200, {
      ...isolation,
      'content-type': types[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    createReadStream(file).pipe(response);
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

if (argv[1] === fileURLToPath(import.meta.url)) {
  const { url } = await serve(Number(env.PORT ?? 8080));
  console.log(`slicc-kernel test page on ${url}`);
}
