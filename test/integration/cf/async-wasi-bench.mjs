import { createNodeKernel } from '../../../dist/node.js';
import { installPackage } from './async-wasi-harness.mjs';

const files = Number(process.argv[2] ?? 3000);
const calls = Number(process.argv[3] ?? 100000);

async function kernelFor(blocking) {
  const kernel = await createNodeKernel(blocking === 'async' ? { blocking } : {});
  await installPackage(kernel, 'wasi-ripgrep');
  await installPackage(kernel, 'wasix-python');
  for (let i = 0; i < files; i++) {
    await kernel.writeFile(`/work/d${i % 50}/f${i}.txt`, i % 10 === 0 ? 'x\nneedle\n' : 'hay\n');
  }
  return kernel;
}

async function timed(kernel, argv) {
  await kernel.run(argv, { cwd: '/work' });
  const start = performance.now();
  const r = await kernel.run(argv, { cwd: '/work' });
  return { ms: Math.round(performance.now() - start), status: r.status, out: r.stdout.trim() };
}

const loop = `import os\nfor _ in range(${calls}): os.getppid()\nprint("done")`;
for (const blocking of ['sync', 'async']) {
  const kernel = await kernelFor(blocking);
  const rg = await timed(kernel, ['rg', '-c', '--no-filename', 'needle', '/work']);
  const empty = await timed(kernel, ['python', '-c', 'print("done")']);
  const sys = await timed(kernel, ['python', '-c', loop]);
  console.log(
    JSON.stringify({
      blocking,
      [`rg over ${files} files ms`]: rg.ms,
      rgStatus: rg.status,
      [`${calls} getppid syscalls ms`]: sys.ms - empty.ms,
      perSyscallUs: Math.round(((sys.ms - empty.ms) * 1000) / calls),
    })
  );
  kernel.terminate();
}
