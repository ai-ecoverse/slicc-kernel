import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { launch } from './chrome.mjs';
import { booted, ok } from './kernel.mjs';

const chrome = await launch();
after(() => chrome.close());

const DIR = '/home/storm';

async function prepared(t) {
  const kernel = await booted(chrome, t, { users: 'enforce' });
  assert.deepEqual(
    await kernel.bash(
      `rm -rf ${DIR} /home/churn && mkdir -p ${DIR}/d /home/churn && : > ${DIR}/a && : > ${DIR}/b && ln -s a ${DIR}/l`,
      { cwd: '/' }
    ),
    ok()
  );
  await kernel.page.evaluate(async () => {
    window.client = await window.attachKernel(await window.kernel.connect());
    window.metaOf = async (kernel = window.kernel) => {
      const r = await kernel.run(['cat', '/proc/sys/kernel/slicc_meta_transactions'], {
        cwd: '/',
      });
      if (r.status !== 0 || !/^\d+ \d+\n?$/.test(r.stdout)) {
        throw new Error(`slicc_meta_transactions: ${JSON.stringify(r)}`);
      }
      const [reads, writes] = r.stdout.trim().split(' ').map(Number);
      return { reads, writes };
    };
    window.metaCost = async (work, kernel = window.kernel) => {
      const first = await window.metaOf(kernel);
      const second = await window.metaOf(kernel);
      const done = await work();
      const end = await window.metaOf(kernel);
      const net = (k) => end[k] - 2 * second[k] + first[k];
      return { reads: net('reads'), writes: net('writes'), done };
    };
    window.listed = async (dir, names) => {
      const until = performance.now() + 2000;
      for (;;) {
        const seen = await window.client.fs.readdir(dir);
        if (JSON.stringify(seen) === JSON.stringify(names) || performance.now() > until)
          return seen;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
  });
  return kernel;
}

test('a client polling readdir and stat on the OPFS root costs no metadata reads once the answers are cached, also while another client writes', async (t) => {
  const { page } = await prepared(t);
  const r = await page.evaluate(async (dir) => {
    const fs = window.client.fs;
    const storm = async (loops, rounds) => {
      await Promise.all(
        Array.from({ length: loops }, async () => {
          for (let i = 0; i < rounds; i++) {
            await fs.readdir(dir);
            await fs.stat(`${dir}/b`);
            await fs.lstat(`${dir}/l`);
            await fs.stat(`${dir}/missing`).catch(() => 0);
          }
        })
      );
      return loops * rounds * 4;
    };
    await storm(1, 1);
    const sequential = await window.metaCost(() => storm(1, 300));
    const parallel = await window.metaCost(() => storm(20, 30));
    let made = 0;
    const churned = await window.metaCost(async () => {
      let churning = true;
      const churn = (async () => {
        while (churning) await fs.writeFile(`/home/churn/f${made++}`, 'x');
      })();
      const ops = await storm(20, 30);
      churning = false;
      await churn;
      return ops;
    });
    return { sequential, parallel, churned, made };
  }, DIR);
  console.log(`metadata transactions: ${JSON.stringify(r)}`);
  assert.equal(r.sequential.done, 1200);
  assert.ok(r.sequential.reads <= 2, `sequential storm: ${r.sequential.reads} reads`);
  assert.ok(r.parallel.reads <= 2, `parallel storm: ${r.parallel.reads} reads`);
  assert.ok(
    r.churned.reads <= r.made + 4,
    `storm beside ${r.made} new files: ${r.churned.reads} reads`
  );
});

test('stats of names a kernel hasn’t read yet, asked at once, share metadata reads rather than taking one each', async (t) => {
  const { page, bash } = await prepared(t);
  assert.deepEqual(
    await bash(`mkdir ${DIR}/cold && cd ${DIR}/cold && for i in $(seq 200); do : > f$i; done`, {
      cwd: '/',
    }),
    ok()
  );
  await page.evaluate(() => window.reboot());
  const r = await page.evaluate(async (dir) => {
    window.client = await window.attachKernel(await window.kernel.connect());
    const fs = window.client.fs;
    await fs.stat(`${dir}/cold`);
    return window.metaCost(async () => {
      const stats = await Promise.all(
        Array.from({ length: 200 }, (_, i) => fs.stat(`${dir}/cold/f${i + 1}`))
      );
      return stats.filter((st) => st.isFile).length;
    });
  }, DIR);
  console.log(`200 cold stats at once: ${r.reads} metadata reads`);
  assert.equal(r.done, 200);
  assert.ok(r.reads <= 20, `200 cold stats at once: ${r.reads} reads`);
});

test('a cached listing of the OPFS root follows the kernel’s own symlink changes, by clients and processes', async (t) => {
  const { page, bash } = await prepared(t);
  const list = (path) => page.evaluate((p) => window.client.fs.readdir(p), path);
  assert.deepEqual(await list(DIR), ['a', 'b', 'd', 'l']);
  await page.evaluate((dir) => window.client.fs.symlink('b', `${dir}/m`), DIR);
  assert.deepEqual(await list(DIR), ['a', 'b', 'd', 'l', 'm']);
  assert.deepEqual(await bash(`rm ${DIR}/l && ln -s ../a ${DIR}/d/n`, { cwd: '/' }), ok());
  assert.deepEqual(await list(DIR), ['a', 'b', 'd', 'm']);
  assert.deepEqual(await list(`${DIR}/d`), ['n']);
  assert.deepEqual(await bash(`mv ${DIR}/m ${DIR}/o`, { cwd: '/' }), ok());
  assert.deepEqual(await list(DIR), ['a', 'b', 'd', 'o']);
  assert.deepEqual(await bash(`mv ${DIR}/d ${DIR}/e && mkdir ${DIR}/d`, { cwd: '/' }), ok());
  assert.deepEqual(await list(`${DIR}/d`), []);
  assert.deepEqual(await list(`${DIR}/e`), ['n']);
  assert.deepEqual(
    await bash(`rm -r ${DIR}/e && mkdir ${DIR}/e && ls ${DIR}/e`, { cwd: '/' }),
    ok()
  );
  assert.deepEqual(await list(`${DIR}/e`), []);
  await page.evaluate((dir) => window.client.fs.rename(`${dir}/o`, `${dir}/e/p`), DIR);
  assert.deepEqual(await list(DIR), ['a', 'b', 'd', 'e']);
  assert.deepEqual(await list(`${DIR}/e`), ['p']);
  assert.deepEqual(
    await bash(`ls ${DIR} ${DIR}/e`, { cwd: '/' }),
    ok(`${DIR}:\na\nb\nd\ne\n\n${DIR}/e:\np\n`)
  );
});

test('a cached listing of the OPFS root follows another kernel’s symlink changes on the same root', async (t) => {
  const { page } = await prepared(t);
  await page.evaluate(() => window.secondKernel({}));
  const cached = await page.evaluate(async (dir) => {
    for (let i = 0; i < 3; i++) await window.client.fs.readdir(dir);
    return window.metaCost(async () => {
      for (let i = 0; i < 50; i++) await window.client.fs.readdir(dir);
    });
  }, DIR);
  assert.ok(cached.reads <= 1, `50 cached listings: ${cached.reads} reads`);
  const there = (dir, names) => page.evaluate((d, n) => window.listed(d, n), dir, names);
  const peer = (script) =>
    page.evaluate((s) => window.second.run(['bash', '-c', s], { cwd: '/' }), script);
  assert.deepEqual(await peer(`ln -s b ${DIR}/m`), ok());
  assert.deepEqual(await there(DIR, ['a', 'b', 'd', 'l', 'm']), ['a', 'b', 'd', 'l', 'm']);
  assert.deepEqual(await peer(`rm ${DIR}/l`), ok());
  assert.deepEqual(await there(DIR, ['a', 'b', 'd', 'm']), ['a', 'b', 'd', 'm']);
  assert.deepEqual(await page.evaluate((d) => window.client.fs.readdir(`${d}/d`), DIR), []);
  assert.deepEqual(await peer(`ln -s ../a ${DIR}/d/n && mv ${DIR}/d ${DIR}/e`), ok());
  assert.deepEqual(await there(`${DIR}/e`, ['n']), ['n']);
  assert.deepEqual(await there(DIR, ['a', 'b', 'e', 'm']), ['a', 'b', 'e', 'm']);
  assert.deepEqual(await peer(`rm -r ${DIR}/e && mkdir ${DIR}/e`), ok());
  assert.deepEqual(await there(`${DIR}/e`, []), []);
});
