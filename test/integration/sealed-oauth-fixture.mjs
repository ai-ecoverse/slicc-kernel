import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import wabtInit from 'wabt';
import { attachKernel } from '../../dist/node.js';

export const PH = 'fnox_proxy_0123456789abcdef01234567';
export const ID = { name: 'EXAMPLE_TOKEN', provider: 'example', account: 'default' };
export const GRANT = {
  v: 1,
  op: 'oauthGrant',
  ...ID,
  accessToken: 'fake-access-token',
  refreshToken: 'fake-refresh-token',
  tokenType: 'Bearer',
  expiresAt: 1800003600000,
  oauth: {
    tokenUrl: 'https://auth.example.invalid/token',
    clientId: 'example-public-client',
    authMethod: 'none',
    scope: 'read',
    resource: 'https://api.example.invalid/',
  },
};
export const STATUS = {
  v: 1,
  placeholder: PH,
  state: 'ready',
  expiresAt: GRANT.expiresAt,
  refreshable: true,
};
export const EIO = { v: 1, error: { code: 'EIO', message: 'Invalid vault reply' } };

const SCRIPT = `export default async function(ctx) {
  const parts = [];
  for (;;) {
    const bytes = await ctx.read(0, 70000);
    if (!bytes.length) break;
    parts.push(bytes);
  }
  const input = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of parts) { input.set(part, offset); offset += part.length; }
  const fd = await ctx.open('/dev/sealed', { read: true, write: true });
  if (ctx.argv[1] === 'interrupt') await ctx.signals.on('SIGUSR1', () => ctx.write(1, 'handled\\n'));
  try {
    await ctx.write(fd.fd, input);
    if (ctx.argv[1] === 'replace') await ctx.write(fd.fd, input);
    if (ctx.argv[1] === 'close') { await fd.close(); await ctx.write(1, 'closed'); return 0; }
    for (;;) {
      const part = await ctx.read(fd.fd, 17);
      if (!part.length) break;
      await ctx.write(1, part);
    }
  } catch (err) {
    await ctx.write(1, JSON.stringify({ errno: err.code }));
    return 2;
  } finally { await fd.close().catch(() => {}); }
  return 0;
}`;

const WASI = `(module
  (import "wasi_snapshot_preview1" "fd_read" (func $read (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_write" (func $write (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "path_open" (func $open (param i32 i32 i32 i32 i32 i64 i64 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "proc_exit" (func $exit (param i32)))
  (memory (export "memory") 3)
  (data (i32.const 32) "dev/sealed")
  (func $check (param $code i32) (if (local.get $code) (then (call $exit (local.get $code)))))
  (func (export "_start") (local $length i32) (local $fd i32)
    (loop $input
      (i32.store (i32.const 64) (i32.add (i32.const 4096) (local.get $length)))
      (i32.store (i32.const 68) (i32.sub (i32.const 70000) (local.get $length)))
      (call $check (call $read (i32.const 0) (i32.const 64) (i32.const 1) (i32.const 80)))
      (local.set $length (i32.add (local.get $length) (i32.load (i32.const 80))))
      (br_if $input (i32.load (i32.const 80))))
    (call $check (call $open (i32.const 3) (i32.const 0) (i32.const 32) (i32.const 10) (i32.const 0) (i64.const 66) (i64.const 0) (i32.const 0) (i32.const 16)))
    (local.set $fd (i32.load (i32.const 16)))
    (i32.store (i32.const 64) (i32.const 4096))
    (i32.store (i32.const 68) (i32.const 10))
    (i32.store (i32.const 72) (i32.const 4106))
    (i32.store (i32.const 76) (i32.sub (local.get $length) (i32.const 10)))
    (call $check (call $write (local.get $fd) (i32.const 64) (i32.const 2) (i32.const 80)))
    (loop $output
      (i32.store (i32.const 64) (i32.const 4096))
      (i32.store (i32.const 68) (i32.const 17))
      (call $check (call $read (local.get $fd) (i32.const 64) (i32.const 1) (i32.const 80)))
      (i32.store (i32.const 68) (i32.load (i32.const 80)))
      (if (i32.load (i32.const 80)) (then
        (call $check (call $write (i32.const 1) (i32.const 64) (i32.const 1) (i32.const 80)))
        (br $output))))))`;

