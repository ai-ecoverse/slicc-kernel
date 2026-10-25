import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNodeKernel } from '../../dist/node.js';

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

const JS_APP = `export default async function main(ctx) {
  const src = ctx.argv[1];
  const ops = {
    mkdir: (p) => ctx.fs.mkdir(p, { recursive: false }),
    'sync-mkdir': (p) => ctx.sync.fs.mkdir(p, { recursive: false }),
    'mkdir-p': (p) => ctx.fs.mkdir(p),
    symlink: (p) => ctx.fs.symlink('/tmp', p),
    'sync-symlink': (p) => ctx.sync.fs.symlink('/tmp', p),
    link: (p) => ctx.fs.link(src, p),
    'sync-link': (p) => ctx.sync.fs.link(src, p),
    excl: (p) => ctx.open(p, { write: true, create: true, exclusive: true }),
    'sync-excl': (p) => ctx.sync.open(p, { write: true, create: true, exclusive: true }),
    rename: (p) => ctx.fs.rename(src, p),
    'sync-rename': (p) => ctx.sync.fs.rename(src, p),
  };
  const names = ctx.argv[2].split(',');
  const out = [];
  for (const path of ctx.argv.slice(3)) {
    const row = [];
    for (const name of names) {
      const op = ops[name];
      try {
        await op(path);
        row.push(name + '=ok');
      } catch (err) {
        row.push(name + '=' + err.code);
      }
    }
    out.push(path + ' ' + row.join(' '));
  }
  await ctx.write(1, out.join('\\n') + '\\n');
  return 0;
}`;

const PY = `import errno, os, sys
src = sys.argv[1]
names = sys.argv[2].split(',')
ops = [
    ('mkdir', lambda p: os.mkdir(p)),
    ('mkfifo', lambda p: os.mkfifo(p)),
    ('symlink', lambda p: os.symlink('/tmp', p)),
    ('link', lambda p: os.link(src, p)),
    ('excl', lambda p: os.open(p, os.O_CREAT | os.O_EXCL | os.O_WRONLY)),
    ('rename', lambda p: os.rename(src, p)),
]
for path in sys.argv[3:]:
    row = []
    for name, op in ops:
        if name not in names:
            continue
        try:
            op(path)
            row.append(name + '=ok')
        except OSError as e:
            row.append(name + '=' + errno.errorcode[e.errno])
    print(path, ' '.join(row))
`;

const SH = `said() { case $1 in *'Permission denied'*) echo EACCES;; *'File exists'*|*'cannot overwrite'*) echo EEXIST;; *) echo "$1";; esac; }
src=$1; shift; for p in "$@"; do
  for op in "mkdir $p" "mkdir -p $p" "mkfifo $p" "mknod $p p" "ln -s /tmp $p" "ln -T $src $p" "mv -T $src $p"; do
    err=$($op 2>&1 >/dev/null); rc=$?; echo "$op rc=$rc $(said "$err")"
  done
  err=$( (set -C; : > "$p") 2>&1); rc=$?; echo "set -C $p rc=$rc $(said "$err")"
done`;

