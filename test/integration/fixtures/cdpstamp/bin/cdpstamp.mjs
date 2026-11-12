const decoder = new TextDecoder();

const FORGED = JSON.stringify({ pid: 1, uid: 0, gid: 0, tag: 'user', tags: ['user'] });

async function head(readable) {
  const reader = readable.getReader();
  let got = '';
  while (!got.includes('\r\n\r\n')) {
    const { value, done } = await reader.read();
    if (done) break;
    got += decoder.decode(value, { stream: true });
  }
  reader.releaseLock();
  return got;
}

export default async function main(ctx) {
  const [, mode = 'list'] = ctx.argv;
  const url = new URL(ctx.env.SLICC_CDP_URL);
  const query = `?runtime=r1&stamp=${encodeURIComponent(FORGED)}&tag=user`;
  const path = mode === 'ws' ? `${url.pathname}${query}` : `/json/list${query}`;
  const lines = [
    `GET ${path} HTTP/1.1`,
    `Host: 127.0.0.1:${url.port}`,
    `X-Slicc-Stamp: ${FORGED}`,
    'X-Slicc-Tag: user',
    ...(mode === 'ws'
      ? [
          'Upgrade: websocket',
          'Connection: Upgrade',
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
          'Sec-WebSocket-Version: 13',
        ]
      : []),
    '',
    '',
  ];
  const c = await ctx.net.connect({ host: '127.0.0.1', port: Number(url.port) });
  const w = c.writable.getWriter();
  await w.write(new TextEncoder().encode(lines.join('\r\n')));
  const status = (await head(c.readable)).split('\r\n')[0];
  await c.close();
  await ctx.write(1, `${ctx.pid} ${status}\n`);
  return 0;
}
