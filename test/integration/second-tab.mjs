import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { progressing } from './progress.mjs';

export const worker = (k) => `/count/count-worker.js?k=${k}`;

const ask = (page, to, what) =>
  page.evaluate(
    (to, what) =>
      new Promise((resolve) => {
        const control = new BroadcastChannel('second-tab-count');
        const id = Math.random();
        control.onmessage = ({ data }) => {
          if (data.from !== to || data.id !== id) return;
          control.close();
          resolve(data);
        };
        control.postMessage({ to, id, ...what });
      }),
    to,
    what
  );

const proc = async (page, name) => {
  const r = await page.evaluate(
    (n) => window.kernel.run(['cat', `/proc/sys/kernel/${n}`], { cwd: '/' }),
    name
  );
  return Number(r.stdout);
};

const total = (counts) => Object.values(counts).reduce((a, b) => a + b, 0);

const counters = async (page) => {
  const r = await page.evaluate(() =>
    window.kernel.run(
      [
        'bash',
        '-c',
        'read -r o < /proc/sys/kernel/slicc_opfs_calls; read -r f < /proc/sys/kernel/slicc_fs_calls; echo "$o $f"',
      ],
      { cwd: '/' }
    )
  );
  const [opfs, fs] = r.stdout.trim().split(' ').map(Number);
  return { opfs, fs };
};

async function snapshot(page, key) {
  const first = await counters(page);
  const second = await counters(page);
  await ask(page, key, { reset: true });
  return { first, second };
}

async function finish(page, key, { first, second }) {
  const { counts, ms } = await ask(page, key, {});
  const end = await counters(page);
  const net = (k) => end[k] - 2 * second[k] + first[k];
  return { opfs: net('opfs'), fs: net('fs'), counts, ms };
}

export async function measured(page, peer, label, argv, cwd) {
  const mine = await snapshot(page, 'writer');
  const theirs = peer ? await snapshot(peer, 'peer') : undefined;
  const t0 = Date.now();
  await page.evaluate(
    (a, c) => {
      window.costRun = undefined;
      window.kernel.run(a, { cwd: c }).then(
        (r) => (window.costRun = r),
        (e) => (window.costRun = { status: -1, stdout: '', stderr: String(e) })
      );
    },
    argv,
    cwd
  );
  const done = (async () => {
    for (;;) {
      const r = await page.evaluate(() => window.costRun);
      if (r) return r;
      await sleep(250);
    }
  })();
  const result = await progressing(done, {
    sample: async () => [
      { pid: 0, comm: label, state: 'R', ticks: total((await ask(page, 'writer', {})).counts) },
    ],
    quietMs: 60_000,
    label,
  });
  const wall = Date.now() - t0;
  return {
    result,
    wall,
    writer: await finish(page, 'writer', mine),
    peer: peer ? await finish(peer, 'peer', theirs) : undefined,
  };
}

export const per = (n, files) => Math.round((n / files) * 100) / 100;

export function report(name, files, m) {
  const side = (s) => {
    if (!s) return '-';
    const c = s.counts;
    const pick = (re) =>
      Object.entries(c)
        .filter(([k]) => re.test(k))
        .reduce((a, [, v]) => a + v, 0);
    return [
      `opfs ${per(s.opfs, files)}`,
      `kernel ${per(s.fs, files)}`,
      `idb rw ${per(c['idb readwrite'] ?? 0, files)} (${s.ms['idb readwrite'] ?? 0} ms)`,
      `idb ro ${per(c['idb readonly'] ?? 0, files)} (${s.ms['idb readonly'] ?? 0} ms)`,
      `locks ${per(pick(/^lock [^ ]+$/), files)}`,
      `posts ${per(pick(/^post /), files)}`,
      `heard ${per(pick(/^heard /), files)}`,
    ].join(', ');
  };
  console.log(`COST ${name}: ${m.wall} ms for ${files} files, ${per(m.wall, files)} ms/file`);
  console.log(`  writer per file: ${side(m.writer)}`);
  console.log(`  peer per file: ${side(m.peer)}`);
  console.log(`  writer raw: ${JSON.stringify(m.writer)}`);
  if (m.peer) console.log(`  peer raw: ${JSON.stringify(m.peer)}`);
}

export async function peerTab(page) {
  const other = await page.tab();
  await other.goto('/');
  await other.until(() => typeof window.boot === 'function');
  await other.evaluate(
    (w) => window.secondKernel({ worker: new URL(w, location.href) }, 'kernel'),
    worker('peer')
  );
  for (let i = 0; i < 300 && (await proc(page, 'slicc_shared_root')) !== 1; i++) await sleep(100);
  assert.equal(await proc(page, 'slicc_shared_root'), 1);
  return other;
}

export async function alone(page) {
  for (let i = 0; i < 300 && (await proc(page, 'slicc_shared_root')) !== 0; i++) await sleep(100);
  assert.equal(await proc(page, 'slicc_shared_root'), 0);
}
