import { createServer } from 'node:net';
import { createScramSha256Data } from 'pg-gateway';
import { fromNodeSocket } from 'pg-gateway/node';

export async function pgFixture(t, cert, password, { signWith, echoFinal } = {}) {
  const data = await createScramSha256Data(password);
  if (signWith) data.serverKey = (await createScramSha256Data(signWith)).serverKey;
  const seen = { authenticated: 0, messages: [] };
  const server = createServer((socket) => {
    socket.on('error', () => {});
    void fromNodeSocket(socket, {
      tls: { key: Buffer.from(cert.key), cert: Buffer.from(cert.cert) },
      auth: { method: 'scram-sha-256', getScramSha256Data: () => data },
      onMessage: (bytes) => {
        seen.messages.push(Buffer.from(bytes));
        if (echoFinal && bytes[0] === 0x70 && Buffer.from(bytes).includes('c=biws')) {
          const text = Buffer.from(bytes.subarray(5)).toString('latin1');
          const fields = Buffer.from(`SFATAL\0C28P01\0Mreceived ${text}\0\0`, 'latin1');
          const head = Buffer.alloc(5);
          head[0] = 0x45;
          head.writeInt32BE(4 + fields.length, 1);
          return Buffer.concat([head, fields]);
        }
        return undefined;
      },
      onAuthenticated: () => {
        seen.authenticated += 1;
      },
    }).catch(() => {});
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  return { port: server.address().port, seen };
}
