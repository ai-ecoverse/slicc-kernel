import bashGlue from '../../../node_modules/@ai-ecoverse/wasm-bash/bin/bash';
import bashWasm from '../../../node_modules/@ai-ecoverse/wasm-bash/bin/bash.wasm';
import bashManifest from '../../../node_modules/@ai-ecoverse/wasm-bash/package.json';
import coreutilsGlue from '../../../node_modules/@ai-ecoverse/wasm-coreutils/bin/coreutils';
import coreutilsWasm from '../../../node_modules/@ai-ecoverse/wasm-coreutils/bin/coreutils.wasm';
import coreutilsManifest from '../../../node_modules/@ai-ecoverse/wasm-coreutils/package.json';
import curlGlue from '../../../node_modules/@ai-ecoverse/wasm-curl/bin/curl';
import curlWasm from '../../../node_modules/@ai-ecoverse/wasm-curl/bin/curl.wasm';
import curlManifest from '../../../node_modules/@ai-ecoverse/wasm-curl/package.json';
import jqGlue from '../../../node_modules/@ai-ecoverse/wasm-jq/bin/jq';
import jqWasm from '../../../node_modules/@ai-ecoverse/wasm-jq/bin/jq.wasm';
import jqManifest from '../../../node_modules/@ai-ecoverse/wasm-jq/package.json';

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
    name: '@ai-ecoverse/wasm-curl',
    files: {
      'package.json': JSON.stringify(curlManifest, null, 2),
      'bin/curl': curlGlue,
      'bin/curl.wasm': curlWasm,
    },
  },
  {
    name: '@ai-ecoverse/wasm-jq',
    files: {
      'package.json': JSON.stringify(jqManifest, null, 2),
      'bin/jq': jqGlue,
      'bin/jq.wasm': jqWasm,
    },
  },
];
