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

const DRIVER = `
const errno = (code) => Object.assign(new Error(code), { code });
export default function () {
  const modes = new Map([['/safe', 0o644], ['/target', 0o644]]);
  let looked = 0;
  let after = Infinity;
  const swapped = () => looked >= after;
  return {
    capabilities: { attrTtl: 0, owners: true, chmod: true, symlinks: true },
    handlers: {
      async mount({ source }) {
        after = Number(source);
        return {};
      },
      async getattr(p) {
        if (p === '/') return { kind: 'directory', size: 0, mtime: 0, mode: 0o755, uid: 0, gid: 0 };
        if (p === '/l') {
          const owner = swapped() ? 4242 : 0;
          return { kind: 'symlink', size: 1, mtime: 0, mode: 0o777, uid: owner, gid: owner };
        }
        if (!modes.has(p)) throw errno('ENOENT');
        if (p === '/safe') looked++;
        return { kind: 'file', size: 0, mtime: 0, mode: modes.get(p), uid: 0, gid: 0 };
      },
      async readdir() {
        return [{ name: 'l', kind: 'symlink' }, { name: 'safe', kind: 'file' }, { name: 'target', kind: 'file' }];
      },
      async readlink() { return swapped() ? '/home/cone/h/target' : '/home/cone/h/safe'; },
      async setattr(p, attr) {
        if (!modes.has(p)) throw errno('ENOENT');
        if (attr.mode !== undefined) modes.set(p, attr.mode & 0o7777);
      },
    },
  };
}
`;

const CHMOD = `export default async function main(ctx) {
  try {
    ctx.sync.fs.chmod(ctx.argv[1], 0o777);
    await ctx.write(1, 'changed\\n');
  } catch (e) {
    await ctx.write(1, (e.code ?? String(e)) + '\\n');
  }
}
`;

test('a sudo process cannot be led through a trusted link swapped for an untrusted one at any point between its checks and its operation (#542)', async (t) => {
  const kernel = await createNodeKernel({ users: 'enforce' });
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils']) await install(kernel, name);
  await kernel.writeFile(
    '/node_modules/chm/package.json',
    JSON.stringify({ slicc: { commands: { chm: { abi: 'js', module: 'main.mjs' } } } })
  );
  await kernel.writeFile('/node_modules/chm/main.mjs', CHMOD);
  await kernel.writeFile(
    '/node_modules/hostile/package.json',
    JSON.stringify({ slicc: { filesystems: { hostile: { module: 'd.mjs' } } } })
  );
  await kernel.writeFile('/node_modules/hostile/d.mjs', DRIVER);
  await kernel.users.add({ name: 'cone', groups: ['sudo'] });
  const root = (script) => kernel.run(['bash', '-c', script], { cwd: '/' });
  await root(
    "mkdir -p /home/cone/h && printf '%s\\n' 'NOPASSWD cone Cmnd *' > /etc/sudoers.d/cone && chmod 440 /etc/sudoers.d/cone"
  );
  const outcomes = [];
  for (let after = 0; after <= 6; after++) {
    assert.equal(
      (await kernel.mount({ type: 'hostile', source: String(after), target: '/home/cone/h' }))
        .state,
      'ok'
    );
    const r = await kernel.run(['bash', '-c', 'sudo chm h/l'], { cwd: '/home/cone', user: 'cone' });
    const target = await root('stat -c %a /home/cone/h/target');
    outcomes.push(`${after} ${String(r.stdout).trim()} ${String(target.stdout).trim()}`);
    await kernel.umount('/home/cone/h');
  }
  assert.deepEqual(
    outcomes.filter((o) => !o.endsWith(' 644')),
    [],
    outcomes.join('; ')
  );
});

test('a sudo process shares the open and removed files of the others: its writes reach their descriptors, and what it removes stays readable to them', async (t) => {
  const kernel = await createNodeKernel({ users: 'enforce' });
  t.after(() => kernel.terminate());
  for (const name of ['wasm-bash', 'wasm-coreutils']) await install(kernel, name);
  await kernel.users.add({ name: 'cone', groups: ['sudo'] });
  await kernel.run(
    [
      'bash',
      '-c',
      "printf '%s\\n' 'NOPASSWD cone Cmnd *' > /etc/sudoers.d/cone && chmod 440 /etc/sudoers.d/cone",
    ],
    { cwd: '/' }
  );
  const script = [
    'printf old > a && printf kept > b',
    'exec 3<a 4<b',
    'printf new | sudo tee a > /dev/null && sudo rm b',
    'cat <&3; echo; cat <&4; echo; ls',
  ].join('\n');
  const r = await kernel.run(['bash', '-c', script], { cwd: '/home/cone', user: 'cone' });
  assert.deepEqual([String(r.stdout), String(r.stderr)], ['new\nkept\na\n', '']);
});
