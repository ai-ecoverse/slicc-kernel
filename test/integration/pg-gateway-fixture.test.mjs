import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PG_CLIENT } from './pg-client-program.mjs';
import { pgFixture } from './pg-fixture.mjs';
import { makeCa } from './test-certs.mjs';

test('the pg-gateway SCRAM fixture listens and the client program source is there, for the sealed SCRAM rows (#1090)', async (t) => {
  const db = await pgFixture(t, makeCa().server('db.test'), 'TEST-ONLY-SEALED-VALUE-1');
  assert.ok(db.port > 0);
  assert.equal(db.seen.authenticated, 0);
  assert.match(PG_CLIENT, /SCRAM-SHA-256/);
});
