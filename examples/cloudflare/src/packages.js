import rgWasm from '../../../node_modules/@ai-ecoverse/wasi-ripgrep/bin/rg.wasm';
import rgManifest from '../../../node_modules/@ai-ecoverse/wasi-ripgrep/package.json';
import bashGlue from '../../../node_modules/@ai-ecoverse/wasm-bash/bin/bash';
import bashWasm from '../../../node_modules/@ai-ecoverse/wasm-bash/bin/bash.wasm';
import bashManifest from '../../../node_modules/@ai-ecoverse/wasm-bash/package.json';
import coreutilsGlue from '../../../node_modules/@ai-ecoverse/wasm-coreutils/bin/coreutils';
import coreutilsWasm from '../../../node_modules/@ai-ecoverse/wasm-coreutils/bin/coreutils.wasm';
import coreutilsManifest from '../../../node_modules/@ai-ecoverse/wasm-coreutils/package.json';

export const PACKAGES = [
  {
    name: '@ai-ecoverse/wasm-bash',
    files: {
      'package.json': JSON.stringify(bashManifest, null, 2),
      'bin/bash': bashGlue,
      'bin/bash.wasm': bashWasm,
    },
  },
  {
    name: '@ai-ecoverse/wasm-coreutils',
    files: {
      'package.json': JSON.stringify(coreutilsManifest, null, 2),
      'bin/coreutils': coreutilsGlue,
      'bin/coreutils.wasm': coreutilsWasm,
    },
  },
  {
    name: '@ai-ecoverse/wasi-ripgrep',
    files: {
      'package.json': JSON.stringify(rgManifest, null, 2),
      'bin/rg.wasm': rgWasm,
    },
  },
];
