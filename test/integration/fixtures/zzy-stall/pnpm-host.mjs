export const errno = {
  EACCES: 2,
  EAGAIN: 6,
  EBADF: 8,
  ECANCELED: 11,
  EEXIST: 20,
  EFAULT: 21,
  EINVAL: 28,
  EIO: 29,
  EISDIR: 31,
  ELOOP: 32,
  ENOENT: 44,
  ENOTDIR: 54,
  ENOTEMPTY: 55,
  ENOTSUP: 58,
  EPERM: 63,
  EWOULDBLOCK: 6,
};

const TYPE_BITS = { file: 0o100000, dir: 0o040000, symlink: 0o120000 };
const UMASK = 0o022;
const DEFAULT_UID = 1000;
const MAX_RESPONSE = 1024 * 1024;

export function createImports(ctx) {
  const zlog = [];
  let zflush = Date.now();
  const zt0 = Date.now();
  const zput = (line) => {
    zlog.push(line);
    if (zlog.length >= 400 || Date.now() - zflush > 2000) {
      zflush = Date.now();
      try {
        const path = `/tmp/aops-${ctx.tid}.log`;
        let prev = new Uint8Array();
        try {
          prev = ctx.fs.readFile(path);
        } catch {}
        const add = new TextEncoder().encode(zlog.join('\n') + '\n');
        const all = new Uint8Array(prev.length + add.length);
        all.set(prev);
        all.set(add, prev.length);
        ctx.fs.writeFile(path, all);
        zlog.length = 0;
      } catch {}
    }
  };
  const raw = ctx.async;
  const ops = new Map();
  ctx = {
    ...ctx,
    async: {
      ...raw,
      submit(req) {
        const id = raw.submit(req);
        ops.set(id, req.op);
        zput(`S ${Date.now() - zt0} ${id} ${req.op}`);
        return id;
      },
      wait(timeoutMs) {
        const t = Date.now();
        const id = raw.wait(timeoutMs);
        const d = Date.now() - t;
        if (d >= 1000) zput(`W ${t - zt0} ${d} ${id} ${ops.get(id) ?? '?'} ${timeoutMs ?? '-'}`);
        return id;
      },
      take(id) {
        const r = raw.take(id);
        if (r !== undefined) zput(`T ${Date.now() - zt0} ${id} ${ops.get(id) ?? '?'}`);
        return r;
      },
    },
  };
  return {
    pnpm_atomic: createAtomics(ctx),
    pnpm_fs: createFilesystem(ctx),
    pnpm_host: createHost(ctx),
  };
}

function createAtomics(ctx) {
  function wait(pointer, expected, timeout, offset, width) {
    const buffer = ctx.memory().buffer;
    const address = (pointer >>> 0) + (offset >>> 0);
    if (address % width !== 0 || address + width > buffer.byteLength) {
      throw new WebAssembly.RuntimeError('Unaligned or out-of-bounds atomic wait');
    }
    const view = width === 4 ? new Int32Array(buffer) : new BigInt64Array(buffer);
    const ms = timeout < 0n ? Infinity : Number(timeout) / 1e6;
    const result = Atomics.wait(view, address / width, expected, ms);
    return result === 'ok' ? 0 : result === 'not-equal' ? 1 : 2;
  }
  return {
    wait32: (pointer, expected, timeout, offset) => wait(pointer, expected, timeout, offset, 4),
    wait64: (pointer, expected, timeout, offset) => wait(pointer, expected, timeout, offset, 8),
  };
}

export function errorNumber(error) {
  if (typeof error?.code === 'string' && error.code in errno) return errno[error.code];
  if (typeof error?.code === 'string' && /^E[A-Z]+$/.test(error.code)) return errno.EIO;
  if (Number.isInteger(error?.errno) && error.errno > 0) return error.errno;
  if (error instanceof RangeError) return errno.EFAULT;
  return errno.EIO;
}

function checked(operation) {
  return (...args) => {
    try {
      operation(...args);
      return 0;
    } catch (error) {
      return errorNumber(error);
    }
  };
}

function fail(code, message = code) {
  return Object.assign(new Error(message), { code });
}

function kindOf(stat) {
  if (stat.isSymbolicLink || stat.kind === 'symlink') return 'symlink';
  if (stat.isDirectory || stat.kind === 'dir') return 'dir';
  return 'file';
}

