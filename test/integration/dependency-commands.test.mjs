import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNodeKernel } from '../../dist/node.js';

const modules = new URL('../../node_modules/@ai-ecoverse/', import.meta.url);
const TOOLS = '/opt/tools/node_modules';

async function install(kernel, name) {
  const base = fileURLToPath(new URL(`${name}/`, modules));
  const entries = await readdir(base, { recursive: true, withFileTypes: true });
  for (const entry of entries.filter((e) => e.isFile())) {
    const file = join(entry.parentPath, entry.name);
    await kernel.writeFile(
      `/node_modules/@ai-ecoverse/${name}/${relative(base, file)}`,
      await readFile(file)
    );
  }
}

function program(says) {
  return `export default async function main(ctx) { await ctx.write(1, ${JSON.stringify(`${says}\n`)}); return 0; }\n`;
}

async function manifestFiles(kernel, dir, name, commands) {
  const entries = Object.fromEntries(commands.map((c) => [c, { module: `bin/${c}.mjs` }]));
  const manifest = { name, version: '1.0.0', slicc: { abi: 'js', commands: entries } };
  await kernel.writeFile(`${dir}/package.json`, JSON.stringify(manifest));
  for (const command of commands) {
    await kernel.writeFile(`${dir}/bin/${command}.mjs`, program(`${command} from ${name}`));
  }
}

async function tarball(name, commands, dependencies, script) {
  const dir = await mkdtemp(join(tmpdir(), 'slicc-dep-commands-'));
  await mkdir(join(dir, 'package', 'bin'), { recursive: true });
  const entries = Object.fromEntries(commands.map((c) => [c, { module: `bin/${c}.mjs` }]));
  if (script) {
    entries.carrierscript = { script: 'bin/carrierscript' };
    await writeFile(join(dir, 'package', 'bin', 'carrierscript'), script);
    await chmod(join(dir, 'package', 'bin', 'carrierscript'), 0o755);
  }
  const manifest = {
    name,
    version: '1.0.0',
    dependencies,
    slicc: { abi: 'js', commands: entries },
  };
  await writeFile(join(dir, 'package', 'package.json'), JSON.stringify(manifest));
  for (const command of commands) {
    await writeFile(
      join(dir, 'package', 'bin', `${command}.mjs`),
      program(`${command} from ${name}`)
    );
  }
  execFileSync('tar', ['czf', join(dir, 'p.tgz'), '-C', dir, 'package']);
  const bytes = await readFile(join(dir, 'p.tgz'));
  await rm(dir, { recursive: true, force: true });
  return bytes;
}

async function kernelWithBase() {
  const kernel = await createNodeKernel({ users: 'enforce', commands: { append: [TOOLS] } });
  for (const name of ['wasm-bash', 'wasm-coreutils', 'wasm-tls-engine', 'wasi-pnpm']) {
    await install(kernel, name);
  }
  await manifestFiles(kernel, '/node_modules/base-set', 'base-set', ['basecmd']);
  await manifestFiles(kernel, `${TOOLS}/base-tool`, 'base-tool', ['toolcmd']);
  await kernel.writeFile(
    '/srv/carrier.tgz',
    await tarball(
      'carrier',
      ['carriercmd'],
      { shadow: 'file:/srv/shadow.tgz' },
      '#!/usr/bin/perlish\n'
    )
  );
  await kernel.writeFile(
    '/srv/shadow.tgz',
    await tarball('shadow', ['basecmd', 'toolcmd', 'perlish'], {})
  );
  return kernel;
}

function asUser(kernel, name) {
  return async (script) => {
    const r = await kernel.run(['bash', '-c', script], { cwd: `/home/${name}`, user: name });
    assert.equal(r.stderr, '');
    return r.stdout;
  };
}

const QUIET = '>/dev/null 2>&1; echo "add $?"';

