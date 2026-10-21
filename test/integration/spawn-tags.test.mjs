import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { attachKernel, createNodeKernel } from '../../dist/node.js';
import { fakeCronClock } from '../../dist/testing.js';

const modules = new URL('../../node_modules/@ai-ecoverse/', import.meta.url);

async function install(kernel, name) {
  const base = new URL(`${name}/`, modules);
  const entries = await readdir(base, { recursive: true, withFileTypes: true });
  for (const entry of entries.filter((e) => e.isFile())) {
    const file = join(entry.parentPath, entry.name);
    await kernel.writeFile(
      `/node_modules/@ai-ecoverse/${name}/${relative(fileURLToPath(base), file)}`,
      await readFile(file)
    );
  }
}

async function booted(t, options = {}) {
  const kernel = await createNodeKernel({ users: 'enforce', ...options });
  t.after(() => kernel.terminate());
  await install(kernel, 'wasm-bash');
  await install(kernel, 'wasm-coreutils');
  const client = await attachKernel(await kernel.connect({ tag: 'agent' }));
  return { kernel, client };
}

const TAGS =
  'T() { o=; while IFS=$\'\\t\' read -r k v; do [ "$k" = Tag: ] && o="$o${o:+,}$v"; done < /proc/$1/status; echo "$o"; }';

test('a tag given per spawn adds to the connection tag, and every descendant keeps both (#1380)', async (t) => {
  const { client } = await booted(t);
  const script = [
    TAGS,
    'echo "self $(T $$)"',
    'sleep 5 & echo "bg $(T $!)"; kill $!',
    'env -i /bin/bash -c "$(declare -f T); echo \\"envi \\$(T \\$\\$)\\""',
    '( ( exec bash -c "$(declare -f T); echo \\"daemon \\$(T \\$\\$) ppid \\$PPID\\" > /tmp/d" ) & ); sleep 0.5; cat /tmp/d',
    'echo x > /proc/self/status 2>/dev/null || echo "proc refused"',
  ].join('; ');
  const got = await client.run(['bash', '-c', script], { tag: 'guest', cwd: '/tmp' });
  assert.equal(
    got.stdout,
    'self agent,guest\nbg agent,guest\nenvi agent,guest\ndaemon agent,guest ppid 1\nproc refused\n',
    got.stderr
  );
  const plain = await client.run(['bash', '-c', `${TAGS}; T $$`], { cwd: '/tmp' });
  assert.equal(plain.stdout, 'agent\n', plain.stderr);
  const same = await client.run(['bash', '-c', `${TAGS}; T $$`], { tag: 'agent', cwd: '/tmp' });
  assert.equal(same.stdout, 'agent\n', same.stderr);
  const listed = await client.spawn(['sleep', '5'], { tag: 'guest', cwd: '/tmp' });
  const row = (await client.ps()).find((p) => p.pid === listed.pid);
  assert.deepEqual([row?.tag, row?.tags], ['agent', ['agent', 'guest']]);
  await listed.signal('SIGKILL');
});

test('protect.writers needs every tag of a process to be a writer: a guest-tagged spawn under a writer connection cannot change a protected path (#1380)', async (t) => {
  const kernel = await createNodeKernel({
    users: 'enforce',
    protect: { paths: ['/opt/p'], writers: ['agent'] },
  });
  t.after(() => kernel.terminate());
  await install(kernel, 'wasm-bash');
  await install(kernel, 'wasm-coreutils');
  const client = await attachKernel(await kernel.connect({ tag: 'agent' }));
  const writer = await client.run(
    ['bash', '-c', 'mkdir -p /opt/p && echo w > /opt/p/a && cat /opt/p/a'],
    {
      cwd: '/tmp',
    }
  );
  assert.equal(writer.stdout, 'w\n', writer.stderr);
  const guest = await client.run(['bash', '-c', 'echo g > /opt/p/b; echo "rc=$?"'], {
    tag: 'guest',
    cwd: '/tmp',
  });
  assert.match(guest.stdout, /rc=1/);
  assert.equal(
    await kernel.readFile('/opt/p/b').then(
      () => 'there',
      () => 'absent'
    ),
    'absent'
  );
});

test('with users on, a process tagged beyond its connection cannot write /etc/crontab or the cron spool; through crontab its job runs with its tags, which an untagged reinstall of the same line keeps and text in the line cannot set (#1380)', async (t) => {
  const clock = fakeCronClock(Date.UTC(2026, 0, 1, 10, 0, 30));
  const { kernel, client } = await booted(t, { cron: { clock } });
  const guest = (script) => client.run(['bash', '-c', script], { tag: 'guest', cwd: '/tmp' });
  const direct = await guest(
    [
      'echo \'* * * * * root echo x\' >> /etc/crontab; echo "etc=$?"',
      'mkdir -p /var/spool/cron/crontabs 2>/dev/null; echo "* * * * * echo y" > /var/spool/cron/crontabs/root; echo "spool=$?"',
      'echo "{}" > /var/spool/cron/tags; echo "tags=$?"',
    ].join('; ')
  );
  assert.match(direct.stdout, /etc=1\n/, direct.stderr);
  assert.match(direct.stdout, /spool=1\n/, direct.stderr);
  assert.match(direct.stdout, /tags=1\n/, direct.stderr);
  await kernel.writeFile('/tmp/t.sh', `${TAGS}; T $$ > /tmp/tagged\n`);
  const line = '* * * * * bash /tmp/t.sh # tag=none\n';
  const installed = await guest(`printf '%s' '${line}' | crontab -; echo "rc=$?"`);
  assert.equal(installed.stdout, 'rc=0\n', installed.stderr);
  const plain = await kernel.run(['bash', '-c', `printf '%s' '${line}' | crontab -`], { cwd: '/' });
  assert.equal(plain.status, 0, plain.stderr);
  await delay(150);
  await clock.flush();
  clock.advance(30_000);
  let ran;
  for (let i = 0; i < 100 && !ran; i++) {
    await delay(50);
    ran = await kernel.readFile('/tmp/tagged').then(
      (b) => new TextDecoder().decode(b),
      () => undefined
    );
  }
  assert.equal(ran, 'agent,guest\n');
});