function withType(stat) {
  const kind = kindOf(stat);
  const mode = (stat.mode ?? (kind === 'dir' ? 0o755 : kind === 'symlink' ? 0o777 : 0o644)) >>> 0;
  return mode >= 0o10000 ? mode : (mode | TYPE_BITS[kind]) >>> 0;
}

function createFilesystem(ctx) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const uid = ctx.uid ?? DEFAULT_UID;
  function guestPath(pointer, length) {
    const value = decoder.decode(
      Uint8Array.from(new Uint8Array(ctx.memory().buffer, pointer >>> 0, length >>> 0))
    );
    if (!value.startsWith('/') || value.includes('\0'))
      throw fail('EINVAL', 'Expected an absolute guest path');
    return value;
  }
  function setU32(pointer, value) {
    new DataView(ctx.memory().buffer).setUint32(pointer >>> 0, value >>> 0, true);
  }
  function open(pointer, length, output, options) {
    try {
      setU32(output, ctx.fds.open(guestPath(pointer, length), options));
      return 0;
    } catch (error) {
      return errorNumber(error);
    }
  }
  function mkdirs(directory) {
    let current = '';
    for (const part of directory.split('/').filter(Boolean)) {
      current = `${current}/${part}`;
      if (ctx.fs.exists(current)) continue;
      try {
        ctx.fs.mkdir(current);
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
      }
    }
  }
  function components(directory, template) {
    const prefix = template.endsWith('/') ? template : `${template}/`;
    if (!directory.startsWith(prefix) || directory.length === prefix.length) {
      throw fail('EINVAL', 'Permission target is not below its template');
    }
    const parts = directory.slice(prefix.length).split('/').filter(Boolean);
    if (parts.some((part) => part === '.' || part === '..'))
      throw fail('EINVAL', 'Permission target is not below its template');
    return parts;
  }
  return {
    create_new(pointer, length, mode, output) {
      if (mode < 0 || mode > 0o7777) return errno.EINVAL;
      return open(pointer, length, output, {
        read: true,
        write: true,
        create: true,
        exclusive: true,
        mode,
        nofollow: true,
      });
    },
    open_nofollow(pointer, length, output) {
      return open(pointer, length, output, { read: true, nofollow: true });
    },
    open_lock(pointer, length, output) {
      return open(pointer, length, output, { read: true, write: true, nofollow: true });
    },
    open_directory_nofollow_beneath(pointer, length, templatePointer, templateLength, output) {
      try {
        const directory = guestPath(pointer, length);
        let current = guestPath(templatePointer, templateLength).replace(/\/+$/, '');
        for (const part of components(directory, current)) {
          current = `${current}/${part}`;
          const kind = kindOf(ctx.fs.lstat(current));
          if (kind === 'symlink') return errno.ELOOP;
          if (kind !== 'dir') return errno.ENOTDIR;
        }
        setU32(output, ctx.fds.open(directory, { read: true, directory: true, nofollow: true }));
        return 0;
      } catch (error) {
        return errorNumber(error);
      }
    },
    grant_directory_mode_beneath() {
      return errno.ENOTSUP;
    },
    try_lock(descriptor, exclusive) {
      try {
        return ctx.fds.tryLock(descriptor, exclusive !== 0);
      } catch (error) {
        return errorNumber(error);
      }
    },
    sqlite_register: checked(() => {}),
    path_access_executable: checked((pointer, length) => {
      const file = guestPath(pointer, length);
      if ((ctx.fs.stat(file).mode & 0o111) === 0)
        throw fail('EACCES', `File is not executable: ${file}`);
    }),
    check_owner: checked((descriptor) => {
      if ((ctx.fds.fstat(descriptor).uid ?? uid) !== uid)
        throw fail('EACCES', 'WASM SQLite stores must belong to the current user');
    }),
    fchmod: checked((descriptor, mode) => ctx.fds.fchmod(descriptor, mode & 0o7777)),
    fmode: checked((descriptor, output) => setU32(output, withType(ctx.fds.fstat(descriptor)))),
    lmode: checked((pointer, length, output) =>
      setU32(output, withType(ctx.fs.lstat(guestPath(pointer, length))))
    ),
    umask: () => UMASK,
    uid: () => uid,
    secure_directory: checked((pointer, length) => {
      const directory = guestPath(pointer, length);
      mkdirs(directory);
      const stat = ctx.fs.lstat(directory);
      if (kindOf(stat) !== 'dir')
        throw fail('ENOTDIR', `Lock directory is not a directory: ${directory}`);
      if ((stat.uid ?? uid) !== uid) throw fail('EACCES', 'Lock directory has a different owner');
      ctx.fs.chmod(directory, 0o700);
    }),
  };
}

