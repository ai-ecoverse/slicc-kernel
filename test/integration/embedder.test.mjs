import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { attachKernel, createNodeKernel } from '../../dist/node.js';

const modules = new URL('../../node_modules/@ai-ecoverse/', import.meta.url);
const TIMEOUT = { timeout: 120_000 };

async function installDir(kernel, dir, at) {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  for (const entry of entries.filter((e) => e.isFile())) {
    const file = join(entry.parentPath, entry.name);
    await kernel.writeFile(`${at}/${relative(dir, file)}`, await readFile(file));
  }
}

async function drain(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function page(name = 'page') {
  const calls = [];
  const hook = {
    kinds: {
      'test.echo': {},
      'test.big': {},
      'test.wait': {},
      'test.fail': {},
      'test.video': { group: 'video' },
      'test.later': {},
      'test.steps': {},
      'test.users': { group: 'users' },
      'test.named': { users: ['carol'] },
    },
    handle: async (request) => {
      const call = {
        page: name,
        kind: request.kind,
        options: request.options,
        stamp: request.stamp,
      };
      calls.push(call);
      if (request.kind === 'test.echo') {
        const body = await drain(request.body);
        call.body = body.length;
        return new Uint8Array(Buffer.concat([Buffer.from(`${name}:`), body]));
      }
      if (request.kind === 'test.big') {
        const size = Number(request.options.size);
        let sent = 0;
        return new ReadableStream({
          pull(controller) {
            if (sent >= size) return controller.close();
            const n = Math.min(65536, size - sent);
            controller.enqueue(new Uint8Array(n).fill(sent % 251));
            sent += n;
          },
        });
      }
      if (request.kind === 'test.wait') {
        request.progress('waiting for a click');
        await new Promise((_, reject) =>
          request.signal.addEventListener('abort', () => {
            call.aborted = request.signal.reason.message;
            reject(request.signal.reason);
          })
        );
      }
      if (request.kind === 'test.steps') {
        await new Promise((r) => setTimeout(r, 200));
        request.progress('step one');
        await new Promise((r) => setTimeout(r, 100));
        return 'done';
      }
      if (request.kind === 'test.later') {
        await new Promise((r) => setTimeout(r, 800));
        throw Object.assign(new Error('denied after a prompt'), { name: 'NotAllowedError' });
      }
      if (request.kind === 'test.fail') {
        const name = request.options.as;
        throw Object.assign(new Error(`refused as ${name}`), { name });
      }
      return 'ok';
    },
  };
  return { hook, calls };
}

async function booted(t, options = {}) {
  const kernel = await createNodeKernel({ users: 'enforce', ...options });
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils']) {
    await installDir(
      kernel,
      fileURLToPath(new URL(`${name}/`, modules)),
      `/node_modules/@ai-ecoverse/${name}`
    );
  }
  const bash = (script, o = {}) => kernel.run(['bash', '-c', script], { cwd: '/tmp', ...o });
  return { kernel, bash };
}

test(
  'a program asks the page through /dev/embedder from sh: a body in and a reply out, an O_WRONLY request whose close returns the errno, and the stamp (#1527)',
  TIMEOUT,
  async (t) => {
    const { hook, calls } = page();
    const { bash } = await booted(t, { requests: hook });
    const echo = await bash(
      `printf hello > in && exec 3<>/dev/embedder && { printf '%s\\n' '{"kind":"test.echo","x":1}'; cat in; } >&3 && cat <&3`
    );
    assert.deepEqual(echo, { status: 0, stdout: 'page:hello', stderr: '' });
    assert.deepEqual(calls[0].options, { x: 1 });
    assert.equal(calls[0].body, 5);
    assert.equal(calls[0].stamp.uid, 0);
    assert.equal(calls[0].stamp.kind, 'test.echo');
    assert.ok(Array.isArray(calls[0].stamp.groups));
    const big = await bash(
      `exec 3<>/dev/embedder && printf '%s\\n' '{"kind":"test.big","size":10485760}' >&3 && cat <&3 | wc -c`
    );
    assert.equal(big.stdout.trim(), '10485760');
    const wronly = await bash(
      `printf '{"kind":"test.fail","as":"NotAllowedError"}\\n' | cat > /dev/embedder; echo "status $?"`
    );
    assert.match(wronly.stdout, /status 1/);
    assert.match(wronly.stderr, /\/dev\/embedder: refused as NotAllowedError/);
    const ok = await bash(
      `printf '{"kind":"test.echo"}\\n' | cat > /dev/embedder; echo "status $?"`
    );
    assert.match(ok.stdout, /status 0/);
  }
);

