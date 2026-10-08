import { randomBytes } from 'node:crypto';
import { watch } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, relative, resolve, sep } from 'node:path';

const STATUS = {
  ENOENT: 404,
  EACCES: 403,
  EPERM: 403,
  EROFS: 403,
  EEXIST: 409,
  ENOTEMPTY: 409,
  EISDIR: 409,
  ENOTDIR: 409,
  EBUSY: 409,
  ESTALE: 409,
  EINVAL: 400,
  ENAMETOOLONG: 400,
  EBADF: 410,
  ENOSPC: 507,
  EFBIG: 507,
};

const fail = (code, message = code) => Object.assign(new Error(message), { code });

function cors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin ?? '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Expose-Headers', 'X-Proxy-Error, X-Hostfs-Errno, ETag');
}

function refuse(res, status, error) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'X-Proxy-Error': '1' });
  res.end(JSON.stringify({ error }));
}

function errno(res, err) {
  const code = typeof err?.code === 'string' ? err.code : 'EIO';
  if (res.headersSent) return res.destroy();
  res.writeHead(STATUS[code] ?? 500, {
    'Content-Type': 'application/json',
    'X-Hostfs-Errno': code,
  });
  res.end(JSON.stringify({ errno: code, message: err?.message ?? code }));
}

async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function json(res, value) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
}

function attrOf(st) {
  return {
    kind: st.isDirectory() ? 'directory' : st.isSymbolicLink() ? 'symlink' : 'file',
    size: Number(st.size),
    mtime: Number(st.mtimeMs),
    mode: Number(st.mode),
    ino: Number(st.ino),
    etag: `"${st.size.toString(16)}-${st.mtimeNs.toString(16)}-${st.ino.toString(16)}"`,
  };
}

const lstatOf = (path) => fsp.lstat(path, { bigint: true });

