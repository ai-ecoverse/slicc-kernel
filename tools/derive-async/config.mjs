import { memberSeed, returnSeed, typeSeed } from './index.mjs';

export const config = {
  entries: ['src/async/process-entry.ts'],
  runtime: 'src/async/jspi.ts',
  libSeeds: ['Atomics.wait'],
  sourceSeeds: [
    memberSeed('src/realm/sync-sab-bridge.ts', 'SyncSabTransport', 'call'),
    typeSeed('src/realm/sync-sab-bridge.ts', 'AtomicsWaitLike'),
    typeSeed('src/kernel/cpu-clock.ts', 'rawWait'),
    returnSeed('src/process/wasi/wasm-reentry.ts', 'reentered'),
  ],
  asyncCallbacks: ['Promise.then', 'Promise.catch', 'Promise.finally'],
  lostInto: ['WebAssembly.ImportValue', 'WebAssembly.ModuleImports', 'WebAssembly.Imports'],
  forwarders: [
    { ...memberSeed('src/process/wasi/wasi-stats.ts', 'WasiStats', 'wrap'), argument: 1 },
  ],
  replaceCalls: [
    { lib: 'Atomics.wait', with: 'atomicsWait', await: true },
    { lib: 'WebAssembly.Module', with: 'refusedModule' },
    { lib: 'WebAssembly.compile', with: 'refusedModule' },
  ],
  importCalls: 'refusedImport',
  wrapArguments: [
    { lib: 'WebAssembly.instantiate', argument: 1, with: 'suspendingImports' },
    { lib: 'WebAssembly.Instance', argument: 1, with: 'suspendingImports' },
  ],
  overrides: {
    'src/process/wasi/wasm-reentry.ts': "export { reentered } from '../../async/jspi.ts';\n",
  },
};
