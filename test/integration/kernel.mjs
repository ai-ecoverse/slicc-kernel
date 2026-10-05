export async function booted(chrome, t) {
  const page = await chrome.page(t);
  await page.goto('/');
  await page.until(() => typeof window.boot === 'function');
  await page.evaluate(() => window.boot());
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

export const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
