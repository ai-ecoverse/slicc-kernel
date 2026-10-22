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

test('with users on, a tagged process cannot write /etc/crontab or the cron spool; through crontab its job runs with its tags, which an untagged reinstall of the same line keeps and text in the line cannot set (#1380)', async (t) => {
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
  const record = JSON.parse(
    new TextDecoder().decode(await kernel.readFile('/var/spool/cron/tags'))
  );
  assert.equal(record.v, 1);
  assert.deepEqual(
    Object.values(record['/var/spool/cron/crontabs/root']).map((j) => j.tags),
    [['agent', 'guest']]
  );
});

test("a job named like another user's tagged job keeps both apart: the tagged one still runs tagged, and the other runs untagged (#1380 review)", async (t) => {
  const clock = fakeCronClock(Date.UTC(2026, 0, 1, 10, 0, 30));
  const { kernel, client } = await booted(t, { cron: { clock } });
  await kernel.users.add({ name: 'cone' });
  await kernel.users.add({ name: 'scoop' });
  await kernel.writeFile('/tmp/t.sh', `${TAGS}; T $$ > /tmp/tags-$(id -un)\n`);
  const table = '# name: pending\n* * * * * bash /tmp/t.sh\n';
  const a = await client.run(['bash', '-c', `printf '%s' '${table}' | crontab -`], {
    tag: 'guest',
    user: 'cone',
    cwd: '/tmp',
  });
  assert.equal(a.status, 0, a.stderr);
  const b = await kernel.run(['bash', '-c', `printf '%s' '${table}' | crontab -`], {
    user: 'scoop',
    cwd: '/tmp',
  });
  assert.equal(b.status, 0, b.stderr);
  await delay(150);
  await clock.flush();
  clock.advance(30_000);
  const read = (path) =>
    kernel.readFile(path).then(
      (bytes) => new TextDecoder().decode(bytes),
      () => undefined
    );
  let both = [undefined, undefined];
  for (let i = 0; i < 100 && !both.every((x) => x?.endsWith('\n')); i++) {
    await delay(50);
    both = [await read('/tmp/tags-cone'), await read('/tmp/tags-scoop')];
  }
  assert.deepEqual(both, ['agent,guest\n', '\n']);
});

async function protectedKernel(t) {
  const kernel = await createNodeKernel({
    users: 'enforce',
    protect: { paths: ['/opt/p'], writers: ['agent', 'installer'] },
  });
  t.after(() => kernel.terminate());
  await install(kernel, 'wasm-bash');
  await install(kernel, 'wasm-coreutils');
  return { kernel, tagged: await attachKernel(await kernel.connect({ tag: 'agent' })) };
}

const crontabText = async (kernel) =>
  new TextDecoder().decode(await kernel.readFile('/etc/crontab').catch(() => new Uint8Array()));

test('with users on, a process tagged only by its connection cannot write /etc/crontab directly either, while an untagged one can (#1380 review)', async (t) => {
  const { kernel, tagged } = await protectedKernel(t);
  const r = await tagged.run(
    ['bash', '-c', "echo '* * * * * root echo x' >> /etc/crontab; echo $?"],
    {
      cwd: '/tmp',
    }
  );
  assert.equal(r.stdout, '1\n', r.stderr);
  assert.doesNotMatch(await crontabText(kernel), /echo x/);
  const untagged = await kernel.run(['bash', '-c', 'echo "# ok" >> /etc/crontab; echo $?'], {
    cwd: '/',
  });
  assert.equal(untagged.stdout, '0\n', untagged.stderr);
});

test('the cron fence follows a symlink onto /etc/crontab, for a program that hands the kernel the link, and refuses a hard link of it (#1380 review)', async (t) => {
  const { kernel, tagged } = await protectedKernel(t);
  await kernel.writeFile(
    '/node_modules/via/package.json',
    JSON.stringify({ name: 'via', slicc: { commands: { via: { abi: 'js', module: 'via.mjs' } } } })
  );
  await kernel.writeFile(
    '/node_modules/via/via.mjs',
    "export default async function main(ctx) {\n  try {\n    await ctx.fs.writeFile(ctx.argv[1], '* * * * * root echo y\\n');\n    await ctx.write(1, 'wrote\\n');\n  } catch (e) {\n    await ctx.write(1, e.code + '\\n');\n  }\n}\n"
  );
  await kernel.run(['bash', '-c', 'echo "# root" >> /etc/crontab; ln -s /etc/crontab /tmp/ct'], {
    cwd: '/',
  });
  const via = await tagged.run(['via', '/tmp/ct'], { cwd: '/tmp', tag: 'guest' });
  assert.equal(via.stdout, 'EACCES\n', via.stderr);
  assert.doesNotMatch(await crontabText(kernel), /echo y/);
  const hard = await tagged.run(['bash', '-c', 'ln /etc/crontab /tmp/hard 2>/dev/null; echo $?'], {
    cwd: '/tmp',
    tag: 'guest',
  });
  assert.equal(hard.stdout, '1\n', hard.stderr);
});

test('a tag added to a spawn of an untagged connection never makes a writer, while one added under a writer connection may stay a writer (#1380 review)', async (t) => {
  const { kernel, tagged } = await protectedKernel(t);
  const writer = await tagged.run(['bash', '-c', 'mkdir -p /opt/p && echo w > /opt/p/a; echo $?'], {
    tag: 'installer',
    cwd: '/tmp',
  });
  assert.equal(writer.stdout, '0\n', writer.stderr);
  const bare = await attachKernel(await kernel.connect({}));
  const forged = await bare.run(['bash', '-c', 'echo f > /opt/p/b; echo $?'], {
    tag: 'installer',
    cwd: '/tmp',
  });
  assert.equal(forged.stdout, '1\n', forged.stderr);
});
