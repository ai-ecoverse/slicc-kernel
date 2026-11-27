import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

export const cliPackage = '/node_modules/@ai-ecoverse/slicc-cdp';

export async function cliFiles() {
  const manifest = await readFile(
    new URL(`../..${cliPackage}/package.json`, import.meta.url),
    'utf8'
  );
  const { wasm } = JSON.parse(manifest).slicc.commands['playwright-cli'];
  assert.equal(wasm, 'bin/playwright-cli.wasm');
  return [
    [`${cliPackage}/package.json`, manifest],
    [
      `${cliPackage}/${wasm}`,
      await readFile(new URL(`../..${cliPackage}/${wasm}`, import.meta.url)),
    ],
  ];
}

export async function exerciseCli(run, { lease, jkt }) {
  const cli = async (...args) => {
    const result = await run(['playwright-cli', ...args]);
    assert.equal(result.status, 0, JSON.stringify(result));
    return result.stdout;
  };
  const origin = 'https://billing.example';
  const pending = await cli('lease', 'request', '--allow', origin, '--for', '1h');
  assert.ok(pending.includes(`Lease: ${lease}\n`));
  assert.equal(
    pending.trimEnd().split('\n').at(-1),
    `slicc lease review --to jkt:${jkt} --allow ${origin} --for 1h`
  );
  assert.equal(await cli('--lease', lease, 'goto', origin), 'OK\n');
  assert.equal(await cli('--lease', lease, 'snapshot'), 'fixture document\n');
  for (const args of [
    ['click', 'e1'],
    ['fill', 'e1', 'test'],
    ['eval', '1'],
  ]) {
    const r = await run(['playwright-cli', '--lease', lease, ...args]);
    assert.equal(r.status, 1);
    assert.equal(r.stdout, '');
    assert.equal(JSON.parse(r.stderr).reason, 'E_UNSUPPORTED');
  }
  assert.ok(
    (await cli('lease', 'request', '--from', lease, '--add', `${origin}/receipt`)).includes(
      'Pending owner review.'
    )
  );
}