test(
  'a kind outside the allow-list is ENOTSUP and never reaches the page, the errors map to errnos, and a bad header is EINVAL (#1527)',
  TIMEOUT,
  async (t) => {
    const { hook, calls } = page();
    const { bash } = await booted(t, { requests: hook });
    const ask = (header) =>
      bash(`exec 3<>/dev/embedder; printf '%s\\n' '${header}' >&3; cat <&3; echo " status $?"`);
    const unlisted = await ask('{"kind":"test.unlisted"}');
    assert.match(unlisted.stdout, /status 1/);
    assert.match(unlisted.stderr, /Operation not supported|not supported/i);
    assert.equal(calls.length, 0);
    for (const [as, text] of [
      ['NotAllowedError', /Permission denied/],
      ['NotSupportedError', /not supported/i],
      ['NotFoundError', /No such file/],
      ['TypeError', /Input\/output error|I\/O error/],
    ]) {
      const r = await ask(`{"kind":"test.fail","as":"${as}"}`);
      assert.match(r.stderr, text, `${as}: ${r.stderr}`);
    }
    const bad = await bash(`printf 'not json\\n' | cat > /dev/embedder; echo "status $?"`);
    assert.match(bad.stdout, /status 1/);
    assert.match(bad.stderr, /Invalid argument/);
  }
);

test(
  "a process whose user is neither root, the session user, in the kind's group nor named is EACCES and the page never sees it (#1527)",
  TIMEOUT,
  async (t) => {
    const { hook, calls } = page();
    const { kernel } = await booted(t, { requests: hook });
    await kernel.users.add({ name: 'bob' });
    await kernel.users.add({ name: 'carol' });
    const script = (kind) =>
      `exec 3<>/dev/embedder; printf '%s\\n' '{"kind":"${kind}"}' >&3; cat <&3; echo " status $?"`;
    const as = (who, kind) =>
      kernel.run(['sudo', '-u', who, 'bash', '-c', script(kind)], { cwd: '/tmp' });
    const own = await kernel.run(['bash', '-c', script('test.video')], {
      cwd: '/tmp',
      user: 'bob',
    });
    assert.equal(own.stdout, 'ok status 0\n', own.stderr);
    const outside = await as('bob', 'test.video');
    assert.match(outside.stdout, / status 1/);
    assert.match(outside.stderr, /test\.video is not allowed for this user/);
    assert.equal((await as('bob', 'test.users')).stdout, 'ok status 0\n');
    assert.equal((await as('carol', 'test.named')).stdout, 'ok status 0\n');
    assert.match((await as('bob', 'test.named')).stderr, /not allowed/);
    const root = await kernel.run(['bash', '-c', script('test.video')], { cwd: '/tmp' });
    assert.equal(root.stdout, 'ok status 0\n');
    assert.deepEqual(
      calls.map((c) => [c.kind, c.stamp.uid]),
      [
        ['test.video', 1000],
        ['test.users', 1000],
        ['test.named', 1001],
        ['test.video', 0],
      ]
    );
  }
);

test(
  'a handled signal interrupts a waiting request with EINTR and the page sees interrupted; closing early ends it as closed with no error; progress reaches stderr (#1527)',
  TIMEOUT,
  async (t) => {
    const { hook, calls } = page();
    const { bash } = await booted(t, { requests: hook });
    const trapped = await bash(
      `exec 3<>/dev/embedder; printf '%s\\n' '{"kind":"test.wait"}' >&3; (sleep 0.5; kill -INT $$) & trap 'echo trapped' INT; read -r x <&3; echo "read $?"; wait`
    );
    assert.match(trapped.stdout, /trapped/);
    assert.match(trapped.stderr, /waiting for a click/);
    assert.equal(calls[0].aborted, 'interrupted');
    const closed = await bash(
      `exec 3<>/dev/embedder; printf '%s\\n' '{"kind":"test.big","size":100000000}' >&3; head -c 1000 <&3 | wc -c; exec 3<&-; echo done`
    );
    assert.equal(closed.stdout, '1000\ndone\n');
    assert.equal(closed.stderr, '');
  }
);

test(
  'routing: a port the embedder bound at connect answers for its own processes, an attach-granted port for its attached client, a plain port gets ENOTSUP, and attaching with requests on a plain port is EPERM; nothing falls back to the page (#1527)',
  TIMEOUT,
  async (t) => {
    const main = page('page');
    const agent = page('agent');
    const tab = page('tab');
    const { kernel } = await booted(t, { requests: main.hook });
    const ask = `exec 3<>/dev/embedder; { printf '%s\\n' '{"kind":"test.echo"}'; printf x; } >&3; cat <&3; echo " status $?"`;
    const bound = await attachKernel(await kernel.connect({ tag: 'agent', requests: agent.hook }));
    t.after(() => bound.close?.());
    assert.equal(
      (await bound.run(['bash', '-c', ask], { cwd: '/tmp' })).stdout,
      'agent:x status 0\n'
    );
    const granted = await kernel.connect({ requests: 'attach' });
    const attached = await attachKernel(granted, { requests: tab.hook });
    assert.equal(
      (await attached.run(['bash', '-c', ask], { cwd: '/tmp' })).stdout,
      'tab:x status 0\n'
    );
    const plain = await attachKernel(await kernel.connect());
    const none = await plain.run(['bash', '-c', ask], { cwd: '/tmp' });
    assert.match(none.stdout, / status 1/);
    assert.match(none.stderr, /no page answers requests for this session/);
    await assert.rejects(attachKernel(await kernel.connect(), { requests: tab.hook }), /EPERM/);
    assert.equal(main.calls.length, 0);
    assert.deepEqual(
      [agent.calls.length, tab.calls.length, agent.calls[0].stamp.tag],
      [1, 1, 'agent']
    );
  }
);

