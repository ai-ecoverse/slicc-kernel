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

async function booted(t) {
  const kernel = await createNodeKernel({ users: 'enforce' });
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils', 'wasix-python']) await install(kernel, name);
  const sh = (script) => kernel.run(['bash', '-c', script], { cwd: '/' });
  await sh('mkdir -p /mnt/t /tmp/rt && printf x > /tmp/rt/f');
  await kernel.mount({ type: 'tmpfs', source: 'tmpfs', target: '/mnt/t' });
  return sh;
}

const py = (lines) =>
  `python3 -c "$(echo ${Buffer.from(['import os', ...lines].join('\n')).toString('base64')} | base64 -d)"`;

const N = 60;

const per = async (sh, n, body) => {
  const calls = async () => Number((await sh('cat /proc/sys/kernel/slicc_fs_calls')).stdout);
  const run = async (count) => {
    const before = await calls();
    const r = await sh(
      py([`for i in range(${count}):`, ...body.map((line) => `  ${line}`), "print('ok')"])
    );
    assert.deepEqual(r, { status: 0, stdout: 'ok\n', stderr: '' });
    return (await calls()) - before;
  };
  const none = await run(0);
  return ((await run(n)) - none) / n;
};

test('a WASI program creating a file asks the kernel 3 times with O_CREAT|O_EXCL and 5 with O_CREAT|O_TRUNC and a write (#1017)', {
  timeout: 180_000,
}, async (t) => {
  const sh = await booted(t);
  await sh('rm -rf /tmp/ct && mkdir -p /tmp/ct');
  const rows = [
    [
      'O_EXCL',
      3.05,
      ["os.close(os.open(f'/tmp/ct/e{i}', os.O_WRONLY|os.O_CREAT|os.O_EXCL, 0o644))"],
    ],
    [
      'O_TRUNC',
      5.05,
      [
        "fd = os.open(f'/tmp/ct/t{i}', os.O_WRONLY|os.O_CREAT|os.O_TRUNC, 0o644)",
        "os.write(fd, b'x')",
        'os.close(fd)',
      ],
    ],
  ];
  await run('w', 0, rows[0][2]);
  const seen = [];
  for (const [name, most, body] of rows) {
    const trips = await per(sh, N, body);
    seen.push(`${name} ${trips.toFixed(2)}`);
    assert.ok(trips <= most, `${name}: ${trips} round trips per file`);
  }
  console.log(`kernel fs calls per created file: ${seen.join(', ')}`);
});

test('creating through O_EXCL still refuses a dangling symlink, the umask applies only to a file the open made, and a missing name behind a link into /proc is still found there (#1017)', {
  timeout: 180_000,
}, async (t) => {
  const sh = await booted(t);
  await sh(
    'rm -rf /tmp/cx && mkdir -p /tmp/cx && ln -s /tmp/cx/nowhere /tmp/cx/dangle && ln -s /proc /tmp/cx/p && printf old > /tmp/cx/old && chmod 666 /tmp/cx/old'
  );
  const r = await sh(
    `umask 027; ${py([
      'try:',
      "  os.open('/tmp/cx/dangle', os.O_WRONLY|os.O_CREAT|os.O_EXCL, 0o666)",
      "  print('opened')",
      'except FileExistsError:',
      "  print('EEXIST')",
      "os.close(os.open('/tmp/cx/new', os.O_WRONLY|os.O_CREAT|os.O_EXCL, 0o666))",
      "os.close(os.open('/tmp/cx/trunc', os.O_WRONLY|os.O_CREAT|os.O_TRUNC, 0o666))",
      "os.close(os.open('/tmp/cx/old', os.O_WRONLY|os.O_CREAT|os.O_TRUNC, 0o666))",
      "print(*[oct(os.stat(f'/tmp/cx/{n}').st_mode & 0o777) for n in ('new', 'trunc', 'old')])",
      "print(os.path.exists('/tmp/cx/p/self/status'), os.path.exists('/tmp/cx/p/self/nope'), os.path.exists('/tmp/cx/none'))",
      "print(os.path.lexists('/tmp/cx/nowhere'))",
    ])}`
  );
  assert.deepEqual(r, {
    status: 0,
    stdout: 'EEXIST\n0o640 0o640 0o666\nTrue False False\nFalse\n',
    stderr: '',
  });
});