async function setup(t) {
  const kernel = await createNodeKernel({ users: 'enforce' });
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils', 'wasix-python']) await install(kernel, name);
  await kernel.users.add({ name: 'alice' });
  await kernel.users.add({ name: 'bob' });
  await kernel.writeFile(
    '/node_modules/jsapp/package.json',
    JSON.stringify({
      name: 'jsapp',
      slicc: { commands: { jsapp: { abi: 'js', module: 'main.mjs' } } },
    })
  );
  await kernel.writeFile('/node_modules/jsapp/main.mjs', JS_APP);
  const made = await kernel.run(
    [
      'bash',
      '-c',
      'mkdir -p /home/alice/x /home/pub && echo > /home/alice/f && echo > /home/pub/f && chown -R alice:alice /home/alice /home/pub && chmod 700 /home/alice && chmod 755 /home/pub && for u in alice bob root; do echo s > /tmp/src-$u && chown $u /tmp/src-$u; done',
    ],
    { cwd: '/' }
  );
  assert.equal(made.status, 0, made.stderr);
  const as = async (user, argv) => {
    const r = await kernel.run(argv, { cwd: '/', ...(user === 'root' ? {} : { user }) });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  return {
    py: (user, ops, ...paths) =>
      as(user, ['python3', '-c', PY, `/tmp/src-${user}`, ops.join(','), ...paths]),
    js: (user, ops, ...paths) => as(user, ['jsapp', `/tmp/src-${user}`, ops.join(','), ...paths]),
    sh: (user, ...paths) => as(user, ['bash', '-c', SH, 'sh', `/tmp/src-${user}`, ...paths]),
  };
}

const PY_OPS = ['mkdir', 'mkfifo', 'symlink', 'link', 'excl', 'rename'];
const JS_OPS = [
  'mkdir',
  'sync-mkdir',
  'mkdir-p',
  'symlink',
  'sync-symlink',
  'link',
  'sync-link',
  'excl',
  'sync-excl',
  'rename',
  'sync-rename',
];

const rows = (ops, paths, code) =>
  paths
    .map(
      (p) =>
        `${p} ${ops.map((op) => `${op}=${typeof code === 'function' ? code(op) : code}`).join(' ')}\n`
    )
    .join('');

const shRows = (paths, src, rc, msg) =>
  paths
    .map((p) =>
      [
        `mkdir ${p} rc=${rc} ${msg}`,
        `mkdir -p ${p} rc=${rc} ${msg}`,
        `mkfifo ${p} rc=${rc} ${msg}`,
        `mknod ${p} p rc=${rc} ${msg}`,
        `ln -s /tmp ${p} rc=${rc} ${msg}`,
        `ln -T ${src} ${p} rc=${rc} ${msg}`,
        `mv -T ${src} ${p} rc=${rc} ${msg}`,
        `set -C ${p} rc=${rc} ${msg}`,
      ]
        .map((line) => `${line}\n`)
        .join('')
    )
    .join('');

const HIDDEN = [
  '/home/alice/x',
  '/home/alice/f',
  '/home/alice/nx',
  '/home/alice/x/y',
  '/home/alice/nx/y',
];
const EXISTING = ['/home/alice/x', '/home/alice/f'];
const NO_RENAME_PY = PY_OPS.filter((op) => op !== 'rename');
const NO_RENAME_JS = JS_OPS.filter((op) => !op.endsWith('rename'));

for (const [runtime, check] of [
  [
    'bash',
    ({ sh }) =>
      sh('bob', ...HIDDEN).then((out) => [out, shRows(HIDDEN, '/tmp/src-bob', 1, 'EACCES')]),
  ],
  [
    'WASI',
    ({ py }) => py('bob', PY_OPS, ...HIDDEN).then((out) => [out, rows(PY_OPS, HIDDEN, 'EACCES')]),
  ],
  [
    'JS',
    ({ js }) => js('bob', JS_OPS, ...HIDDEN).then((out) => [out, rows(JS_OPS, HIDDEN, 'EACCES')]),
  ],
]) {
  test(`a user gets EACCES, not EEXIST, creating any name in another user's 0700 directory, existing or not, in ${runtime} (#1696)`, {
    timeout: 300_000,
  }, async (t) => {
    const [actual, expected] = await check(await setup(t));
    assert.equal(actual, expected);
  });
}

test('the owner and root still get EEXIST creating an existing name in a 0700 directory (#1696)', {
  timeout: 300_000,
}, async (t) => {
  const { py, js } = await setup(t);
  const jsOps = NO_RENAME_JS.filter((op) => op !== 'mkdir-p');
  for (const user of ['alice', 'root']) {
    assert.equal(await py(user, NO_RENAME_PY, ...EXISTING), rows(NO_RENAME_PY, EXISTING, 'EEXIST'));
    assert.equal(await js(user, jsOps, ...EXISTING), rows(jsOps, EXISTING, 'EEXIST'));
  }
});

test('a create under a missing parent is ENOENT ahead of the write check, in WASI and JS (#1696)', {
  timeout: 300_000,
}, async (t) => {
  const { py, js } = await setup(t);
  const missing = ['/home/pub/nx/y', '/nope/y'];
  assert.equal(
    await js('bob', JS_OPS, ...missing),
    rows(JS_OPS, missing, (op) => (op === 'mkdir-p' ? 'EACCES' : 'ENOENT'))
  );
  assert.equal(await py('bob', PY_OPS, ...missing), rows(PY_OPS, missing, 'ENOENT'));
});

test('a create under a file is ENOTDIR ahead of the write check, in WASI and JS (#1696)', {
  timeout: 300_000,
}, async (t) => {
  const { py, js } = await setup(t);
  const file = ['/home/pub/f/y'];
  assert.equal(await py('bob', NO_RENAME_PY, ...file), rows(NO_RENAME_PY, file, 'ENOTDIR'));
  assert.equal(await js('bob', NO_RENAME_JS, ...file), rows(NO_RENAME_JS, file, 'ENOTDIR'));
});