async function install(kernel, name) {
  const base = new URL(`../../node_modules/@ai-ecoverse/${name}/`, import.meta.url);
  for (const entry of await readdir(base, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = join(entry.parentPath, entry.name);
    await kernel.writeFile(
      `/node_modules/@ai-ecoverse/${name}/${relative(fileURLToPath(base), file)}`,
      await readFile(file)
    );
  }
}

export async function boot(t, create, sealed) {
  const kernel = await create({ users: 'enforce', sealed, network: false });
  t.after(() => kernel.terminate());
  await kernel.writeFile(
    '/node_modules/oauth-probe/package.json',
    JSON.stringify({
      name: 'oauth-probe',
      slicc: {
        commands: {
          'oauth-js': { abi: 'js', module: 'main.mjs' },
          'oauth-wasi': { abi: 'wasi', wasm: 'main.wasm' },
        },
      },
    })
  );
  await kernel.writeFile('/node_modules/oauth-probe/main.mjs', SCRIPT);
  const wabt = await wabtInit();
  const mod = wabt.parseWat('oauth-probe.wat', WASI);
  await kernel.writeFile(
    '/node_modules/oauth-probe/main.wasm',
    new Uint8Array(mod.toBinary({}).buffer)
  );
  mod.destroy();
  await kernel.users.add({ name: 'cone' });
  const run = async (request, command = 'oauth-js', options = {}) => {
    const result = await kernel.run([command], {
      cwd: '/',
      user: 'cone',
      stdin:
        typeof request === 'string' || request instanceof Uint8Array
          ? request
          : JSON.stringify(request),
      ...options,
    });
    assert.equal(result.stderr, '');
    return result;
  };
  return { kernel, run };
}

export function oauthDeviceTests(create) {
  test('atomic OAuth payload and all new operations cross real JS and WASI devices with kernel writer identity', async (t) => {
    const seen = [];
    const { run } = await boot(t, create, async (req) => {
      seen.push(req);
      if (req.op === 'capabilities') return { v: 1, capabilities: { kernelOAuth: 1 } };
      if (req.op === 'oauthRemove') return { v: 1, removed: true };
      return STATUS;
    });
    for (const command of ['oauth-js', 'oauth-wasi']) {
      for (const request of [
        { v: 1, op: 'capabilities' },
        GRANT,
        ...['oauthStatus', 'oauthRefresh', 'oauthRemove'].map((op) => ({ v: 1, op, ...ID })),
      ]) {
        const result = await run(
          { ...request, caller: { uid: 0, pid: 999, users: 'off', tag: 'forged' } },
          command,
          { tag: 'trusted-launch' }
        );
        assert.equal(result.status, 0);
        const answer = JSON.parse(result.stdout);
        assert.deepEqual(
          answer,
          request.op === 'capabilities'
            ? { v: 1, capabilities: { kernelOAuth: 1 } }
            : request.op === 'oauthRemove'
              ? { v: 1, removed: true }
              : STATUS
        );
        const { caller, ...fields } = seen.at(-1);
        assert.deepEqual(fields, request);
        assert.equal(caller.uid, 1000);
        assert.notEqual(caller.pid, 999);
        assert.equal(caller.user, 'cone');
        assert.equal(caller.users, 'enforce');
        assert.equal(caller.tag, 'trusted-launch');
        assert.equal(result.stdout.includes(GRANT.accessToken), false);
        assert.equal(result.stdout.includes(GRANT.refreshToken), false);
      }
    }
    assert.equal(seen.length, 10);
  });

  test('device schema validation denies version skew, internal ops, nested identity and unsupported secrets before the hook', async (t) => {
    const seen = [];
    const { run } = await boot(t, create, async (req) => {
      seen.push(req);
      return STATUS;
    });
    const invalid = [
      'null',
      '[]',
      '{',
      new Uint8Array([0xff]),
      { ...GRANT, v: 2 },
      { ...GRANT, op: 'unknown' },
      ...['materializeConsume', 'sessionMaterialize', 'sessionAnchors'].map((op) => ({ v: 1, op })),
      ...['stamp', 'kernelOAuth', 'source', 'kind', 'grant', 'url'].map((key) => ({
        ...GRANT,
        [key]: 'forged',
      })),
      { ...GRANT, oauth: { ...GRANT.oauth, stamp: { uid: 0 } } },
      { v: 1, op: 'oauthRefresh', ...ID, oauth: GRANT.oauth },
      { v: 1, op: 'capabilities', name: ID.name },
      { ...GRANT, expiresAt: -1 },
      { ...GRANT, expiresAt: 1.5 },
      { ...GRANT, expiresAt: Number.MAX_SAFE_INTEGER + 1 },
      { ...GRANT, provider: 'mcp:example' },
      { ...GRANT, provider: 'example.io' },
      { ...GRANT, name: '1TOKEN' },
      { ...GRANT, account: 'bad\u0000account' },
      { ...GRANT, oauth: null },
      { ...GRANT, refreshToken: '' },
      { ...GRANT, tokenType: 1 },
    ];
    for (const request of invalid) {
      const result = await run(request);
      assert.equal(result.status, 2);
      assert.deepEqual(JSON.parse(result.stdout), { errno: 'EINVAL' });
    }
    for (const request of [
      ...['auth', 'clientSecret', 'fields'].map((key) => ({ ...GRANT, [key]: 'fake-secret' })),
      { ...GRANT, oauth: { ...GRANT.oauth, clientSecret: 'fake-secret' } },
      { ...GRANT, oauth: { ...GRANT.oauth, authMethod: 'client_secret_post' } },
      { ...GRANT, tokenType: 'DPoP' },
    ])
      assert.deepEqual(JSON.parse((await run(request)).stdout), { errno: 'ENOTSUP' });
    assert.equal(seen.length, 0);
    const minimal = {
      ...GRANT,
      refreshToken: undefined,
      expiresAt: undefined,
      tokenType: 'bEaReR',
      oauth: { tokenUrl: GRANT.oauth.tokenUrl, clientId: GRANT.oauth.clientId, authMethod: 'none' },
    };
    assert.equal((await run(minimal)).status, 0);
    assert.equal(seen.length, 1);
  });

  test('one write is one frame and the 64 KiB limit is enforced for actual JS and WASI devices', async (t) => {
    let calls = 0;
    const { run } = await boot(t, create, async () => {
      calls++;
      return STATUS;
    });
    const raw = JSON.stringify({ ...GRANT, accessToken: '' });
    const size = 65536 - new TextEncoder().encode(raw).length;
    const exact = JSON.stringify({ ...GRANT, accessToken: 'x'.repeat(size) });
    assert.equal(new TextEncoder().encode(exact).length, 65536);
    for (const command of ['oauth-js', 'oauth-wasi']) {
      assert.equal((await run(exact, command)).status, 0);
      const bad = await run(`${exact} `, command);
      assert.notEqual(bad.status, 0);
      if (command === 'oauth-js') assert.deepEqual(JSON.parse(bad.stdout), { errno: 'EMSGSIZE' });
    }
    assert.deepEqual(
      JSON.parse((await run(`${JSON.stringify(GRANT)}${JSON.stringify(GRANT)}`)).stdout),
      { errno: 'EINVAL' }
    );
    assert.equal(calls, 2);
  });

  test('new replies reject raw fields, wrong versions and malformed success or error shapes without leaking values', async (t) => {
    let reply;
    const { run } = await boot(t, create, async () => {
      if (reply instanceof Error) throw reply;
      return reply;
    });
    const bad = [
      undefined,
      null,
      [],
      false,
      'fake-refresh-token',
      { ...STATUS, v: 2 },
      { ...STATUS, v: undefined },
      { ...STATUS, accessToken: GRANT.accessToken },
      { ...STATUS, refreshToken: GRANT.refreshToken },
      { ...STATUS, oauth: GRANT.oauth },
      { ...STATUS, expiresAt: undefined },
      { ...STATUS, expiresAt: -1 },
      { ...STATUS, expiresAt: 1.5 },
      { ...STATUS, refreshable: 1 },
      { ...STATUS, state: 'active' },
      { ...STATUS, placeholder: 'fnox_proxy_SECRET' },
      { v: 1, error: { code: 'UNKNOWN', message: GRANT.refreshToken } },
      { v: 1, error: { code: 'EACCES', cause: GRANT.refreshToken, message: 'fake-message' } },
      { v: 1, error: { code: 'EACCES', message: 3 } },
      { v: 1, error: { code: 'EACCES', value: GRANT.refreshToken } },
      { v: 1, error: 'fake-refresh-token' },
      { v: 1, error: { code: 'EIO' }, value: GRANT.accessToken },
      new Error(`${GRANT.refreshToken}\n${GRANT.accessToken}`),
      {
        get v() {
          throw new Error(GRANT.refreshToken);
        },
      },
    ];
    for (reply of bad) {
      const result = await run({ v: 1, op: 'oauthStatus', ...ID });
      assert.equal(result.status, 0);
      assert.deepEqual(JSON.parse(result.stdout), EIO);
    }
    let codeReads = 0;
    let causeReads = 0;
    reply = {
      v: 1,
      error: {
        get code() {
          return ++codeReads === 1 ? 'EACCES' : GRANT.refreshToken;
        },
        get cause() {
          return ++causeReads === 1 ? 'vault-locked' : GRANT.accessToken;
        },
        message: GRANT.refreshToken,
      },
    };
    assert.deepEqual(JSON.parse((await run(GRANT)).stdout), {
      v: 1,
      error: { code: 'EACCES', cause: 'vault-locked', message: 'Vault is locked' },
    });
    assert.equal(codeReads, 1);
    assert.equal(causeReads, 1);
    reply = { v: 1, error: { code: 'EACCES', cause: 'vault-locked', message: GRANT.refreshToken } };
    assert.deepEqual(JSON.parse((await run(GRANT)).stdout), {
      v: 1,
      error: { code: 'EACCES', cause: 'vault-locked', message: 'Vault is locked' },
    });
    for (const state of [
      'ready',
      'refreshing',
      'expired',
      'reauth-required',
      'removed',
      'locked',
    ]) {
      reply = { ...STATUS, state, expiresAt: null, refreshable: false };
      assert.deepEqual(JSON.parse((await run({ v: 1, op: 'oauthStatus', ...ID })).stdout), reply);
    }
    for (reply of [
      { v: 2, capabilities: { kernelOAuth: 1 } },
      { v: 1, capabilities: { kernelOAuth: true } },
      { v: 1, capabilities: { kernelOAuth: 2 } },
      { v: 1, capabilities: { kernelOAuth: 1, extra: 1 } },
    ])
      assert.deepEqual(JSON.parse((await run({ v: 1, op: 'capabilities' })).stdout), EIO);
    reply = { v: 1, capabilities: {} };
    assert.deepEqual(JSON.parse((await run({ v: 1, op: 'capabilities' })).stdout), reply);
    for (reply of [
      { v: 1, removed: false },
      { v: 1, removed: true, token: GRANT.refreshToken },
    ])
      assert.deepEqual(JSON.parse((await run({ v: 1, op: 'oauthRemove', ...ID })).stdout), EIO);
  });

  test('OAuth errors require an own string message while legacy error envelopes stay unchanged', async (t) => {
    let reply;
    const { run } = await boot(t, create, async () => reply);
    const requests = [
      { v: 1, op: 'capabilities' },
      GRANT,
      ...['oauthStatus', 'oauthRefresh', 'oauthRemove'].map((op) => ({ v: 1, op, ...ID })),
    ];
    for (const error of [
      { code: 'EACCES' },
      { code: 'EACCES', message: undefined },
      { code: 'EACCES', message: null },
      { code: 'EACCES', message: 3 },
      Object.assign(Object.create({ message: GRANT.refreshToken }), { code: 'EACCES' }),
    ]) {
      reply = { v: 1, error };
      for (const request of requests)
        assert.deepEqual(JSON.parse((await run(request)).stdout), EIO);
    }
    reply = { v: 1, error: { code: 'EACCES', message: GRANT.refreshToken } };
    for (const request of requests)
      assert.deepEqual(JSON.parse((await run(request)).stdout), {
        v: 1,
        error: { code: 'EACCES', message: 'OAuth operation refused' },
      });
    reply = { v: 1, error: { code: 'EACCES' } };
    assert.deepEqual(
      JSON.parse((await run({ v: 1, op: 'placeholder', name: ID.name })).stdout),
      reply
    );
  });

  test('a disconnected vault fails closed while legacy replies retain their existing behavior', async (t) => {
    const { run } = await boot(t, create);
    assert.deepEqual(JSON.parse((await run({ v: 1, op: 'capabilities' })).stdout), {
      v: 1,
      error: { code: 'ENOTCONN', message: 'Vault is unavailable' },
    });
    const other = await boot(t, create, async () => ({
      v: 2,
      placeholder: PH,
      state: 'active',
      oauthManaged: true,
    }));
    assert.deepEqual(
      JSON.parse((await other.run({ v: 1, op: 'placeholder', name: ID.name })).stdout),
      { v: 1, placeholder: PH, state: 'active', oauthManaged: true }
    );
  });

  test('replacement, close and writer exit abort OAuth requests and discard late replies', async (t) => {
    const seen = [];
    let requested = Promise.withResolvers();
    const { kernel } = await boot(t, create, (req, { signal }) => {
      const pending = Promise.withResolvers();
      seen.push({ req, signal, ...pending });
      requested.resolve();
      if (seen.length === 2) pending.resolve(STATUS);
      return pending.promise;
    });
    const result = await kernel.run(['oauth-js', 'replace'], {
      cwd: '/',
      stdin: JSON.stringify(GRANT),
    });
    assert.deepEqual(JSON.parse(result.stdout), STATUS);
    assert.equal(seen[0].signal.reason, 'replaced');
    seen[0].resolve({ ...STATUS, refreshToken: GRANT.refreshToken });
    assert.equal(
      (await kernel.run(['oauth-js', 'close'], { cwd: '/', stdin: JSON.stringify(GRANT) })).stdout,
      'closed'
    );
    assert.equal(seen[2].signal.reason, 'withdrawn');
    seen[2].resolve(STATUS);
    requested = Promise.withResolvers();
    const output = [];
    const client = await attachKernel(await kernel.connect());
    t.after(() => client.close());
    const child = await client.spawn(['oauth-js'], {
      cwd: '/',
      stdin: JSON.stringify(GRANT),
      onStdout: (bytes) => output.push(new TextDecoder().decode(bytes)),
    });
    await requested.promise;
    await child.signal('SIGTERM');
    await child.exited;
    assert.equal(seen[3].signal.reason, 'withdrawn');
    seen[3].resolve(STATUS);
    assert.equal(output.join('').includes('refreshToken'), false);
  });

  test('OAuth operations have a 45 second deadline and capabilities retains 10 seconds through the actual device', async (t) => {
    let requested;
    const { run } = await boot(t, create, (_req, { signal }) => {
      requested.resolve(signal);
      return new Promise(() => {});
    });
    for (const op of ['capabilities', 'oauthGrant', 'oauthStatus', 'oauthRefresh', 'oauthRemove']) {
      requested = Promise.withResolvers();
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const result = run(
        op === 'capabilities' ? { v: 1, op } : op === 'oauthGrant' ? GRANT : { v: 1, op, ...ID }
      );
      const signal = await requested.promise;
      const deadline = op === 'capabilities' ? 10000 : 45000;
      t.mock.timers.tick(deadline - 1);
      assert.equal(signal.aborted, false);
      t.mock.timers.tick(1);
      assert.equal(signal.reason, 'timeout');
      assert.deepEqual(JSON.parse((await result).stdout), {
        v: 1,
        error: { code: 'ETIMEDOUT', message: 'Vault request timed out' },
      });
      t.mock.timers.reset();
    }
  });

  test('a handled signal leaves the JS OAuth read outstanding and the eventual reply readable', async (t) => {
    const requested = Promise.withResolvers();
    const answer = Promise.withResolvers();
    const interrupted = Promise.withResolvers();
    const output = [];
    const { kernel } = await boot(t, create, (_req, { signal }) => {
      requested.resolve(signal);
      return answer.promise;
    });
    const client = await attachKernel(await kernel.connect());
    t.after(() => client.close());
    const child = await client.spawn(['oauth-js', 'interrupt'], {
      cwd: '/',
      stdin: JSON.stringify(GRANT),
      onStdout: (bytes) => {
        output.push(new TextDecoder().decode(bytes));
        if (output.join('').includes('handled')) interrupted.resolve();
      },
    });
    const signal = await requested.promise;
    await child.signal('SIGUSR1');
    await interrupted.promise;
    assert.equal(signal.aborted, false);
    answer.resolve(STATUS);
    assert.equal(await child.exited, 0);
    assert.equal(output.join(''), `handled\n${JSON.stringify(STATUS)}`);
  });

  test('an inherited Emscripten descriptor is stamped for the writer, not its opener', async (t) => {
    const seen = [];
    const { kernel } = await boot(t, create, async (req) => {
      seen.push(req);
      return STATUS;
    });
    await install(kernel, 'wasm-bash');
    await install(kernel, 'wasm-coreutils');
    const request = JSON.stringify({ v: 1, op: 'oauthStatus', ...ID, caller: { uid: 0 } });
    const result = await kernel.run(
      [
        'bash',
        '-c',
        'echo "opener=$BASHPID" >&2; exec 3<>/dev/sealed; bash -c \'echo "writer=$BASHPID" >&2; read -r line; printf "%s" "$line" >&3; cat <&3\'; rc=$?; exit "$rc"',
      ],
      { cwd: '/', user: 'cone', stdin: `${request}\n` }
    );
    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout), STATUS);
    assert.equal(seen[0].caller.uid, 1000);
    const opener = Number(/opener=(\d+)/.exec(result.stderr)[1]);
    const writer = Number(/writer=(\d+)/.exec(result.stderr)[1]);
    assert.equal(seen[0].caller.pid, writer);
    assert.equal(seen[0].caller.ppid, opener);
    assert.notEqual(writer, opener);
  });
}
