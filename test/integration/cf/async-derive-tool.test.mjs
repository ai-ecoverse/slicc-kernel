import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DeriveError, deriveAsync, memberSeed } from '../../../tools/derive-async/index.mjs';

const TSCONFIG = {
  compilerOptions: {
    target: 'ES2024',
    module: 'NodeNext',
    moduleResolution: 'NodeNext',
    lib: ['ES2024', 'DOM'],
    types: [],
    strict: true,
    skipLibCheck: true,
    allowImportingTsExtensions: true,
    noEmit: true,
  },
  include: ['src/**/*.ts'],
};

const RUNTIME = `export async function atomicsWait(): Promise<string> {
  return 'ok';
}
`;

const TRANSPORT = `export interface Transport {
  call(op: string): number;
}
`;

async function project(t, files) {
  const root = await mkdtemp(join(tmpdir(), 'derive-async-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'tsconfig.json'), JSON.stringify(TSCONFIG));
  const all = { 'src/runtime.ts': RUNTIME, 'src/transport.ts': TRANSPORT, ...files };
  for (const [file, text] of Object.entries(all)) {
    await mkdir(join(root, file, '..'), { recursive: true });
    await writeFile(join(root, file), text);
  }
  return root;
}

const config = (entry) => ({
  entries: [entry],
  runtime: 'src/runtime.ts',
  libSeeds: ['Atomics.wait'],
  sourceSeeds: [memberSeed('src/transport.ts', 'Transport', 'call')],
  asyncCallbacks: ['Promise.then'],
  lostInto: [],
  forwarders: [],
  replaceCalls: [{ lib: 'Atomics.wait', with: 'atomicsWait', await: true }],
  wrapArguments: [],
});

const derivedText = (derived, root, file) => derived.files.get(join(root, file));

test('a function that reaches the transport becomes async and its callers await it, through an interface and a function value', async (t) => {
  const root = await project(t, {
    'src/main.ts': `import type { Transport } from './transport.ts';

interface Kernel {
  stat(path: string): number;
  pure(n: number): number;
}

function kernelOf(transport: Transport): Kernel {
  return {
    stat: (path) => transport.call(path) + 1,
    pure: (n) => n * 2,
  };
}

const twice = (fn: () => number): number => fn() + fn();

export function main(transport: Transport): number {
  const k = kernelOf(transport);
  const doubled = k.pure(2);
  return twice(() => k.stat('/')) + doubled;
}

export function waits(view: Int32Array): string {
  return Atomics.wait(view, 0, 0, 10);
}
`,
  });
  const derived = await deriveAsync({ root, config: config('src/main.ts') });
  const text = derivedText(derived, root, 'src/main.ts');
  assert.match(text, /stat: async \(path\) => \(await transport\.call\(path\)\) \+ 1/);
  assert.match(text, /pure: \(n\) => n \* 2/);
  assert.match(
    text,
    /const twice = async \(fn: \(\) => number\): number => \(await fn\(\)\) \+ \(await fn\(\)\)/
  );
  assert.match(text, /export async function main/);
  assert.match(text, /const doubled = k\.pure\(2\);/);
  assert.match(
    text,
    /return \(await twice\(async \(\) => \(await k\.stat\('\/'\)\)\)\) \+ doubled;/
  );
  assert.match(text, /return \(await atomicsWait\(view, 0, 0, 10\)\);/);
  assert.match(text, /^import \{ atomicsWait \} from '\.\/runtime\.ts';/);
});

test('a blocking call where it cannot be derived fails with the file, line and reason', async (t) => {
  const root = await project(t, {
    'src/main.ts': `import type { Transport } from './transport.ts';

export class Holder {
  readonly size: number;
  constructor(private readonly transport: Transport) {
    this.size = transport.call('size');
  }

  get current(): number {
    return this.transport.call('current');
  }

  all(names: string[]): number[] {
    return names.map((name) => this.transport.call(name));
  }

  lost(): unknown {
    const table: Record<string, unknown> = { fn: () => this.transport.call('x') };
    return table;
  }
}
`,
  });
  await assert.rejects(deriveAsync({ root, config: config('src/main.ts') }), (err) => {
    assert.ok(err instanceof DeriveError);
    const reasons = err.problems.map((p) => `${p.line}: ${p.reason}`).sort();
    assert.deepEqual(reasons, [
      '10: a blocking call in a getter',
      '14: a blocking function passed as a callback to Array.map, which calls it synchronously',
      '18: a blocking function flows into a value of type unknown, where its calls cannot be followed',
      '6: a blocking call in a constructor',
    ]);
    assert.match(err.message, /src\/main\.ts:6:/);
    return true;
  });
});
