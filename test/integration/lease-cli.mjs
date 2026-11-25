import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

export const externalCli = process.env.SLICC_TEST_LEASE_CLI_WASM;

export async function cliFiles() {
  const manifest = {
    name: 'cdp',
    slicc: { abi: 'wasi', commands: { 'playwright-cli': { wasm: 'cli.wasm' } } },
  };
  return [
    ['/node_modules/cdp/package.json', JSON.stringify(manifest)],
    ['/node_modules/cdp/cli.wasm', await readFile(externalCli)],
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
  for (const args of [
    ['goto', origin],
    ['click', 'e1'],
    ['fill', 'e1', 'test'],
  ])
    assert.equal(await cli('--lease', lease, ...args), 'OK\n');
  assert.equal(await cli('--lease', lease, 'snapshot'), 'fixture document\n');
  assert.ok(
    (await cli('lease', 'request', '--from', lease, '--add', `${origin}/receipt`)).includes(
      'Pending owner review.'
    )
  );
}
