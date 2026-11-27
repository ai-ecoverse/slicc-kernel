export async function fixtureAdapter() {
  const key = await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']);
  const { crv, kty, x } = await crypto.subtle.exportKey('jwk', key.publicKey);
  const jwk = new TextEncoder().encode(JSON.stringify({ crv, kty, x }));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', jwk));
  const jkt = btoa(String.fromCharCode(...digest))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
  const seen = [];
  const lease = crypto.randomUUID();
  const adapter = {
    async request(params, { stamp }) {
      seen.push({ method: 'request', params, stamp });
      if (params.lease !== undefined && params.lease !== lease) throw { reason: 'E_REVOKED' };
      return { request: 'R1', lease, jkt, reviewCommand: 'must-not-echo' };
    },
    async action(params, { stamp }) {
      seen.push({ method: 'action', params, stamp });
      if (params.lease !== lease)
        throw Object.assign(new Error('must-not-echo'), { reason: 'E_REVOKED' });
      return { result: params.op === 'snapshot' ? { text: 'fixture document' } : {} };
    },
  };
  return { jkt, seen, lease, adapter };
}
