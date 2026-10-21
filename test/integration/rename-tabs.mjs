import { setTimeout as sleep } from 'node:timers/promises';

export const PEER_WORKER = '/rename/peer-worker.js';

export const sh = (tab, script, name = 'kernel') =>
  tab.evaluate((s, n) => window[n].run(['bash', '-c', s], { cwd: '/' }), script, name);

export async function joined(page, name = 'kernel', peers = 1) {
  for (let i = 0; i < 300; i++) {
    const r = await sh(page, 'cat /proc/sys/kernel/slicc_shared_root', name);
    if (Number(r.stdout) === peers) return;
    await sleep(100);
  }
  throw new Error(`${name} never saw ${peers} peer(s)`);
}

export async function peerTab(page, { worker, name = 'kernel', wait = true } = {}) {
  const other = await page.tab();
  await other.goto('/');
  await other.until(() => typeof window.boot === 'function');
  await kernelIn(other, { worker, name });
  if (wait) await joined(page);
  return other;
}

export function kernelIn(tab, { worker, name = 'kernel' } = {}) {
  return tab.evaluate(
    (w, n) => window.secondKernel(w ? { worker: new URL(w, location.href) } : {}, n),
    worker ?? null,
    name
  );
}

export function steer(tab, set) {
  return tab.evaluate(
    (set) =>
      new Promise((resolve) => {
        const control = new BroadcastChannel('rename-peer-control');
        const id = Math.random();
        control.onmessage = ({ data }) => {
          if (data.done !== id) return;
          control.close();
          resolve(true);
        };
        control.postMessage({ set, id });
      }),
    set
  );
}

export const tree = (dir, files, name = 'a') =>
  `rm -rf ${dir} && mkdir -p ${dir}/${name}/lib && cd ${dir}/${name} && for i in $(seq ${files}); do echo "file $i" > lib/f$i; done && echo '{}' > package.json && echo made`;

export const whole = (dir) =>
  `cd ${dir} && for x in a b; do [ -e $x ] || continue; echo "$x $(ls $x/lib | wc -l) $(cat $x/lib/* | sort -u | wc -l) $(cat $x/package.json)"; done`;

export const wholeAs = (files) => (stdout) => {
  const lines = stdout.trim().split('\n').filter(Boolean);
  return (
    lines.length === 1 && /^[ab] /.test(lines[0]) && lines[0].slice(2) === `${files} ${files} {}`
  );
};

export async function untilFound(tab, path) {
  for (let i = 0; i < 2000; i++) {
    const seen = await tab.evaluate(
      (p) =>
        window.opfs.list(p).then(
          (names) => names.length,
          () => -1
        ),
      path
    );
    if (seen > 0) return;
    await sleep(5);
  }
  throw new Error(`${path} never appeared in OPFS`);
}

export const acks = async (tab, name = 'kernel') => {
  const r = await sh(
    tab,
    'cat /proc/sys/kernel/slicc_rename_acks /proc/sys/kernel/slicc_rename_ack_busy',
    name
  );
  const [line, busy] = r.stdout.trim().split('\n');
  const [count, median, most, waits, queries] = line.split(' ').map(Number);
  return { count, median, most, waits, queries, busy: Number(busy) };
};