test('a user: a hoisted dependency loses to the base set and keeps a name nothing else provides', async (t) => {
  const kernel = await kernelWithBase();
  t.after(() => kernel.terminate());
  await kernel.users.add({ name: 'cone' });
  const cone = asUser(kernel, 'cone');
  assert.equal(await cone(`pnpm add -g /srv/carrier.tgz ${QUIET}`), 'add 0\n');
  assert.equal(
    await cone('basecmd; toolcmd; perlish; carriercmd'),
    'basecmd from base-set\ntoolcmd from base-tool\nperlish from shadow\ncarriercmd from carrier\n'
  );
  assert.equal(
    await cone('command -v basecmd toolcmd perlish'),
    '/usr/bin/basecmd\n/usr/bin/toolcmd\n/home/cone/.local/share/pnpm/bin/perlish\n'
  );
  assert.equal(
    await cone('ls "$PNPM_HOME/bin" | tr "\\n" " "; "$PNPM_HOME/bin/perlish"'),
    'carriercmd carrierscript perlish perlish from shadow\n'
  );
  assert.equal(await cone('"$PNPM_HOME/bin/basecmd" 2>/dev/null; echo "rc=$?"'), 'rc=127\n');
});

test('a user: the same package installed directly still shadows the base set, even next to a package that depends on it', async (t) => {
  const kernel = await kernelWithBase();
  t.after(() => kernel.terminate());
  await kernel.users.add({ name: 'direct' });
  await kernel.users.add({ name: 'both' });
  await kernel.users.add({ name: 'apart' });
  await kernel.users.add({ name: 'isolated' });
  const expected = 'basecmd from shadow\ntoolcmd from shadow\n';

  const direct = asUser(kernel, 'direct');
  assert.equal(await direct(`pnpm add -g /srv/shadow.tgz ${QUIET}`), 'add 0\n');
  assert.equal(await direct('basecmd; toolcmd'), expected);

  const both = asUser(kernel, 'both');
  assert.equal(await both(`pnpm add -g /srv/carrier.tgz /srv/shadow.tgz ${QUIET}`), 'add 0\n');
  assert.equal(await both('basecmd; toolcmd'), expected);

  const apart = asUser(kernel, 'apart');
  assert.equal(await apart(`pnpm add -g /srv/carrier.tgz ${QUIET}`), 'add 0\n');
  assert.equal(await apart(`pnpm add -g /srv/shadow.tgz ${QUIET}`), 'add 0\n');
  assert.equal(await apart('basecmd; toolcmd'), expected);

  const isolated = asUser(kernel, 'isolated');
  const linker = 'PNPM_CONFIG_NODE_LINKER=isolated pnpm add -g --config.node-linker=isolated';
  assert.equal(await isolated(`${linker} /srv/shadow.tgz ${QUIET}`), 'add 0\n');
  assert.equal(await isolated('basecmd; toolcmd'), expected);
});

test('root: a hoisted dependency loses to an appended root for every user, and a direct install does not', async (t) => {
  const kernel = await kernelWithBase();
  t.after(() => kernel.terminate());
  await kernel.users.add({ name: 'cone' });
  const cone = asUser(kernel, 'cone');
  const root = async (script) => {
    const r = await kernel.run(['bash', '-c', script], { cwd: '/root' });
    assert.equal(r.stderr, '');
    return r.stdout;
  };

  assert.equal(await root(`pnpm add -g /srv/carrier.tgz ${QUIET}`), 'add 0\n');
  const hoisted = 'basecmd from base-set\ntoolcmd from base-tool\nperlish from shadow\n';
  assert.equal(await root('basecmd; toolcmd; perlish'), hoisted);
  assert.equal(await cone('basecmd; toolcmd; perlish'), hoisted);
  assert.equal(await cone('carrierscript'), 'perlish from shadow\n');
  assert.equal(await cone('command -v toolcmd perlish'), '/usr/bin/toolcmd\n/usr/bin/perlish\n');

  assert.equal(await root(`pnpm add -g /srv/shadow.tgz ${QUIET}`), 'add 0\n');
  const direct = 'basecmd from base-set\ntoolcmd from shadow\nperlish from shadow\n';
  assert.equal(await root('basecmd; toolcmd; perlish'), direct);
  assert.equal(await cone('basecmd; toolcmd; perlish'), direct);
});
