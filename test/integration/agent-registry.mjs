import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const upstream = (process.env.SLICC_UPSTREAM_REGISTRY ?? 'https://registry.npmjs.org').replace(
  /\/$/,
  ''
);

export async function agentRegistry(
  lock = resolve('test/integration/fixtures/agent-install/pnpm-lock.yaml'),
  out = resolve('test/integration/.registry')
) {
  const text = readFileSync(lock, 'utf8');
  const start = text.indexOf('\npackages:\n');
  const end = text.indexOf('\nsnapshots:\n');
  const section = text.slice(start, end === -1 ? undefined : end);
  const entries = [
    ...section.matchAll(
      /^ {2}'?((?:@[^/\s']+\/)?[^@\s']+)@([^:'\s(]+)'?:\n {4}resolution: \{integrity: ([^,}]+)/gm
    ),
  ];
  let fetched = 0;
  let kept = 0;
  for (const [, name, version, integrity] of entries) {
    const base = name.split('/').pop();
    const rel = `${name}/-/${base}-${version}.tgz`;
    const file = join(out, rel);
    const [algo, digest] = integrity.split('-');
    const ok = (bytes) => createHash(algo).update(bytes).digest('base64') === digest;
    try {
      if (statSync(file).size > 0 && ok(readFileSync(file))) {
        kept++;
        continue;
      }
    } catch {}
    const res = await fetch(`${upstream}/${rel}`);
    if (!res.ok) throw new Error(`agent-registry: ${rel}: HTTP ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (!ok(bytes)) throw new Error(`agent-registry: ${rel}: integrity mismatch`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, bytes);
    fetched++;
  }
  if (entries.length === 0) throw new Error(`agent-registry: no packages in ${lock}`);
  const byName = new Map();
  for (const [, name, version] of entries) byName.set(name, [...(byName.get(name) ?? []), version]);
  for (const [name, versions] of byName) {
    const file = join(out, name, 'index.json');
    const res = await fetch(`${upstream}/${name.replace('/', '%2f')}`, {
      headers: { accept: 'application/vnd.npm.install-v1+json' },
    });
    if (!res.ok) throw new Error(`agent-registry: ${name}: HTTP ${res.status}`);
    const doc = await res.json();
    const kept = Object.fromEntries(
      versions.map((v) => {
        const meta = doc.versions?.[v];
        if (!meta) throw new Error(`agent-registry: ${name}@${v} is not in the packument`);
        const base = name.split('/').pop();
        return [
          v,
          {
            ...meta,
            dist: { ...meta.dist, tarball: `http://registry.test/${name}/-/${base}-${v}.tgz` },
          },
        ];
      })
    );
    const latest = versions.at(-1);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ ...doc, 'dist-tags': { latest }, versions: kept }));
  }
  return { tarballs: entries.length, fetched, kept };
}
