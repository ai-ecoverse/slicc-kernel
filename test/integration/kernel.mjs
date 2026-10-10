import { readdir } from 'node:fs/promises';

let stalled = 0;
process.on('exit', () => {
  if (stalled > 0) console.log(`chrome stalls re-fetched in this file: ${stalled}`);
});

async function reportStalls(page) {
  for (const line of await page.evaluate(() => window.takeStalls?.() ?? [])) {
    stalled++;
    console.log(line);
  }
  for (const line of await page.evaluate(() => window.takeLargeFetches?.() ?? []))
    console.log(line);
}

export async function booted(chrome, t, options = {}) {
  const page = await chrome.page(t);
  t.signal?.addEventListener('abort', () => {
    const state = () => ({ kernel: typeof window.kernel, inFlight: window.inFlight?.() ?? [] });
    page.evaluate(state).then(
      (s) => console.log(`stuck in "${t.name}": ${JSON.stringify(s)}`),
      (err) => {
        if (!/Session with given id not found/.test(err.message)) {
          console.log(`stuck in "${t.name}": the page does not answer (${err.message})`);
        }
      }
    );
  });
  await page.goto('/');
  await page.until(() => typeof window.boot === 'function');
  try {
    await page.evaluate((o) => window.boot(o), options);
  } finally {
    await reportStalls(page);
  }
  return {
    page,
    bash: (script, options = { cwd: '/os' }) =>
      page.evaluate((s, o) => window.kernel.run(['bash', '-c', s], o), script, options),
    run: (argv, options = {}) => page.evaluate((a, o) => window.kernel.run(a, o), argv, options),
    read: (path) => page.evaluate((p) => window.opfs.read(p), path),
    list: (path) => page.evaluate((p) => window.opfs.list(p), path),
    exists: (path) => page.evaluate((p) => window.opfs.exists(p), path),
  };
}

const modules = new URL('../../node_modules/@ai-ecoverse/', import.meta.url);

export async function installPackage(page, name) {
  const files = await readdir(new URL(`${name}/`, modules), {
    recursive: true,
    withFileTypes: true,
  });
  const base = new URL(`${name}/`, modules).pathname;
  const names = files
    .filter((entry) => entry.isFile())
    .map((entry) => `${entry.parentPath}/${entry.name}`.slice(base.length));
  try {
    return await page.evaluate(
      (d, n) => window.installTree(d, n),
      `node_modules/@ai-ecoverse/${name}/`,
      names
    );
  } finally {
    await reportStalls(page);
  }
}

export const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
