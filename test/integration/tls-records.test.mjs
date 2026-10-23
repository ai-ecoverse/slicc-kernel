import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNodeKernel } from '../../dist/node.js';

const PROGRAM = `export default async function main(ctx) {
  const replies = JSON.parse(ctx.argv[1]).map((b) => Uint8Array.from(atob(b), (c) => c.charCodeAt(0)));
  const out = [];
  const l = await ctx.net.listen({});
  for (const reply of replies) {
    const acc = l.accept();
    const dialling = ctx.net.connect({ host: 'localhost', port: l.port, tls: {} }).then(
      () => 'connected',
      (e) => e.code
    );
    const s = await acc;
    const w = s.writable.getWriter();
    await w.write(reply);
    await w.close();
    out.push(await dialling);
    await s.close();
  }
  await l.close();
  ctx.write(1, JSON.stringify(out));
  return 0;
}
`;

test('a kernel TLS client tells a non-TLS reply apart as Node 22 does: wrong version, packet or data length too long, an HTTP request, an unexpected message (#1548)', async (t) => {
  const kernel = await createNodeKernel({ users: 'off' });
  t.after(() => kernel.terminate());
  const base = new URL('../../node_modules/@ai-ecoverse/wasm-tls-engine/', import.meta.url);
  for (const e of (await readdir(base, { recursive: true, withFileTypes: true })).filter((x) =>
    x.isFile()
  )) {
    const f = join(e.parentPath, e.name);
    await kernel.writeFile(
      `/node_modules/@ai-ecoverse/wasm-tls-engine/${relative(fileURLToPath(base), f)}`,
      await readFile(f)
    );
  }
  await kernel.writeFile(
    '/node_modules/rec/package.json',
    JSON.stringify({ name: 'rec', slicc: { commands: { rec: { abi: 'js', module: 'r.mjs' } } } })
  );
  await kernel.writeFile('/node_modules/rec/r.mjs', PROGRAM);
  const cases = [
    ['nope\n', 'ERR_SSL_PACKET_LENGTH_TOO_LONG'],
    ['HTTP/1.1 400 Bad Request\r\n\r\n', 'ERR_SSL_PACKET_LENGTH_TOO_LONG'],
    ['* OK IMAP ready\r\n', 'ERR_SSL_PACKET_LENGTH_TOO_LONG'],
    ['220 smtp.example ESMTP ready\r\n', 'ERR_SSL_WRONG_VERSION_NUMBER'],
    ['SSH-2.0-OpenSSH_9.6\r\n', 'ERR_SSL_WRONG_VERSION_NUMBER'],
    ['+OK POP3 ready\r\n', 'ERR_SSL_WRONG_VERSION_NUMBER'],
    ['\0\0\0\0\0\0', 'ERR_SSL_WRONG_VERSION_NUMBER'],
    ['\x16\x03\x03\x40\x01', 'ERR_SSL_DATA_LENGTH_TOO_LONG'],
    ['\x16\x03\x01\x00\x05hello', 'ERR_SSL_UNEXPECTED_MESSAGE'],
    ['\x80\x00\x02\x00\x00', 'ERR_SSL_WRONG_VERSION_NUMBER'],
    ['GET / HTTP/1.1\r\n', 'ERR_SSL_HTTP_REQUEST'],
    ['PUT /x HTTP/1.1\r\n', 'ERR_SSL_HTTP_REQUEST'],
    ['CONNECT x:443 HTTP/1.1\r\n', 'ERR_SSL_PACKET_LENGTH_TOO_LONG'],
  ];
  const b64 = cases.map(([text]) => Buffer.from(text, 'latin1').toString('base64'));
  const r = await kernel.run(['rec', JSON.stringify(b64)], { cwd: '/' });
  assert.equal(r.stderr, '');
  assert.deepEqual(
    JSON.parse(r.stdout),
    cases.map(([, code]) => code)
  );
});
