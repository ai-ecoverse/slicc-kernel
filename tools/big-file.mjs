const MiB = 2 ** 20;
const SAFE = 256 * MiB;

const WARNING = `
  Refusing to write more than ${SAFE / MiB} MiB.

  A 1.1 GiB file through tmpfs peaked at 18 GB of RSS (about 16x the file),
  enough to take a laptop down. Do NOT run the >1 GiB case on a workstation,
  and never on Lars's Mac. Measure a small file and extrapolate instead.

  Only on a disposable machine with the memory to spare:
    SLICC_BIG_FILE_I_HAVE_THE_RAM=1 node --max-old-space-size=8192 --import fake-indexeddb/auto tools/big-file.mjs <bytes>
`;

const size = Number(process.argv[2] ?? 64 * MiB);
if (!Number.isSafeInteger(size) || size <= 0) {
  console.error('usage: node --import fake-indexeddb/auto tools/big-file.mjs [bytes]');
  process.exit(2);
}
if (size > SAFE && process.env.SLICC_BIG_FILE_I_HAVE_THE_RAM !== '1') {
  console.error(WARNING);
  process.exit(2);
}

const { launcher } = await import('../test/unit/helpers/node-process.mjs');
const { bash, kernel } = await launcher({ coreutils: true });
await kernel.fs.mkdir('/mnt/t', { recursive: true });
await kernel.mount({
  type: 'tmpfs',
  source: 'none',
  target: '/mnt/t',
  options: { maxfile: String(Math.max(size, MiB)) },
});
const run = (bytes) =>
  bash(`head -c ${bytes} /dev/urandom > /mnt/t/big && wc -c < /mnt/t/big && rm /mnt/t/big`);
await run(MiB);
const before = process.resourceUsage().maxRSS * 1024;
const started = Date.now();
const result = await run(size);
const peak = process.resourceUsage().maxRSS * 1024;
console.log(
  JSON.stringify({
    size,
    status: result.status,
    read: Number(result.stdout.trim()),
    seconds: (Date.now() - started) / 1000,
    peakRss: peak,
    rssBefore: before,
    ratio: Number(((peak - before) / size).toFixed(2)),
  })
);
process.exit(result.status === 0 && Number(result.stdout.trim()) === size ? 0 : 1);
