export const PG_CLIENT = `const enc = new TextEncoder();
const int32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const latin = (b) => { let s = ''; for (const x of b) s += String.fromCharCode(x); return s; };
const bytesOf = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const b64 = (b) => btoa(latin(b));
const msg = (type, body) => new Uint8Array([type.charCodeAt(0), ...int32(4 + body.length), ...body]);
async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(data)));
}
async function keysFor(password, salt, iterations, auth) {
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const salted = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, 256));
  const clientKey = await hmac(salted, 'Client Key');
  const stored = new Uint8Array(await crypto.subtle.digest('SHA-256', clientKey));
  const sig = await hmac(stored, auth);
  return { proof: b64(clientKey.map((x, i) => x ^ sig[i])), server: b64(await hmac(await hmac(salted, 'Server Key'), auth)) };
}
const received = [];
function reader(r) {
  let buf = new Uint8Array(0);
  return async () => {
    for (;;) {
      if (buf.length >= 5) {
        const len = 1 + ((buf[1] << 24) | (buf[2] << 16) | (buf[3] << 8) | buf[4]);
        if (buf.length >= len) {
          const m = buf.slice(0, len);
          buf = buf.slice(len);
          return m;
        }
      }
      const { value, done } = await r.read();
      if (done) return null;
      received.push(...value);
      const next = new Uint8Array(buf.length + value.length);
      next.set(buf);
      next.set(value, buf.length);
      buf = next;
    }
  };
}
export default async function main(ctx) {
  const o = JSON.parse(ctx.argv[1]);
  const out = { steps: [] };
  const plain = await ctx.net.connect({ host: o.host, port: o.port });
  const pw = plain.writable.getWriter();
  await pw.write(new Uint8Array([...int32(8), ...int32(80877103)]));
  const pr = plain.readable.getReader();
  const s = await pr.read();
  pw.releaseLock();
  pr.releaseLock();
  out.ssl = latin(s.value);
  const c = await ctx.net.connect({ socket: plain, host: o.host, tls: {} });
  out.tls = { verified: c.tls.verified, substitutes: c.tls.substitutes };
  const w = c.writable.getWriter();
  const next = reader(c.readable.getReader());
  const params = enc.encode('user\\0alice\\0database\\0x\\0\\0');
  await w.write(new Uint8Array([...int32(8 + params.length), ...int32(196608), ...params]));
  const r10 = await next();
  out.mechanisms = latin(r10.subarray(9)).split('\\0').filter(Boolean);
  const first = 'n=,r=fixedtestclientnonce';
  const header = o.gs2 === 'p' ? 'p=' + (o.type ?? 'tls-server-end-point') + ',,' : (o.gs2 ?? 'n') + ',,';
  const mechanism = o.gs2 === 'p' ? 'SCRAM-SHA-256-PLUS' : 'SCRAM-SHA-256';
  const initial = header + first;
  await w.write(msg('p', [...enc.encode(mechanism + '\\0'), ...int32(initial.length), ...enc.encode(initial)]));
  const r11 = await next();
  if (String.fromCharCode(r11[0]) === 'E') {
    out.steps.push('E ' + latin(r11.subarray(5)));
    await ctx.write(1, JSON.stringify(out));
    return 0;
  }
  const serverFirst = latin(r11.subarray(9));
  const attrs = Object.fromEntries(serverFirst.split(',').map((a) => [a[0], a.slice(2)]));
  const cbind = o.gs2 === 'p' ? bytesOf(atob(o.binding)) : new Uint8Array(0);
  const finalBare = 'c=' + b64(new Uint8Array([...bytesOf(header), ...cbind])) + ',r=' + attrs.r;
  const auth = first + ',' + serverFirst + ',' + finalBare;
  const k = await keysFor(o.password, bytesOf(atob(attrs.s)), Number(attrs.i), auth);
  await w.write(msg('p', enc.encode(finalBare + ',p=' + k.proof)));
  for (;;) {
    const m = await next().catch((e) => ({ error: e.code }));
    if (!m) break;
    if (m.error) { out.steps.push('error ' + m.error); break; }
    const type = String.fromCharCode(m[0]);
    const code = type === 'R' ? ((m[5] << 24) | (m[6] << 16) | (m[7] << 8) | m[8]) : undefined;
    if (type === 'R' && code === 12) out.steps.push('final ' + (latin(m.subarray(9)) === 'v=' + k.server ? 'ok' : 'mismatch'));
    else if (type === 'E') { out.steps.push('E ' + latin(m.subarray(5))); break; }
    else out.steps.push(type + (code === undefined ? '' : ' ' + code));
    if (type === 'Z') break;
  }
  if (o.dump) out.received = b64(new Uint8Array(received));
  await ctx.write(1, JSON.stringify(out));
  await c.close();
}
`;
