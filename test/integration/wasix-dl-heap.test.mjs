import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNodeKernel } from '../../dist/node.js';

const modules = new URL('../../node_modules/@ai-ecoverse/', import.meta.url);
const TIMEOUT = { timeout: 300_000 };
const SITE = '/node_modules/@ai-ecoverse/py-numpy/lib/python3.15/site-packages';

async function install(kernel, name) {
  const base = fileURLToPath(new URL(`${name}/`, modules));
  for (const entry of (await readdir(base, { recursive: true, withFileTypes: true })).filter((e) =>
    e.isFile()
  )) {
    const rel = relative(base, join(entry.parentPath, entry.name));
    if (/^lib\/libpython[^/]*\.a$/.test(rel)) continue;
    await kernel.writeFile(
      `/node_modules/@ai-ecoverse/${name}/${rel}`,
      await readFile(join(entry.parentPath, entry.name))
    );
  }
}

async function python(t) {
  const kernel = await createNodeKernel({});
  t.after(() => kernel.terminate());
  for (const name of ['wasix-python', 'py-numpy']) await install(kernel, name);
  return async (lines, env = {}) => {
    const r = await kernel.run(['python3', '-c', lines.join('\n')], {
      cwd: '/',
      env: { PYTHONPATH: SITE, ...env },
    });
    return {
      status: r.status,
      stdout: String(r.stdout),
      stderr: `${r.status} ${String(r.stderr)}`,
    };
  };
}

const RSS = [
  'def rss():',
  '  return int([l for l in open("/proc/self/status") if l.startswith("VmRSS")][0].split()[1])',
];

test(
  'a WASIX program dlopening side modules puts their data in its own heap: import numpy grows no memory while the heap has room, and still works (#1408)',
  TIMEOUT,
  async (t) => {
    const py = await python(t);
    const r = await py([
      ...RSS,
      'a = rss()',
      'import numpy as np',
      'print("grew", rss() - a, "kB", np.arange(6).reshape(2, 3).sum(axis=0).tolist())',
    ]);
    assert.equal(r.stdout, 'grew 0 kB [3, 5, 7]\n', r.stderr);
  }
);

test(
  'a side module loads from a thread while another thread is busy in malloc, without a deadlock (#1408)',
  TIMEOUT,
  async (t) => {
    const py = await python(t);
    const r = await py([
      'import threading, time',
      'stop = False',
      'def churn():',
      '  n = 0',
      '  while not stop:',
      '    x = [bytes(64) for _ in range(256)]',
      '    n += 1',
      'out = []',
      'def load():',
      '  import numpy as np',
      '  out.append(int(np.ones(4).sum()))',
      'busy = threading.Thread(target=churn)',
      'busy.start()',
      'time.sleep(0.2)',
      'loader = threading.Thread(target=load)',
      'loader.start()',
      'loader.join(120)',
      'stop = True',
      'busy.join(30)',
      'print(out, loader.is_alive())',
    ]);
    assert.equal(r.stdout, '[4] False\n', r.stderr);
  }
);

test(
  'a forked child dlopens a further side module in its own heap; the parent is unaffected and loads it too (#1408)',
  TIMEOUT,
  async (t) => {
    const py = await python(t);
    const r = await py(
      [
        'import os',
        ...RSS,
        'import numpy as np',
        'a = rss()',
        'pid = os.fork()',
        'if pid == 0:',
        '  import numpy.linalg',
        '  print("child", float(numpy.linalg.det(np.eye(3))), flush=True)',
        '  os._exit(0)',
        '_, status = os.waitpid(pid, 0)',
        'b = rss()',
        'import numpy.linalg',
        'print("parent", status, b - a, float(numpy.linalg.det(np.eye(2))))',
      ],
      { PYTHON_FORK: 'true' }
    );
    assert.equal(r.stdout, 'child 1.0\nparent 0 0 1.0\n', r.stderr);
  }
);

test(
  'a side module still loads when the heap is nearly full: malloc grows memory for it (#1408)',
  TIMEOUT,
  async (t) => {
    const py = await python(t);
    const r = await py([
      ...RSS,
      'hold = bytearray((rss() << 10) - (8 << 20))',
      'import numpy as np',
      'print(np.arange(3).tolist())',
    ]);
    assert.equal(r.stdout, '[0, 1, 2]\n', r.stderr);
  }
);

test(
  "a side module loaded as another one's DT_NEEDED gets its data from the heap too, and its 1 MiB bss reads as zeros (#1408 review)",
  TIMEOUT,
  async (t) => {
    const kernel = await createNodeKernel({});
    t.after(() => kernel.terminate());
    await install(kernel, 'wasix-python');
    const lib = new URL('./fixtures/dlbss/lib/', import.meta.url);
    for (const name of ['libzzybss.so', 'libzzytop.so']) {
      await kernel.writeFile(`/opt/dl/${name}`, await readFile(new URL(name, lib)));
    }
    const code = [
      'import ctypes',
      ...RSS,
      'junk = [bytes([7]) * 4096 for _ in range(2048)]',
      'del junk',
      'a = rss()',
      'top = ctypes.CDLL("/opt/dl/libzzytop.so")',
      'print(top.top_check(), rss() - a)',
    ].join('\n');
    const r = await kernel.run(['python3', '-c', code], {
      cwd: '/',
      env: { LD_LIBRARY_PATH: '/opt/dl' },
    });
    assert.equal(String(r.stdout), '42 0\n', String(r.stderr));
  }
);
