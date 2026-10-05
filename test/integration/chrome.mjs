import { env } from 'node:process';
import { serve, launch as start } from '@ai-ecoverse/slicc-shared-web/harness';

const options = {
  roots: [
    ['/dist/', 'dist/'],
    ['/node_modules/@ai-ecoverse/', 'node_modules/@ai-ecoverse/'],
    ['/fixtures/', 'test/integration/fixtures/'],
    ['/', 'test/integration/page/'],
  ],
  isolated: true,
  coverage: ['/dist/'],
  exits: { '/dist/process-worker.js': [/WASM_PROCESS_EXIT, code/, /WASM_PROCESS_ERROR,$/] },
};

export const launch = () => start(options);

if (import.meta.main) {
  const { url } = await serve({ ...options, port: Number(env.PORT ?? 8080) });
  console.log(`slicc-kernel test page on ${url}`);
}