const kernelCalls = (stderr) =>
  stderr
    .split('\n')
    .filter((line) => /\skernel\.\S+$/.test(line))
    .reduce((sum, line) => sum + Number(line.trim().split(/\s+/)[1]), 0);

test('a WASI program creating files and directories asks the kernel for its umask once, not per file (#1017)', {
  timeout: 180_000,
}, async (t) => {
  const sh = await booted(t);
  await sh('rm -rf /tmp/cu && mkdir -p /tmp/cu');
  const run = async (tag, count, body) => {
    const r = await sh(
      `SLICC_WASI_STATS=1 ${py([`for i in range(${count}):`, ...body.map((line) => `  ${line.replaceAll('TAG', tag)}`), "print('ok')"])}`
    );
    assert.equal(r.stdout, 'ok\n');
    return kernelCalls(r.stderr);
  };
  const rows = [
    [
      'O_EXCL',
      2.2,
      ["os.close(os.open(f'/tmp/cu/TAG-e{i}', os.O_WRONLY|os.O_CREAT|os.O_EXCL, 0o644))"],
    ],
    [
      'O_TRUNC',
      2.1,
      [
        "fd = os.open(f'/tmp/cu/TAG-t{i}', os.O_WRONLY|os.O_CREAT|os.O_TRUNC, 0o644)",
        "os.write(fd, b'x')",
        'os.close(fd)',
      ],
    ],
    ['mkdir', 0.1, ["os.mkdir(f'/tmp/cu/TAG-d{i}')"]],
  ];
  await run('w', 0, rows[0][2]);
  const seen = [];
  for (const [name, most, body] of rows) {
    const per = ((await run('a', N, body)) - (await run('b', 0, body))) / N;
    seen.push(`${name} ${per.toFixed(2)}`);
    assert.ok(per <= most, `${name}: ${per} kernel calls per file`);
  }
  console.log(`kernel calls per created file: ${seen.join(', ')}`);
});

test('a umask set in one thread applies at once to files the other threads create, to the program and to its children (#1017)', {
  timeout: 180_000,
}, async (t) => {
  const sh = await booted(t);
  await sh('rm -rf /tmp/cw && mkdir -p /tmp/cw');
  const r = await sh(
    `umask 022; ${py([
      'import threading',
      'masks = [0o077, 0o027, 0o002, 0o070]',
      'go = [threading.Event() for _ in masks]',
      'done = [threading.Event() for _ in masks]',
      'def setter():',
      '  for k, m in enumerate(masks):',
      '    os.umask(m)',
      '    go[k].set()',
      '    done[k].wait()',
      'def maker():',
      '  for k, m in enumerate(masks):',
      '    go[k].wait()',
      "    os.close(os.open(f'/tmp/cw/f{k}', os.O_WRONLY|os.O_CREAT|os.O_EXCL, 0o666))",
      "    os.mkdir(f'/tmp/cw/d{k}')",
      '    done[k].set()',
      'a = threading.Thread(target=setter)',
      'b = threading.Thread(target=maker)',
      'a.start(); b.start(); a.join(); b.join()',
      "os.close(os.open('/tmp/cw/main', os.O_WRONLY|os.O_CREAT|os.O_EXCL, 0o666))",
      "print(*[oct(os.stat(f'/tmp/cw/{n}').st_mode & 0o777) for n in ('f0', 'd0', 'f1', 'd1', 'f2', 'd2', 'f3', 'd3', 'main')])",
      'print(oct(os.umask(0o022)), oct(os.umask(0o022)))',
      'os.umask(0o007)',
      "os.system('umask; echo > /tmp/cw/child')",
      "print(oct(os.stat('/tmp/cw/child').st_mode & 0o777))",
    ])}`
  );
  assert.deepEqual(r, {
    status: 0,
    stdout: '0o600 0o700 0o640 0o750 0o664 0o775 0o606 0o707 0o606\n0o70 0o22\n0007\n0o660\n',
    stderr: '',
  });
});
