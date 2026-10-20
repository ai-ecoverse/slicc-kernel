import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { createScramSha256Data, ScramSha256AuthFlow } from 'pg-gateway';
import { fromNodeSocket } from 'pg-gateway/node';

const PLAIN = 'SCRAM-SHA-256';
const PLUS = 'SCRAM-SHA-256-PLUS';
const END_POINT = 'tls-server-end-point';

function errorFrame(code, message) {
  const fields = Buffer.from(`SFATAL\0C${code}\0M${message}\0\0`, 'latin1');
  const head = Buffer.alloc(5);
  head[0] = 0x45;
  head.writeInt32BE(4 + fields.length, 1);
  return new Uint8Array(Buffer.concat([head, fields]));
}

function initialOf(message) {
  const bytes = Buffer.from(message.buffer ?? message, message.byteOffset ?? 0, message.byteLength);
  const nul = bytes.indexOf(0, 5);
  const mechanism = bytes.subarray(5, nul).toString('latin1');
  const length = bytes.readInt32BE(nul + 1);
  return { mechanism, data: bytes.subarray(nul + 5, nul + 5 + length).toString('latin1') };
}

function negotiated(plus, mechanism, data) {
  const flag = data[0];
  const comma = data.indexOf(',');
  if (mechanism !== PLAIN && !(plus && mechanism === PLUS))
    return { error: 'unsupported SASL mechanism' };
  if (flag === 'p') {
    if (mechanism !== PLUS)
      return { error: 'channel binding was not negotiated: p= without SCRAM-SHA-256-PLUS' };
    if (data.slice(2, comma) !== END_POINT)
      return { error: 'unsupported SCRAM channel-binding type' };
  } else if (mechanism === PLUS) {
    return { error: 'SCRAM-SHA-256-PLUS without p= channel binding' };
  } else if (flag === 'y' && plus) {
    return { error: 'SCRAM channel binding negotiation error' };
  } else if (flag !== 'n' && flag !== 'y') {
    return { error: 'malformed SCRAM message' };
  }
  const second = data.indexOf(',', comma + 1);
  return { header: data.slice(0, second + 1) };
}

let patched = false;

function patchFlow() {
  if (patched) return;
  patched = true;
  const proto = ScramSha256AuthFlow.prototype;
  const { createAuthenticationSASL, handleClientFirstMessage, handleClientFinalMessage } = proto;
  proto.createAuthenticationSASL = function sasl() {
    const plus = this.auth.getScramSha256Data.plus;
    if (!plus) return createAuthenticationSASL.call(this);
    this.writer.addInt32(10);
    for (const name of [PLUS, PLAIN]) this.writer.addCString(name);
    this.writer.addCString('');
    return this.writer.flush(0x52);
  };
  proto.handleClientFirstMessage = async function* first(message) {
    const plus = this.auth.getScramSha256Data.plus;
    if (!plus) return yield* handleClientFirstMessage.call(this, message);
    const { mechanism, data } = initialOf(message);
    const chosen = negotiated(true, mechanism, data);
    if (chosen.error) {
      plus.refused.push(chosen.error);
      yield errorFrame('08P01', chosen.error);
      return;
    }
    plus.header = chosen.header;
    plus.mechanism = mechanism;
    const fixed = Buffer.from(
      message.buffer ?? message,
      message.byteOffset ?? 0,
      message.byteLength
    );
    const nul = fixed.indexOf(0, 5);
    const rebuilt = Buffer.concat([
      fixed.subarray(0, 5),
      Buffer.from(`${PLAIN}\0`, 'latin1'),
      fixed.subarray(nul + 1),
    ]);
    rebuilt.writeInt32BE(rebuilt.length - 1, 1);
    this.reader.setBuffer(new Uint8Array(rebuilt), 1);
    yield* handleClientFirstMessage.call(this, new Uint8Array(rebuilt));
  };
  proto.handleClientFinalMessage = async function* final(message) {
    const plus = this.auth.getScramSha256Data.plus;
    if (plus) {
      const text = Buffer.from(
        message.buffer ?? message,
        message.byteOffset ?? 0,
        message.byteLength
      )
        .subarray(5)
        .toString('latin1');
      const c = text
        .split(',')
        .find((f) => f.startsWith('c='))
        ?.slice(2);
      const cbind = plus.mechanism === PLUS ? plus.binding : Buffer.alloc(0);
      const want = Buffer.concat([Buffer.from(plus.header, 'latin1'), cbind]).toString('base64');
      plus.finals.push(text);
      if (c !== want) {
        plus.refused.push('SCRAM channel binding check failed');
        yield errorFrame('08P01', 'SCRAM channel binding check failed');
        return;
      }
    }
    yield* handleClientFinalMessage.call(this, message);
  };
}

export async function pgFixture(t, cert, password, { signWith, echoFinal, plus } = {}) {
  const data = await createScramSha256Data(password);
  if (signWith) data.serverKey = (await createScramSha256Data(signWith)).serverKey;
  const getScramSha256Data = () => data;
  const binding = plus ? createHash('sha256').update(cert.der).digest() : undefined;
  if (plus) {
    patchFlow();
    getScramSha256Data.plus = { binding, refused: [], finals: [] };
  }
  const seen = { authenticated: 0, messages: [], plus: getScramSha256Data.plus };
  const server = createServer((socket) => {
    socket.on('error', () => {});
    void fromNodeSocket(socket, {
      tls: { key: Buffer.from(cert.key), cert: Buffer.from(cert.cert) },
      auth: { method: 'scram-sha-256', getScramSha256Data },
      onMessage: (bytes) => {
        seen.messages.push(Buffer.from(bytes));
        if (echoFinal && bytes[0] === 0x70 && Buffer.from(bytes).includes('c=biws')) {
          const text = Buffer.from(bytes.subarray(5)).toString('latin1');
          return errorFrame('28P01', `received ${text}`);
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
  return { port: server.address().port, seen, binding };
}
