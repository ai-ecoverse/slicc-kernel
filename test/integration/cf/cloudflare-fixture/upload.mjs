import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const BATCH_BYTES = 24 * 2 ** 20;

async function filesOf(from, wanted, rel = '') {
  const out = [];
  for (const entry of await readdir(join(from, rel), { withFileTypes: true })) {
    const path = rel ? `${rel}/${entry.name}` : entry.name;
    if (!wanted(path, entry.isDirectory())) continue;
    if (entry.isDirectory()) out.push(...(await filesOf(from, wanted, path)));
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

function frame(batch) {
  const manifest = new TextEncoder().encode(
    JSON.stringify(batch.map(([path, b]) => [path, b.length]))
  );
  const head = new Uint8Array(4);
  new DataView(head.buffer).setUint32(0, manifest.length, true);
  return Buffer.concat([head, manifest, ...batch.map(([, b]) => b)]);
}

export async function uploadTree(call, from, to, wanted = () => true) {
  const files = await filesOf(from, wanted);
  let batch = [];
  let size = 0;
  let sent = 0;
  const flush = async () => {
    if (batch.length === 0) return;
    const r = await call('/kernel/bulk', frame(batch), { raw: true });
    if (r.status !== 200) throw new Error(`bulk upload failed: ${JSON.stringify(r).slice(0, 300)}`);
    sent += batch.length;
    batch = [];
    size = 0;
  };
  for (const rel of files) {
    const bytes = await readFile(join(from, rel));
    if (size + bytes.length > BATCH_BYTES) await flush();
    batch.push([`${to}/${rel}`, bytes]);
    size += bytes.length;
  }
  await flush();
  return sent;
}

export async function uploadFiles(call, files) {
  const batch = files.map(([path, data]) => [
    path,
    Buffer.from(typeof data === 'string' ? new TextEncoder().encode(data) : data),
  ]);
  const r = await call('/kernel/bulk', frame(batch), { raw: true });
  if (r.status !== 200) throw new Error(`bulk upload failed: ${JSON.stringify(r).slice(0, 300)}`);
}