export async function hostfsProxy({
  folders,
  key = randomBytes(32).toString('base64url'),
  pingMs = 15000,
  maxIo = 16 * 1024 * 1024,
  capabilities = {},
}) {
  const roots = new Map();
  for (const [name, path] of Object.entries(folders)) roots.set(name, await fsp.realpath(path));
  const tokens = new Map();
  const handles = new Map();
  const sockets = new Set();
  const counts = { grants: 0, watches: 0 };
  let nextFh = 0;

  function inside(root, rel) {
    const path = resolve(root, rel ?? '');
    if (path !== root && !path.startsWith(root + sep))
      throw fail('EACCES', `${rel} escapes the folder`);
    return path;
  }

  async function op(grant, req) {
    const { root, readonly } = grant;
    const write = () => {
      if (readonly) throw fail('EROFS', 'read-only folder');
    };
    const at = (rel) => inside(root, rel);
    switch (req.op) {
      case 'stat':
        return attrOf(await lstatOf(at(req.path)));
      case 'list': {
        const dir = at(req.path);
        const entries = [];
        for (const name of await fsp.readdir(dir)) {
          const st = await lstatOf(join(dir, name)).catch(() => null);
          if (st) entries.push({ name, attr: attrOf(st) });
        }
        return { entries };
      }
      case 'mkdir':
        write();
        await fsp.mkdir(at(req.path));
        return {};
      case 'rmdir':
        write();
        await fsp.rmdir(at(req.path));
        return {};
      case 'unlink': {
        write();
        const path = at(req.path);
        if (path === root) throw fail('EBUSY', 'the folder itself');
        if ((await fsp.lstat(path)).isDirectory()) throw fail('EISDIR', req.path);
        await fsp.unlink(path);
        return {};
      }
      case 'rename': {
        write();
        const from = at(req.from);
        const to = at(req.to);
        const [a, b] = await Promise.all([lstatOf(from), lstatOf(to).catch(() => null)]);
        if (b && a.ino === b.ino && a.dev === b.dev) return {};
        await fsp.rename(from, to);
        return {};
      }
      case 'symlink':
        write();
        await fsp.symlink(req.target, at(req.path));
        return {};
      case 'readlink':
        return { target: await fsp.readlink(at(req.path)) };
      case 'setattr': {
        write();
        const path = at(req.path);
        if (req.mode !== undefined) await fsp.chmod(path, req.mode & 0o7777);
        if (req.mtime !== undefined) {
          const st = await fsp.lstat(path);
          await fsp.utimes(path, st.atime, new Date(req.mtime));
        }
        return {};
      }
      case 'statfs': {
        const st = await fsp.statfs(root);
        return { bsize: st.bsize, blocks: st.blocks, bfree: st.bavail };
      }
      case 'open':
        return open(grant, req, at(req.path));
      case 'release': {
        const h = handles.get(req.fh);
        if (!h) throw fail('EBADF', `handle ${req.fh}`);
        handles.delete(req.fh);
        if (!h.write) return {};
        return { attr: attrOf(await lstatOf(h.path)) };
      }
      default:
        throw fail('EINVAL', `unknown op ${req.op}`);
    }
  }

  async function open(grant, req, path) {
    const st = await lstatOf(path).catch((err) => {
      if (err.code === 'ENOENT') return null;
      throw err;
    });
    if (st && req.exclusive) throw fail('EEXIST', req.path);
    if (st?.isDirectory()) throw fail('EISDIR', req.path);
    if (!st && !req.create) throw fail('ENOENT', req.path);
    const fh = ++nextFh;
    if (!req.write) {
      handles.set(fh, { path });
      return { fh, attr: attrOf(st) };
    }
    if (grant.readonly) throw fail('EROFS', 'read-only folder');
    if (!st) await fsp.writeFile(path, '', { flag: 'wx' });
    else if (req.truncate) await fsp.truncate(path, 0);
    handles.set(fh, { path, write: true });
    return { fh, ...(st ? { attr: attrOf(st) } : {}) };
  }

  async function read(req, res) {
    const h = handles.get(req.fh);
    if (!h) throw fail('EBADF', `handle ${req.fh}`);
    const st = await lstatOf(h.path);
    const etag = attrOf(st).etag;
    if (!h.write && req.ifMatch && req.ifMatch !== etag) throw fail('ESTALE', `${h.path} changed`);
    const file = await fsp.open(h.path, 'r');
    try {
      const size = Math.max(0, Math.min(req.size, maxIo, Number(st.size) - req.offset));
      const bytes = Buffer.alloc(size);
      const { bytesRead } = await file.read(bytes, 0, size, req.offset);
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', ETag: etag });
      res.end(bytes.subarray(0, bytesRead));
    } finally {
      await file.close();
    }
  }

  async function put(req, res) {
    const head = JSON.parse(req.headers['x-hostfs-request'] ?? '{}');
    const h = handles.get(head.fh);
    if (!h?.write) throw fail('EBADF', `handle ${head.fh}`);
    const bytes = await body(req);
    if (bytes.length > maxIo) throw fail('EFBIG', `a chunk is at most ${maxIo} bytes`);
    const file = await fsp.open(h.path, 'r+');
    try {
      await file.write(bytes, 0, bytes.length, head.offset);
    } finally {
      await file.close();
    }
    json(res, {});
  }

  function watchFolder(grant, req, res) {
    counts.watches++;
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' });
    let pending = new Set();
    let timer;
    const flush = () => {
      timer = undefined;
      const paths = [...pending];
      pending = new Set();
      if (paths.length) res.write(`${JSON.stringify({ paths })}\n`);
    };
    const watcher = watch(grant.root, { recursive: true }, (_event, name) => {
      if (!name) {
        res.write(`${JSON.stringify({ all: true })}\n`);
        return;
      }
      const rel = relative(grant.root, join(grant.root, String(name)))
        .split(sep)
        .join('/');
      pending.add(rel);
      pending.add(rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');
      timer ??= setTimeout(flush, 50);
    });
    const ping = setInterval(() => res.write('{"ping":1}\n'), pingMs);
    const stop = () => {
      watcher.close();
      clearInterval(ping);
      clearTimeout(timer);
    };
    req.on('close', stop);
    res.on('close', stop);
  }

  async function handle(req, res) {
    cors(req, res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Methods': 'POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers':
          'Content-Type, X-Bridge-Token, X-Hostfs-Token, X-Hostfs-Request',
        'Access-Control-Max-Age': '600',
      });
      return res.end();
    }
    const path = new URL(req.url, 'http://x').pathname;
    if (path === '/api/hostfs/grant' || path === '/api/hostfs/mounts') {
      if (req.headers['x-bridge-token'] !== key)
        return refuse(res, 403, 'proxy key missing or wrong');
      const ask = JSON.parse((await body(req)).toString() || '{}');
      if (path === '/api/hostfs/mounts')
        return json(
          res,
          [...roots.keys()].map((name) => ({ name, readonly: false }))
        );
      if (req.method === 'DELETE') {
        tokens.delete(ask.token);
        return json(res, {});
      }
      const root = roots.get(ask.mount);
      if (!root) return errno(res, fail('ENOENT', `no folder ${ask.mount}`));
      counts.grants++;
      const token = randomBytes(32).toString('base64url');
      tokens.set(token, { root, readonly: ask.readonly === true });
      return json(res, {
        token,
        mount: ask.mount,
        readonly: ask.readonly === true,
        capabilities: { maxIo, ...capabilities },
      });
    }
    const grant = tokens.get(req.headers['x-hostfs-token']);
    if (!grant) return refuse(res, 403, 'hostfs token missing or wrong');
    try {
      if (path === '/api/hostfs/write' && req.method === 'PUT') return await put(req, res);
      if (path === '/api/hostfs/watch' && req.method === 'POST')
        return watchFolder(grant, req, res);
      if (path !== '/api/hostfs' || req.method !== 'POST') return refuse(res, 404, 'not found');
      const call = JSON.parse((await body(req)).toString());
      if (call.op === 'read') return await read(call, res);
      json(res, await op(grant, call));
    } catch (err) {
      errno(res, err);
    }
  }

  const server = createServer((req, res) => void handle(req, res));
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}`;

  async function grantFor(name, readonly = false) {
    const response = await fetch(`${url}/api/hostfs/grant`, {
      method: 'POST',
      headers: { 'X-Bridge-Token': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ mount: name, readonly }),
    });
    const grant = await response.json();
    return { url, ...grant };
  }

  return {
    url,
    key,
    counts,
    grant: grantFor,
    revoke: () => tokens.clear(),
    async stop() {
      for (const socket of sockets) socket.destroy();
      await new Promise((done) => server.close(done));
    },
    async start() {
      await new Promise((done) => server.listen(port, '127.0.0.1', done));
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      if (server.listening) await new Promise((done) => server.close(done));
    },
  };
}
