const errno = (code, message = code) => Object.assign(new Error(message), { code });
const decoder = new TextDecoder();

export default function mockS3({ fetch }) {
  let endpoint = '';
  const key = (path) => path.replace(/^\/+/, '');
  const url = (k, query = '') =>
    `${endpoint}/${encodeURIComponent(k).replaceAll('%2F', '/')}${query}`;
  async function call(method, k, { body, query } = {}) {
    const response = await fetch({
      url: url(k, query),
      method,
      headers: [],
      ...(body ? { body } : {}),
    });
    const chunks = [];
    for await (const chunk of response.body) chunks.push(chunk);
    const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const c of chunks) {
      bytes.set(c, at);
      at += c.length;
    }
    if (response.status === 404) throw errno('ENOENT', `${method} ${k}`);
    if (response.status >= 400) throw errno('EIO', `${method} ${k}: ${response.status}`);
    return bytes;
  }
  const list = async (prefix) =>
    JSON.parse(
      decoder.decode(await call('GET', '', { query: `?list=${encodeURIComponent(prefix)}` }))
    );
  async function attr(path) {
    const k = key(path);
    if (k === '') return { kind: 'directory', size: 0, mtime: 0, mode: 0o40755 };
    const found = await list(k);
    const file = found.find((o) => o.key === k);
    if (file) return { kind: 'file', size: file.size, mtime: file.mtime, mode: 0o100644 };
    if (found.some((o) => o.key.startsWith(`${k}/`)))
      return { kind: 'directory', size: 0, mtime: 0, mode: 0o40755 };
    throw errno('ENOENT', path);
  }
  const handles = new Map();
  let next = 0;
  return {
    capabilities: { maxIo: 1 << 20, attrTtl: 0 },
    handlers: {
      mount({ source }) {
        endpoint = source.replace(/\/+$/, '');
      },
      getattr: attr,
      async readdir(path) {
        const k = key(path);
        const prefix = k ? `${k}/` : '';
        const names = new Map();
        for (const o of await list(prefix)) {
          const rest = o.key.slice(prefix.length);
          if (!rest || rest === '.dir') continue;
          const [name, ...deeper] = rest.split('/');
          if (deeper.length > 0) names.set(name, 'directory');
          else if (!names.has(name)) names.set(name, 'file');
        }
        return [...names].map(([name, kind]) => ({ name, kind }));
      },
      async open(path, flags) {
        const k = key(path);
        let data = new Uint8Array(0);
        if (!flags.truncate) {
          try {
            data = await call('GET', k);
          } catch (err) {
            if (err.code !== 'ENOENT' || !flags.create) throw err;
          }
        }
        handles.set(++next, { k, data, dirty: flags.truncate });
        return next;
      },
      async read(fh, offset, size) {
        return handles.get(fh).data.slice(offset, offset + size);
      },
      async write(fh, offset, bytes) {
        const h = handles.get(fh);
        const grown = new Uint8Array(Math.max(h.data.length, offset + bytes.length));
        grown.set(h.data);
        grown.set(bytes, offset);
        h.data = grown;
        h.dirty = true;
      },
      async release(fh) {
        const h = handles.get(fh);
        handles.delete(fh);
        if (h.dirty) await call('PUT', h.k, { body: h.data });
      },
      async mkdir(path) {
        await call('PUT', `${key(path)}/.dir`, { body: new Uint8Array(0) });
      },
      async rmdir(path) {
        const k = key(path);
        const inside = (await list(`${k}/`)).filter((o) => o.key !== `${k}/.dir`);
        if (inside.length > 0) throw errno('ENOTEMPTY', path);
        await call('DELETE', `${k}/.dir`).catch(() => undefined);
      },
      async unlink(path) {
        await call('DELETE', key(path));
      },
      async rename(from, to) {
        const a = key(from);
        const b = key(to);
        const moved = (await list(a)).filter((o) => o.key === a || o.key.startsWith(`${a}/`));
        if (moved.length === 0) throw errno('ENOENT', from);
        for (const o of moved) {
          const target = b + o.key.slice(a.length);
          await call('PUT', target, { body: await call('GET', o.key) });
          await call('DELETE', o.key);
        }
      },
      async statfs() {
        return { bsize: 4096, blocks: 1 << 20, bfree: 1 << 19 };
      },
    },
  };
}