export const GIT_UNSUPPORTED =
  'git dependencies need a CORS-free network transport (slicc-node, the SLICC extension or app); this page only has fetch';
export const TLS_MISSING =
  'git over https needs @ai-ecoverse/wasm-tls-engine installed next to @ai-ecoverse/wasi-pnpm';
export const CA_MISSING =
  'kernel not prepared: no CA file for git over https (the embedder must run prepare())';
export const SH_MISSING = 'package scripts need /bin/sh: install @ai-ecoverse/wasm-bash';
export const GIT_MISSING =
  'git dependencies need git: install @ai-ecoverse/wasm-git so that git is on the kernel command path (its /node_modules)';
const FD_HANDLE = 0x10000000;
const PROC_HANDLE = 0x20000000;
const SIGNALS = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 };
const CHILD_ENV = {
  PNPM_SLICC_HTTP_PROXY: ['http_proxy', 'HTTP_PROXY'],
  PNPM_SLICC_HTTPS_PROXY: ['https_proxy', 'HTTPS_PROXY'],
  PNPM_SLICC_NO_PROXY: ['no_proxy', 'NO_PROXY'],
  PNPM_SLICC_SSL_CERT_FILE: ['SSL_CERT_FILE', 'GIT_SSL_CAINFO'],
};
export const PUBLISH_UNSUPPORTED =
  'publishing needs a CORS-free network transport (slicc-node, the SLICC extension or app); this page only has fetch';
export const PUBLISH_TOO_LARGE =
  'the publish request body exceeds 64 MiB, the limit for pnpm in slicc-kernel';
export const MAX_UPLOAD = 64 * 1024 * 1024;
const PROMPT_UNSUPPORTED =
  'Interactive prompts are not supported in slicc; for an npm one-time password re-run with --otp <code>';
const SCRIPTS_UNSUPPORTED =
  'Lifecycle scripts cannot run in slicc yet; install with --ignore-scripts';
const WRITE_METHODS = new Set(['PUT', 'DELETE', 'PATCH']);
const SYNTHETIC = 0x40000000;
const SYNTHETIC_DIR = '/tmp/.wasi-pnpm';

const UNSUPPORTED = {
  'process.spawn': SCRIPTS_UNSUPPORTED,
  'shell.spawn': SCRIPTS_UNSUPPORTED,
  'terminal.open': PROMPT_UNSUPPORTED,
  'terminal.prompt': PROMPT_UNSUPPORTED,
  'terminal.confirm': PROMPT_UNSUPPORTED,
  'terminal.input': PROMPT_UNSUPPORTED,
  'terminal.password': PROMPT_UNSUPPORTED,
};

export function headerPairs(headers) {
  if (headers == null) return [];
  const pairs = Array.isArray(headers) ? headers : Object.entries(headers);
  return pairs.map(([name, value]) => [String(name), String(value)]);
}

export function responseHeaders(head) {
  const pairs = headerPairs(head.headers);
  if (head.decoded === false) return pairs;
  const encoding = pairs.find(([name]) => name.toLowerCase() === 'content-encoding')?.[1];
  const decoded = encoding
    ?.split(',')
    .every((value) => ['gzip', 'deflate', 'br'].includes(value.trim().toLowerCase()));
  if (!decoded) return pairs;
  return pairs.filter(
    ([name]) => !['content-encoding', 'content-length'].includes(name.toLowerCase())
  );
}

export function fromTaken(taken) {
  if (taken === undefined) return undefined;
  if (typeof taken.error === 'string')
    return { ok: false, error: { message: taken.error, code: taken.error } };
  return envelope(taken.value);
}

