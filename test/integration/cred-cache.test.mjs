import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNodeKernel } from '../../dist/node.js';

const modules = new URL('../../node_modules/@ai-ecoverse/', import.meta.url);

async function install(kernel, name) {
  const base = fileURLToPath(new URL(`${name}/`, modules));
  const entries = await readdir(base, { recursive: true, withFileTypes: true });
  for (const entry of entries.filter((e) => e.isFile())) {
    const file = join(entry.parentPath, entry.name);
    await kernel.writeFile(
      `/node_modules/@ai-ecoverse/${name}/${relative(base, file)}`,
      await readFile(file)
    );
  }
}

let kernel;
let ids;

before(async () => {
  kernel = await createNodeKernel({ users: 'enforce' });
  for (const name of ['wasm-bash', 'wasm-coreutils', 'wasix-python']) await install(kernel, name);
  await kernel.users.add({ name: 'cone' });
  await kernel.users.add({ name: 'crew' });
  const sh = await kernel.run(
    [
      'bash',
      '-c',
      [
        'id -u cone; id -g cone; id -g crew',
        'echo s > /tmp/secret && chmod 600 /tmp/secret',
        'echo c > /tmp/crew.txt && chgrp crew /tmp/crew.txt && chmod 640 /tmp/crew.txt',
        'echo r > /tmp/root.txt && chmod 640 /tmp/root.txt',
      ].join('; '),
    ],
    { cwd: '/' }
  );
  assert.equal(sh.stderr, '');
  const [uid, gid, crew] = sh.stdout.trim().split('\n').map(Number);
  ids = { uid, gid, crew };
});

after(() => kernel?.terminate());

const PRELUDE = [
  'import os, subprocess, sys, threading',
  'def can(p):',
  '    try:',
  '        open(p).close()',
  "        return 'ok'",
  '    except PermissionError:',
  "        return 'EACCES'",
];

async function python(lines, user) {
  const code = [
    ...PRELUDE,
    `C, G, CREW = ${ids.uid}, ${ids.gid}, ${ids.crew}`,
    'warm = threading.Thread(target=lambda: None)',
    'warm.start(); warm.join()',
    ...lines,
  ].join('\n');
  const r = await kernel.run(['python3', '-c', code], { cwd: '/tmp', ...(user ? { user } : {}) });
  assert.equal(r.stderr, '');
  assert.equal(r.status, 0);
  return r.stdout;
}

test('a seteuid is seen at once by the same thread: geteuid, the owner of a new file and access', async () => {
  const out = await python([
    "print(os.geteuid(), can('/tmp/secret'))",
    'os.seteuid(C)',
    "open('/tmp/r1a', 'w').close()",
    "print(os.geteuid(), os.stat('/tmp/r1a').st_uid, can('/tmp/secret'))",
    'os.seteuid(0)',
    "open('/tmp/r1b', 'w').close()",
    "print(os.geteuid(), os.stat('/tmp/r1b').st_uid, can('/tmp/secret'))",
  ]);
  const { uid } = ids;
  assert.equal(out, `0 ok\n${uid} ${uid} EACCES\n0 0 ok\n`);
});

test('a sibling thread’s seteuid and setegid reach the main thread and a thread blocked across them', async () => {
  const out = await python([
    "print('before', os.geteuid(), os.getegid())",
    'ready, go, seen = threading.Event(), threading.Event(), []',
    'def waiter():',
    '    seen.append((os.geteuid(), os.getegid()))',
    '    ready.set()',
    '    go.wait()',
    '    seen.append((os.geteuid(), os.getegid()))',
    'def changer():',
    '    ready.wait()',
    '    os.setegid(G)',
    '    os.seteuid(C)',
    '    go.set()',
    'w = threading.Thread(target=waiter); w.start()',
    't = threading.Thread(target=changer); t.start()',
    't.join(); w.join()',
    "open('/tmp/r2', 'w').close()",
    "st = os.stat('/tmp/r2')",
    "print('after', os.geteuid(), os.getegid(), st.st_uid, st.st_gid)",
    "print('waiter', *seen)",
  ]);
  const { uid, gid } = ids;
  assert.equal(
    out,
    `before 0 0\nafter ${uid} ${gid} ${uid} ${gid}\nwaiter (0, 0) (${uid}, ${gid})\n`
  );
});

test('a sibling thread’s setgroups reaches the main thread’s getgroups and access', async () => {
  const out = await python([
    "print('before', os.getgroups())",
    'def changer():',
    '    os.setgroups([CREW])',
    '    os.setegid(G)',
    '    os.seteuid(C)',
    't = threading.Thread(target=changer); t.start(); t.join()',
    "print('after', os.getgroups(), can('/tmp/crew.txt'), can('/tmp/root.txt'))",
  ]);
  assert.match(out, /^before \[[\d, ]*\]\n/);
  assert.equal(out.split('\n')[1], `after [${ids.crew}] ok EACCES`);
});

test('a refused setuid changes nothing in any thread, and a sibling’s earlier read still holds', async () => {
  const out = await python(
    [
      'first = os.geteuid()',
      'ready, go, seen = threading.Event(), threading.Event(), []',
      'def reader():',
      '    seen.append(os.geteuid())',
      '    ready.set()',
      '    go.wait()',
      '    seen.append(os.geteuid())',
      'def changer():',
      '    ready.wait()',
      '    try:',
      '        os.setuid(0)',
      "        seen.append('changed')",
      '    except PermissionError:',
      "        seen.append('EPERM')",
      '    go.set()',
      'r = threading.Thread(target=reader); r.start()',
      't = threading.Thread(target=changer); t.start()',
      't.join(); r.join()',
      "print(first, os.geteuid(), *seen, can('/tmp/secret'))",
    ],
    'cone'
  );
  const { uid } = ids;
  assert.equal(out, `${uid} ${uid} ${uid} EPERM ${uid} EACCES\n`);
});

test('a spawned child and an exec’d program start with the ids a sibling thread set', async () => {
  const out = await python([
    'os.geteuid()',
    'def changer():',
    '    os.setegid(G)',
    '    os.seteuid(C)',
    't = threading.Thread(target=changer); t.start(); t.join()',
    "subprocess.run(['python3', '-c', 'import os; print(\"child\", os.geteuid(), os.getegid())'])",
    "subprocess.run(['id', '-u'])",
    "print('parent', os.geteuid(), flush=True)",
  ]);
  const { uid, gid } = ids;
  assert.equal(out, `child ${uid} ${gid}\n${uid}\nparent ${uid}\n`);
});
