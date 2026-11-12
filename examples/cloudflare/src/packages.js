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
];