export function envelope(result) {
  if (
    result instanceof Error ||
    (result &&
      typeof result === 'object' &&
      Number.isInteger(result.errno) &&
      !('status' in result))
  ) {
    return {
      ok: false,
      error: { message: result.message ?? `errno ${result.errno}`, code: result.code ?? null },
    };
  }
  if (result && typeof result === 'object' && typeof result.ok === 'boolean') return result;
  if (Array.isArray(result) && result.length === 2 && result.every(Number.isInteger)) {
    return { ok: true, value: result[0] === 0 ? null : waitStatus(result[1]) };
  }
  if (result instanceof Uint8Array)
    return { ok: true, value: { bytes: Array.from(result), done: result.length === 0 } };
  if (result && typeof result === 'object' && 'status' in result && 'handle' in result) {
    return {
      ok: true,
      value: {
        handle: result.handle,
        status: result.status,
        headers: responseHeaders(result),
        url: result.url,
      },
    };
  }
  return { ok: true, value: result ?? null };
}

function errorEnvelope(message, code = 'ENOTSUP') {
  return { ok: false, error: { message, code } };
}

export function programName(request) {
  return String(request.program ?? '')
    .split('/')
    .pop();
}

const NETWORK_REMOTE = /^(?!file:)[a-z][a-z0-9+.-]*:\/\/|^[^/@:\s]+@[^/:\s]+:/i;

export function networkRemote(request) {
  return (request.args ?? []).some((arg) => NETWORK_REMOTE.test(String(arg)));
}

export function spawnMessage(request) {
  const program = programName(request);
  return program === 'git' || program === 'ssh' ? GIT_UNSUPPORTED : SCRIPTS_UNSUPPORTED;
}

export function childEnv(requested, own) {
  const env = Array.isArray(requested) ? Object.fromEntries(requested) : { ...(requested ?? {}) };
  for (const [source, targets] of Object.entries(CHILD_ENV)) {
    if (typeof own?.[source] === 'string' && own[source] !== '')
      for (const target of targets) env[target] = own[source];
  }
  for (const key of Object.keys(env)) if (key.startsWith('PNPM_SLICC_')) delete env[key];
  return env;
}

export function waitStatus(status) {
  const signalNumber = status & 0x7f;
  if (signalNumber === 0) return { code: (status >> 8) & 0xff, signal: null, signalNumber: null };
  const signal =
    Object.keys(SIGNALS).find((name) => SIGNALS[name] === signalNumber) ?? `SIG${signalNumber}`;
  return { code: null, signal, signalNumber };
}

function fdHandle(fd) {
  return fd == null ? null : FD_HANDLE + fd;
}

export function isFdHandle(handle) {
  return Number.isInteger(handle) && handle >= FD_HANDLE && handle < PROC_HANDLE;
}

export function isProcHandle(handle) {
  return Number.isInteger(handle) && handle >= PROC_HANDLE && handle < SYNTHETIC;
}

function procHandle(pid, stdin) {
  return PROC_HANDLE + pid * 1024 + (stdin == null ? 0 : stdin + 1);
}

function procOf(handle) {
  const rest = handle - PROC_HANDLE;
  const stdin = (rest % 1024) - 1;
  return { pid: Math.floor(rest / 1024), stdin: stdin < 0 ? null : stdin };
}

export function isSynthetic(handle) {
  return Number.isInteger(handle) && handle >= SYNTHETIC;
}

