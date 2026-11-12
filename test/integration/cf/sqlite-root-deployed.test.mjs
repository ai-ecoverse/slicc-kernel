import assert from 'node:assert/strict';
import { test } from 'node:test';

const url = process.env.SLICC_D_BENCH_URL;
const key = process.env.SLICC_D_BENCH_KEY;
const modes = (process.env.SLICC_D_BENCH_MODES ?? 'behind').split(',');
const rounds = Number(process.env.SLICC_D_BENCH_ROUNDS ?? 3);
const skip =
  url && key
    ? false
    : 'set SLICC_D_BENCH_URL and SLICC_D_BENCH_KEY to a deployed sqlite-root-bench';

const CASES = {
  redirect100:
    'rm -rf /root/r; mkdir -p /root/r; for i in $(seq 1 100); do echo "line $i" > /root/r/f$i.txt; done; ls /root/r | wc -l',
  files100:
    'rm -rf /root/w; mkdir -p /root/w && cd /root/w && mkdir -p many && for i in $(seq 1 100); do echo "line $i" > many/f$i.txt; done; n=0; for f in many/*.txt; do read l < "$f"; n=$((n+1)); done; echo $n; cat many/*.txt | wc -l',
  untar:
    'rm -rf /root/x; mkdir -p /root/x && tar -xf /root/tree.tar -C /root/x && ls /root/x/tree/d*/* | wc -l',
  milestone: 'echo a | cat; x=$(uname); ls / | head -3; for i in 1 2 3; do echo $i; done | wc -l',
};

const EXPECTED = {
  redirect100: '100\n',
  files100: '100\n100\n',
  untar: '2000\n',
  milestone: 'a\nbin\ndev\netc\n3\n',
};

async function call(mode, path, script, kernel = 'deployed-test') {
  const extra = kernel === 'deployed-test' ? '' : '&maxMs=600000&idleMs=600000';
  const started = performance.now();
  const response = await fetch(`${url}${path}?key=${key}&mode=${mode}&kernel=${kernel}${extra}`, {
    method: script === undefined ? 'GET' : 'POST',
    ...(script === undefined ? {} : { body: JSON.stringify({ script }) }),
  });
  const text = await response.text();
  const ms = Math.round(performance.now() - started);
  if (script === undefined) return { ms, text };
  const result = JSON.parse(text);
  return { ...result, client: ms };
}

async function tree(mode) {
  const have = await call(mode, '/run', 'test -s /root/tree.tar && echo yes');
  if (have.stdout === 'yes\n') return;
  for (let d = 0; d < 40; d += 4) {
    const r = await call(
      mode,
      '/run',
      `mkdir -p /root/src && cd /root/src && for d in $(seq ${d} ${d + 3}); do mkdir -p tree/d$d; for f in $(seq 0 49); do echo "file $d/$f" > tree/d$d/f$f.txt; done; done`
    );
    assert.equal(r.status, 0, r.stderr);
  }
  const r = await call(
    mode,
    '/run',
    'cd /root/src && tar -cf /root/tree.tar tree && rm -rf /root/src'
  );
  assert.equal(r.status, 0, r.stderr);
}

for (const mode of modes) {
  test(`deployed SQLite root (${mode}): file-heavy scripts, timed from the client`, {
    skip,
  }, async (t) => {
    await call(mode, '/boot');
    await tree(mode);
    for (const [name, script] of Object.entries(CASES)) {
      const times = [];
      for (let i = 0; i < rounds; i++) {
        const r = await call(mode, '/run', script);
        assert.equal(r.status, 0, r.stderr);
        assert.equal(r.stdout, EXPECTED[name]);
        times.push(`${r.client} ms (${r.flushes} flushes)`);
      }
      t.diagnostic(`${mode} ${name}: ${times.join(', ')}`);
    }
  });

  test(`deployed SQLite root (${mode}): a file written by run() survives ctx.abort right after`, {
    skip,
  }, async () => {
    const token = crypto.randomUUID();
    const made = await call(
      mode,
      '/run',
      `echo ${token} > /root/kept; chmod 600 /root/kept; ln -sf kept /root/kept-link`
    );
    assert.equal(made.status, 0, made.stderr);
    await call(mode, '/crash');
    let seen;
    for (let attempt = 0; attempt < 10 && seen?.status !== 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      seen = await call(
        mode,
        '/run',
        'cat /root/kept; stat -c %a /root/kept; readlink /root/kept-link'
      ).catch(() => undefined);
    }
    assert.equal(seen?.stdout, `${token}\n600\nkept\n`);
  });

  test(`deployed SQLite root (${mode}): fsync makes writes durable while the run is still going, an abort then loses only the rest`, {
    skip,
  }, async () => {
    await call(mode, '/boot', undefined, 'fsync-window');
    const token = crypto.randomUUID();
    const running = call(
      mode,
      '/run',
      `rm -f /root/synced /root/unsynced; echo ${token} | dd of=/root/synced conv=fsync 2>/dev/null; echo ${token} > /root/unsynced; sleep 60`,
      'fsync-window'
    ).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 8000));
    await call(mode, '/crash', undefined, 'fsync-window');
    await running;
    let seen;
    for (let attempt = 0; attempt < 10 && seen?.status !== 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      seen = await call(
        mode,
        '/run',
        'cat /root/synced; test -e /root/unsynced && echo kept || echo lost',
        'fsync-window'
      ).catch(() => undefined);
    }
    assert.equal(seen?.stdout, `${token}\nlost\n`);
  });
}
