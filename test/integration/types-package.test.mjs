import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const tsc = join(root, 'node_modules/typescript/bin/tsc');

const USE = `import { createKernel, fetchTransport, type KernelClient, type NetworkExit } from '@ai-ecoverse/slicc-kernel';
import { createNodeKernel, nodeTransport, type SealedOAuthReply } from '@ai-ecoverse/slicc-kernel/node';
import type { SealedOAuthRequest } from '@ai-ecoverse/slicc-kernel';
import { fakeUplink } from '@ai-ecoverse/slicc-kernel/testing';
export async function main(client: KernelClient): Promise<number> {
  const exit: NetworkExit | undefined = client.transport.traits.exit;
  const kernel = await createNodeKernel({
    network: { transport: nodeTransport({ hostLoopback: [8080] }), uplink: fakeUplink({}) },
  });
  const ran = await kernel.run(['true']);
  const request: SealedOAuthRequest = { v: 1, op: 'oauthGrant', name: 'EXAMPLE_TOKEN', provider: 'example', account: 'default', accessToken: 'fake-access-token', oauth: { tokenUrl: 'https://auth.example.invalid/token', clientId: 'example-public-client', authMethod: 'none' } };
  const reply: SealedOAuthReply = { v: 1, placeholder: 'fnox_proxy_0123456789abcdef01234567', state: 'ready', expiresAt: null, refreshable: false };
  void [createKernel, fetchTransport, exit, request, reply];
  return ran.status;
}
`;

const WRONG = `import { createNodeKernel, type SealedOAuthConfig } from '@ai-ecoverse/slicc-kernel/node';
export const wrong: string = createNodeKernel;
export const confidential: SealedOAuthConfig = { tokenUrl: 'https://auth.example.invalid/token', clientId: 'example-client', authMethod: 'client_secret_post' };
`;

test('the packed tarball ships declarations: a TypeScript consumer of its public entries type-checks, and a wrong use is an error (#693)', {
  timeout: 120_000,
}, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'kernel-types-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const packed = execFileSync(
    'npm',
    ['pack', '--ignore-scripts', '--silent', '--pack-destination', dir],
    {
      cwd: root,
      encoding: 'utf8',
    }
  ).trim();
  const installed = join(dir, 'consumer/node_modules/@ai-ecoverse/slicc-kernel');
  await mkdir(installed, { recursive: true });
  execFileSync('tar', [
    '-xzf',
    join(dir, packed.split('\n').at(-1)),
    '-C',
    installed,
    '--strip-components=1',
  ]);
  const shipped = await readdir(join(installed, 'dist/types'));
  for (const entry of ['index.d.ts', 'node.d.ts', 'driver.d.ts', 'testing.d.ts', 'meta.d.ts']) {
    assert.ok(shipped.includes(entry), entry);
  }
  const consumer = join(dir, 'consumer');
  await writeFile(join(consumer, 'package.json'), '{"type":"module"}\n');
  await writeFile(join(consumer, 'use.ts'), USE);
  await writeFile(join(consumer, 'wrong.ts'), WRONG);
  const config = (file) => ({
    compilerOptions: {
      target: 'ES2024',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      noEmit: true,
      lib: ['ES2024', 'DOM'],
      types: ['node'],
      typeRoots: [join(root, 'node_modules/@types')],
    },
    files: [file],
  });
  await writeFile(join(consumer, 'tsconfig.json'), JSON.stringify(config('use.ts')));
  await writeFile(join(consumer, 'tsconfig.wrong.json'), JSON.stringify(config('wrong.ts')));
  const check = (project) =>
    spawnSync(process.execPath, [tsc, '-p', project], { cwd: consumer, encoding: 'utf8' });
  const good = check('tsconfig.json');
  assert.equal(good.status, 0, good.stdout + good.stderr);
  const bad = check('tsconfig.wrong.json');
  assert.notEqual(bad.status, 0);
  assert.match(bad.stdout, /is not assignable to type 'string'/);
  assert.match(bad.stdout, /client_secret_post/);
});
