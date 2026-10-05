import { readdir } from 'node:fs/promises';
export async function booted(chrome, t, options = {}) {
  const page = await chrome.page(t);
  await page.goto('/');
  await page.until(() => typeof window.boot === 'function');
  await page.evaluate((o) => window.boot(o), options);
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
  return page.evaluate(
    (d, n) => window.installTree(d, n),
    `node_modules/@ai-ecoverse/${name}/`,
    names
  );
}

export const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