const HOLD = `export default async function main(ctx) {
  const n = Number(ctx.argv[1]);
  const codes = [];
  for (let i = 0; i < n; i++) {
    try {
      await ctx.open('/dev/embedder', { read: true, write: true });
      codes.push('ok');
    } catch (err) {
      codes.push(err.code);
    }
  }
  await ctx.write(1, codes.join(' ') + '\\n');
  await ctx.fs.writeFile('/tmp/held-' + ctx.argv[2], '');
  while (!(await ctx.fs.exists('/tmp/release'))) await new Promise((r) => setTimeout(r, 20));
}
`;

test(
  'memory: at most 16 open requests per process (EMFILE) and 256 MiB of request windows per kernel, 128 requests, then EAGAIN; a closed one frees its share (#1527)',
  TIMEOUT,
  async (t) => {
    const { hook } = page();
    const { kernel } = await booted(t, { requests: hook });
    await kernel.writeFile(
      '/node_modules/embhold/package.json',
      JSON.stringify({
        name: 'embhold',
        slicc: { commands: { embhold: { abi: 'js', module: 'hold.mjs' } } },
      })
    );
    await kernel.writeFile('/node_modules/embhold/hold.mjs', HOLD);
    const first = kernel.run(['embhold', '17', '0'], { cwd: '/' });
    const rest = [];
    for (let i = 1; i < 8; i++) rest.push(kernel.run(['embhold', '16', String(i)], { cwd: '/' }));
    for (let i = 0; i < 8; i++) {
      while (
        !(await kernel.readFile(`/tmp/held-${i}`).then(
          () => true,
          () => false
        ))
      )
        await new Promise((r) => setTimeout(r, 50));
    }
    const last = await kernel.run(['bash', '-c', 'exec 3<>/dev/embedder && echo opened'], {
      cwd: '/tmp',
    });
    assert.match(last.stderr, /Resource temporarily unavailable/);
    await kernel.writeFile('/tmp/release', '');
    const done = await Promise.all([first, ...rest]);
    assert.equal(done[0].stdout.trim(), `${'ok '.repeat(16)}EMFILE`);
    for (const r of done.slice(1)) assert.equal(r.stdout.trim(), 'ok '.repeat(16).trim());
    const after = await kernel.run(['bash', '-c', 'exec 3<>/dev/embedder && echo opened'], {
      cwd: '/tmp',
    });
    assert.equal(after.stdout, 'opened\n');
  }
);

test(
  'a page that refuses after a delay, without reading a body over 1 MiB, frees the blocked writer with EACCES, read-write and write-only (#1527 review)',
  TIMEOUT,
  async (t) => {
    const { hook } = page();
    const { bash } = await booted(t, { requests: hook });
    const rw = await bash(
      `head -c 4000000 /dev/zero > in; exec 3<>/dev/embedder; { printf '%s\\n' '{"kind":"test.later"}'; cat in; } >&3; echo "w $?"`
    );
    assert.match(rw.stdout, /w 1/);
    assert.match(rw.stderr, /denied after a prompt/);
    const wo = await bash(
      `{ printf '%s\\n' '{"kind":"test.later"}'; head -c 2097152 /dev/zero; } | cat > /dev/embedder; echo "rc=$?"`
    );
    assert.match(wo.stdout, /rc=1/);
    assert.match(wo.stderr, /Permission denied/);
  }
);

test(
  "progress reaches the stderr of the process reading the reply, named for the process that sent the header, also when that process has exec'd into the reader (#1527 follow-up)",
  TIMEOUT,
  async (t) => {
    const { hook } = page();
    const { bash } = await booted(t, { requests: hook });
    const header = `printf '%s\\n' '{"kind":"test.steps"}' >&3`;
    for (const script of [
      `exec 3<>/dev/embedder; ${header}; cat <&3`,
      `exec 3<>/dev/embedder; (${header}; exec cat <&3)`,
      `exec 3<>/dev/embedder; ${header}; exec cat <&3`,
    ]) {
      const r = await bash(script);
      assert.equal(r.stdout, 'done', script);
      assert.equal(r.stderr, 'bash: step one\n', script);
    }
  }
);