function createHost(ctx) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const encoder = new TextEncoder();
  const ready = new Map();

  const encoderBody = new TextEncoder();

  function syntheticPath(handle) {
    return `${SYNTHETIC_DIR}/${handle}`;
  }

  function allocate() {
    try {
      ctx.fs.mkdir(SYNTHETIC_DIR);
    } catch {}
    return SYNTHETIC + 1 + Math.floor(Math.random() * 0x3ffffffe);
  }

  function syntheticResponse(url, status, message) {
    const handle = allocate();
    ctx.fs.writeFile(syntheticPath(handle), encoderBody.encode(JSON.stringify({ error: message })));
    return ctx.async.resolve({
      ok: true,
      value: { handle, status, headers: [['content-type', 'application/json']], url },
    });
  }

  let crossOrigin;
  function corsOnly() {
    if (crossOrigin === undefined) {
      try {
        crossOrigin = ctx.syscall({ op: 'net-traits' })?.crossOrigin ?? 'unknown';
      } catch {
        crossOrigin = 'unknown';
      }
    }
    return crossOrigin === 'cors';
  }

  function uploadDir(handle) {
    return `${SYNTHETIC_DIR}/upload-${handle}`;
  }

  function uploadChunks(handle) {
    const dir = uploadDir(handle);
    return ctx.fs
      .readdir(dir)
      .map(Number)
      .filter(Number.isInteger)
      .sort((a, b) => a - b)
      .map((index) => `${dir}/${index}`);
  }

  function uploadCreate() {
    const handle = allocate();
    ctx.fs.mkdir(uploadDir(handle));
    return ctx.async.resolve({ ok: true, value: { handle } });
  }

  function uploadWrite(request) {
    const bytes = Array.isArray(request.bytes) ? Uint8Array.from(request.bytes) : request.bytes;
    if (!(bytes instanceof Uint8Array))
      return ctx.async.resolve(errorEnvelope('HTTP upload chunks must be bytes', 'EINVAL'));
    const chunks = uploadChunks(request.handle);
    const size = chunks.reduce((total, path) => total + ctx.fs.stat(path).size, 0);
    if (size + bytes.length > MAX_UPLOAD)
      return ctx.async.resolve(errorEnvelope(PUBLISH_TOO_LARGE, 'EFBIG'));
    ctx.fs.writeFile(`${uploadDir(request.handle)}/${chunks.length}`, bytes);
    return ctx.async.resolve({ ok: true, value: null });
  }

  function uploadBody(handle) {
    const parts = uploadChunks(handle).map((path) => ctx.fs.readFile(path));
    const body = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
    let at = 0;
    for (const part of parts) {
      body.set(part, at);
      at += part.length;
    }
    return body;
  }

  function uploadRemove(handle) {
    try {
      for (const path of uploadChunks(handle)) ctx.fs.unlink(path);
      ctx.fs.rmdir(uploadDir(handle));
    } catch {}
  }

  function sendNow(url, method, headers, body) {
    if (body && body.length > MAX_UPLOAD) return syntheticHead(url.href, 413, PUBLISH_TOO_LARGE);
    try {
      return envelope(ctx.syscall({ op: 'net-request', url: url.href, method, headers, body }));
    } catch (error) {
      const code = typeof error?.code === 'string' ? error.code : 'EIO';
      const reach = `could not reach ${url.host} (${code})`;
      return syntheticHead(
        url.href,
        502,
        crossOrigin === 'any' ? reach : `${reach}; on a plain page, ${PUBLISH_UNSUPPORTED}`
      );
    }
  }

  function syntheticHead(url, status, message) {
    const handle = allocate();
    ctx.fs.writeFile(syntheticPath(handle), encoderBody.encode(JSON.stringify({ error: message })));
    return {
      ok: true,
      value: { handle, status, headers: [['content-type', 'application/json']], url },
    };
  }

  function exports() {
    return ctx.instance()?.exports ?? {};
  }

  function deferUpload(url, request) {
    const id = ctx.async.hold();
    const bytes = encoderBody.encode(
      JSON.stringify({
        id,
        url: url.href,
        method: String(request.method ?? 'GET').toUpperCase(),
        headers: headerPairs(request.headers),
      })
    );
    const pointer = exports().malloc(bytes.length) >>> 0;
    if (!pointer)
      return ctx.async.resolve(
        errorEnvelope('out of memory staging the publish request', 'ENOMEM')
      );
    new Uint8Array(ctx.memory().buffer, pointer, bytes.length).set(bytes);
    ctx.fs.writeFile(
      `${uploadDir(request.bodyHandle)}/request`,
      encoderBody.encode(`${pointer} ${bytes.length}`)
    );
    return id;
  }

  function sendDeferred(handle) {
    const marker = `${uploadDir(handle)}/request`;
    let staged;
    try {
      staged = new TextDecoder().decode(ctx.fs.readFile(marker));
    } catch {
      return;
    }
    const [pointer, length] = staged.split(' ').map(Number);
    const view = new Uint8Array(ctx.memory().buffer, pointer, length);
    const request = JSON.parse(new TextDecoder().decode(Uint8Array.from(view)));
    view.fill(0);
    exports().free(pointer);
    ctx.fs.unlink(marker);
    const body = uploadBody(handle);
    uploadRemove(handle);
    const result = sendNow(new URL(request.url), request.method, request.headers, body);
    ctx.fs.writeFile(resultPath(request.id), encoderBody.encode(JSON.stringify(result)));
  }

  function resultPath(id) {
    return `${SYNTHETIC_DIR}/result-${id}`;
  }

  function deferredResult(id) {
    try {
      const bytes = ctx.fs.readFile(resultPath(id));
      ctx.fs.unlink(resultPath(id));
      return bytes;
    } catch {
      return undefined;
    }
  }

  function httpsProblem(request) {
    if (!(request.args ?? []).some((arg) => String(arg).startsWith('https://'))) return undefined;
    if (!ctx.fs.exists('/usr/bin/git')) return GIT_MISSING;
    const own = ctx.env ?? {};
    if (typeof own.PNPM_SLICC_PACKAGE === 'string' && own.PNPM_SLICC_PACKAGE !== '') {
      const scope = own.PNPM_SLICC_PACKAGE.replace(/\/+$/, '').split('/').slice(0, -1).join('/');
      if (!ctx.fs.exists(`${scope}/wasm-tls-engine/package.json`)) return TLS_MISSING;
    }
    const ca = own.PNPM_SLICC_SSL_CERT_FILE;
    if (typeof ca !== 'string' || ca === '' || !ctx.fs.exists(ca)) return CA_MISSING;
    return undefined;
  }

  function spawnGit(request) {
    if (corsOnly() && networkRemote(request))
      return ctx.async.resolve(errorEnvelope(GIT_UNSUPPORTED));
    const problem = httpsProblem(request);
    if (problem) return ctx.async.resolve(errorEnvelope(problem));
    const stdio = (name) =>
      request[name] === 'ignore' || request[name] === 'null'
        ? 'null'
        : request[name] === 'inherit'
          ? 'inherit'
          : 'pipe';
    let child;
    try {
      child = ctx.spawn({
        argv: ['git', ...(request.args ?? []).map(String)],
        env: childEnv(request.env, ctx.env),
        cwd: request.cwd ?? ctx.cwd(),
        stdin: stdio('stdin'),
        stdout: stdio('stdout'),
        stderr: stdio('stderr'),
      });
    } catch (error) {
      return ctx.async.resolve(
        errorEnvelope(
          error?.code === 'ENOENT'
            ? GIT_MISSING
            : `git could not start: ${error?.code ?? error?.message ?? 'EIO'}`,
          error?.code === 'ENOENT' ? 'ENOTSUP' : (error?.code ?? 'EIO')
        )
      );
    }
    return ctx.async.resolve({
      ok: true,
      value: {
        handle: procHandle(child.pid, child.stdin),
        pid: child.pid,
        stdout: fdHandle(child.stdout),
        stderr: fdHandle(child.stderr),
      },
    });
  }

  function spawnSh(request, argv) {
    const stdio = (name) =>
      request[name] === 'ignore' || request[name] === 'null'
        ? 'null'
        : request[name] === 'inherit'
          ? 'inherit'
          : 'pipe';
    let child;
    try {
      child = ctx.spawn({
        argv,
        env: childEnv(request.env, ctx.env),
        cwd: request.cwd ?? ctx.cwd(),
        stdin: stdio('stdin'),
        stdout: stdio('stdout'),
        stderr: stdio('stderr'),
      });
    } catch (error) {
      return ctx.async.resolve(
        errorEnvelope(
          error?.code === 'ENOENT'
            ? SH_MISSING
            : `the script could not start: ${error?.code ?? error?.message ?? 'EIO'}`,
          error?.code === 'ENOENT' ? 'ENOTSUP' : (error?.code ?? 'EIO')
        )
      );
    }
    return ctx.async.resolve({
      ok: true,
      value: {
        handle: procHandle(child.pid, child.stdin),
        pid: child.pid,
        stdout: fdHandle(child.stdout),
        stderr: fdHandle(child.stderr),
      },
    });
  }

  function processOp(request) {
    const { pid, stdin } = procOf(request.handle);
    switch (request.operation) {
      case 'process.write':
        if (stdin == null)
          return ctx.async.resolve(errorEnvelope('Process stdin is not piped', 'EINVAL'));
        return ctx.async.submit({
          op: 'fd-write',
          fd: stdin,
          body: Array.isArray(request.bytes) ? Uint8Array.from(request.bytes) : request.bytes,
        });
      case 'process.end':
      case 'process.closeStdin':
      case 'process.endDetached':
        if (stdin == null) return ctx.async.resolve({ ok: true, value: null });
        return ctx.async.submit({ op: 'fd-close', fd: stdin });
      case 'process.wait':
        return ctx.async.submit({ op: 'proc-wait', pid, nohang: false });
      case 'process.tryWait':
        return ctx.async.submit({ op: 'proc-wait', pid, nohang: true });
      case 'process.kill':
        try {
          ctx.kill(pid, SIGNALS[request.signal ?? 'SIGTERM'] ?? SIGNALS.SIGTERM);
        } catch {}
        return ctx.async.resolve({ ok: true, value: null });
      default:
        return ctx.async.resolve({ ok: true, value: null });
    }
  }

  function closeChild(handle) {
    try {
      if (isFdHandle(handle)) ctx.syscall({ op: 'fd-close', fd: handle - FD_HANDLE });
      else ctx.kill(procOf(handle).pid, SIGNALS.SIGKILL);
    } catch {}
  }

  function publishRequest(url, request) {
    if (corsOnly()) return syntheticResponse(url.href, 405, PUBLISH_UNSUPPORTED);
    if (request.bodyHandle != null) return deferUpload(url, request);
    const body = Array.isArray(request.body)
      ? Uint8Array.from(request.body)
      : (request.body ?? undefined);
    return ctx.async.resolve(
      sendNow(
        url,
        String(request.method ?? 'GET').toUpperCase(),
        headerPairs(request.headers),
        body
      )
    );
  }

  function syntheticRead(handle) {
    const path = syntheticPath(handle);
    let bytes = new Uint8Array();
    try {
      bytes = ctx.fs.readFile(path);
      ctx.fs.unlink(path);
    } catch {}
    return { ok: true, value: { bytes: Array.from(bytes), done: bytes.length === 0 } };
  }

  function syntheticClose(handle) {
    try {
      ctx.fs.unlink(syntheticPath(handle));
    } catch {}
  }

  function networkRequest(request) {
    let url;
    try {
      url = new URL(request.url);
    } catch {
      return ctx.async.resolve(errorEnvelope('Invalid HTTP request URL', 'EINVAL'));
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return ctx.async.resolve(
        errorEnvelope(`Unsupported HTTP protocol: ${url.protocol}`, 'EINVAL')
      );
    }
    if (
      request.bodyHandle != null ||
      WRITE_METHODS.has(String(request.method ?? 'GET').toUpperCase())
    )
      return publishRequest(url, request);
    return ctx.async.submit({
      op: 'net-request',
      url: url.href,
      method: request.method ?? 'GET',
      headers: headerPairs(request.headers),
      body: Array.isArray(request.body)
        ? Uint8Array.from(request.body)
        : (request.body ?? undefined),
      timeoutMs: request.timeoutMs,
      totalTimeoutMs: request.totalTimeoutMs,
    });
  }

  function start(request) {
    switch (request.operation) {
      case 'network.request':
        return networkRequest(request);
      case 'stream.read':
        if (isSynthetic(request.handle)) return ctx.async.resolve(syntheticRead(request.handle));
        if (isFdHandle(request.handle))
          return ctx.async.submit({
            op: 'fd-read',
            fd: request.handle - FD_HANDLE,
            max: Math.min(request.maxBytes ?? 65536, 65536),
          });
        return ctx.async.submit({
          op: 'net-read',
          handle: request.handle,
          max: Math.min(request.maxBytes ?? 65536, 65536),
        });
      case 'resource.close':
        if (isFdHandle(request.handle) || isProcHandle(request.handle)) {
          closeChild(request.handle);
          return ctx.async.resolve({ ok: true, value: null });
        }
        if (isSynthetic(request.handle)) {
          syntheticClose(request.handle);
          uploadRemove(request.handle);
          return ctx.async.resolve({ ok: true, value: null });
        }
        return ctx.async.submit({ op: 'net-close', handle: request.handle });
      case 'upload.create':
        return uploadCreate();
      case 'upload.write':
        return uploadWrite(request);
      case 'upload.end':
        try {
          sendDeferred(request.handle);
        } catch {
          return ctx.async.resolve(errorEnvelope('the publish request could not be sent', 'EIO'));
        }
        return ctx.async.resolve({ ok: true, value: null });
      case 'process.spawn':
      case 'shell.spawn':
        if (request.operation === 'process.spawn' && programName(request) === 'git')
          return spawnGit(request);
        if (request.operation === 'process.spawn' && programName(request) === 'sh')
          return spawnSh(request, ['sh', ...(request.args ?? []).map(String)]);
        if (request.operation === 'shell.spawn' && typeof request.script === 'string')
          return spawnSh(request, [
            'sh',
            '-c',
            request.script,
            'sh',
            ...(request.args ?? []).map(String),
          ]);
        return ctx.async.resolve(errorEnvelope(spawnMessage(request)));
      case 'process.write':
      case 'process.end':
      case 'process.closeStdin':
      case 'process.endDetached':
      case 'process.wait':
      case 'process.tryWait':
      case 'process.kill':
      case 'process.release':
        return processOp(request);
      case 'signal.next':
        return ctx.async.hold();
      case 'terminal.status':
        return ctx.async.resolve({
          ok: true,
          value: { stdin: false, stdout: false, stderr: false },
        });
      default:
        return ctx.async.resolve(
          errorEnvelope(
            UNSUPPORTED[request.operation] ?? `Unknown WASM host operation: ${request.operation}`
          )
        );
    }
  }

  function take(id) {
    let response;
    try {
      response = fromTaken(ctx.async.take(id));
    } catch (error) {
      response = envelope(error);
    }
    if (response === undefined) return undefined;
    let bytes = encoder.encode(JSON.stringify(response));
    if (bytes.length > MAX_RESPONSE)
      bytes = encoder.encode(
        JSON.stringify(errorEnvelope('WASM host response exceeds the transfer limit', 'EIO'))
      );
    return bytes;
  }

  function closeUnread(bytes) {
    const response = JSON.parse(decoder.decode(bytes));
    if (
      response.ok &&
      (isFdHandle(response.value?.handle) || isProcHandle(response.value?.handle))
    ) {
      for (const handle of [response.value.stdout, response.value.stderr, response.value.handle])
        if (handle != null) closeChild(handle);
    } else if (response.ok && isSynthetic(response.value?.handle))
      syntheticClose(response.value.handle);
    else if (response.ok && Number.isInteger(response.value?.handle)) {
      try {
        ctx.syscall({ op: 'net-close', handle: response.value.handle });
      } catch {}
    }
  }

  return {
    operation_start(pointer, length) {
      if (length >>> 0 > MAX_RESPONSE) return -2;
      try {
        const request = JSON.parse(
          decoder.decode(
            Uint8Array.from(new Uint8Array(ctx.memory().buffer, pointer >>> 0, length >>> 0))
          )
        );
        return start(request);
      } catch {
        return -2;
      }
    },
    response_len(id) {
      if (!ready.has(id)) {
        const bytes = take(id) ?? deferredResult(id);
        if (bytes === undefined) return -1;
        ready.set(id, bytes);
      }
      return ready.get(id).length;
    },
    response_read(id, pointer, length) {
      const bytes = ready.get(id);
      if (!bytes || bytes.length > length >>> 0) return -2;
      ready.delete(id);
      new Uint8Array(ctx.memory().buffer, pointer >>> 0, bytes.length).set(bytes);
      return bytes.length;
    },
    operation_cancel(id) {
      const late = deferredResult(id);
      if (late) ready.set(id, late);
      const unread = ready.get(id);
      ready.delete(id);
      if (unread) closeUnread(unread);
      ctx.async.cancel(id);
    },
    resource_close(handle) {
      if (isFdHandle(handle) || isProcHandle(handle)) {
        closeChild(handle);
        return 0;
      }
      if (isSynthetic(handle)) {
        syntheticClose(handle);
        uploadRemove(handle);
        return 0;
      }
      try {
        ctx.syscall({ op: 'net-close', handle });
        return 0;
      } catch {
        return -1;
      }
    },
    wait_completion() {
      return ctx.async.wait();
    },
  };
}
