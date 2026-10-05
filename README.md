# slicc-kernel

SLICC's wasm-realm kernel as a standalone package. It runs Emscripten programs built for SLICC in the browser, directly against the Origin Private File System, with `fork`, `spawn`, pipes, `waitpid`, signals and job control. The first target is GNU bash from [`@ai-ecoverse/wasm-bash`](https://www.npmjs.com/package/@ai-ecoverse/wasm-bash); anything else that follows the SLICC toolchain conventions (for example [`@ai-ecoverse/wasm-coreutils`](https://www.npmjs.com/package/@ai-ecoverse/wasm-coreutils)) runs too.

```js
import { createKernel } from './node_modules/@ai-ecoverse/slicc-kernel/dist/index.js';

const kernel = await createKernel({ root: await navigator.storage.getDirectory() });
const { status, stdout, stderr } = await kernel.run(['bash', '-c', 'echo hi > hello.txt; cat hello.txt'], {
  cwd: '/os',
});
```

## Requirements

- **The page must be cross-origin isolated**: serve it with `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` (or `credentialless`). Processes block on `Atomics.wait` over a `SharedArrayBuffer`, which only exists in isolated contexts. `createKernel` throws if `crossOriginIsolated` is false.
- **The kernel lives in a dedicated worker owned by the page.** A `SharedWorker` is never cross-origin isolated in Chromium (and has no `Worker` constructor), so it cannot host the kernel. `createKernel` starts `dist/kernel-worker.js`; that worker owns OPFS and starts one nested dedicated worker (`dist/process-worker.js`) per process.
- The page's CSP must allow `eval`: each process evaluates its program's Emscripten glue with `new Function`.

`dist/` is plain ESM with no bare imports, and the workers are referenced with `new URL('./….js', import.meta.url)`, so the files work when served as-is (for example from OPFS through a service worker). Whatever serves them must send the COOP/COEP headers on the page and a compatible `Cross-Origin-Resource-Policy` on the scripts.

## API

### `createKernel(options?) → Promise<Kernel>`

| option | default | |
| --- | --- | --- |
| `root` | `navigator.storage.getDirectory()` | the `FileSystemDirectoryHandle` that becomes `/` |
| `modules` | `'/node_modules'` | where installed packages are scanned for commands |
| `env` | `{}` | environment added to every run |
| `metadata` | `'slicc-kernel'` | the IndexedDB database for POSIX metadata (see [Metadata](#metadata)); `false` keeps it in memory for the kernel's lifetime |
| `worker` | `new URL('./kernel-worker.js', import.meta.url)` | the kernel worker script |
| `network` | none | `{ transport }`: how programs reach the outside world (see [Network](#network)) |

### `kernel.run(argv, options?) → Promise<{ status, stdout, stderr }>`

Runs `argv[0]` with `argv` as its arguments and resolves when it exits. `stdout` and `stderr` are decoded as UTF-8; `status` is the exit status, `128 + n` for a process killed by signal `n`, and `127` when `argv[0]` cannot be found.

| option | |
| --- | --- |
| `cwd` | working directory, default `/`; created in OPFS if missing |
| `env` | extra environment; the defaults are `PATH=/usr/bin:/bin`, `HOME=/home`, `PWD=<cwd>` |
| `stdin` | a string or `Uint8Array`; without it stdin is `/dev/null` |
| `onStdout`, `onStderr` | called with each chunk of text as it is written |

### `kernel.openTerminal(argv, options?) → Promise<Terminal>`

Starts `argv` as the session leader on a new terminal and resolves once it is running, or rejects if `argv[0]` cannot be found. Its stdin, stdout and stderr are the terminal, which has a line discipline with echo, canonical mode and `ISIG`, and supports job control, so `kernel.openTerminal(['bash', '-i'])` gives an interactive shell. The API was designed with [slicc-spectrum](https://github.com/ai-ecoverse/slicc-spectrum), a terminal web component, and these names are kept stable.

| option | |
| --- | --- |
| `cwd`, `env` | as for `run`; `TERM=xterm-256color` and `COLORTERM=truecolor` are added |
| `cols`, `rows` | initial size, default 80 × 24, so `$COLUMNS` and `$LINES` are right before the first prompt |
| `onData` | called with each chunk of output as raw bytes (escape sequences included) |

| `Terminal` | |
| --- | --- |
| `pid` | the session leader's pid |
| `onData` | the output listener; output that arrives while it is `null` is kept and delivered when one is set |
| `write(data)` | types a string or bytes into the terminal; with `ISIG` on, `^C`, `^Z` and `^\` signal the foreground process group |
| `resize(cols, rows)` | sets the window size (`TIOCGWINSZ`) and sends `SIGWINCH` to the foreground process group |
| `signal(name)` | sends a signal (`'SIGINT'`, `'SIGTSTP'`, `'SIGQUIT'`, `'SIGHUP'`, …) to the foreground process group, regardless of termios |
| `exited` | resolves with the session leader's exit status (`128 + n` if killed by signal `n`) |
| `close()` | hangs up: `SIGHUP` to the foreground process group, and reads from the terminal return end-of-file |

### `kernel.terminate()`

Stops the kernel worker and every process. Pending and later calls reject.

### Headless in Node, for tests

`@ai-ecoverse/slicc-kernel/node` runs the same kernel in Node without a browser, so packages built for SLICC can test against it. It is a testing entry, not a supported runtime: there is no OPFS and no isolation, and nothing beyond what its tests use is promised.

```js
import { createNodeKernel, nodeTransport } from '@ai-ecoverse/slicc-kernel/node';

const kernel = await createNodeKernel({ network: { transport: nodeTransport() } });
await kernel.writeFile('/node_modules/@ai-ecoverse/wasm-bash/package.json', manifest);
const { status, stdout } = await kernel.run(['bash', '-c', 'echo hi'], { cwd: '/home' });
kernel.terminate();
```

`createNodeKernel({ root, modules, env, network, worker })` takes the options of `createKernel` except `metadata`. `root` is an in-memory directory by default (`memoryRoot()` makes another), and POSIX metadata stays in memory. Processes and threads run on `worker_threads`. The kernel has `run`, `openTerminal` and `terminate` as above, plus `root`, `writeFile(path, data)` (creating the parent directories) and `readFile(path)` to put files in place and read results. `nodeTransport()` is `fetchTransport()` with Node's `fetch`, which no CORS binds (`crossOrigin: 'any'`).

## Commands

Commands come from installed packages in npm's `node_modules` layout: every `<modules>/<name>/package.json` and `<modules>/@scope/<name>/package.json` with a `slicc.commands` block. An Emscripten program names its glue and module, for example bash's:

```json
{ "slicc": { "abi": "emscripten", "commands": { "bash": { "glue": "bin/bash", "wasm": "bin/bash.wasm" } } } }
```

A WASI preview1 or WASIX program (Zig, Rust, Go, wasi-libc or wasix-libc C) has no glue: `"abi": "wasi"`, on `slicc` or per command (which wins), and the command names only its module. A command can also be a `#!` script of the package, which its interpreter runs as execve(2) would:

```json
{ "slicc": { "abi": "wasi", "commands": { "rg": { "wasm": "bin/rg.wasm" }, "rustc": { "script": "bin/rustc" } } } }
```

Entries may also set `argv0`, `args` and `env`, and a package can set `slicc.env` for all of its commands. In `env`, `${package}` is the package directory, `${cwd}` the process's working directory, and `${NAME}` the caller's `NAME` when the program starts (a default naming an unset variable is left out); a relative path that exists in the package (`lib/python3.14`, `./`) becomes that absolute path. The caller's environment wins over these defaults; a `null` value removes the variable for the command, after the caller's environment is applied (a host-networked program can drop the kernel's proxy settings that way), and a command entry can set a variable its package's `slicc.env` removes. The first package to define a name wins. `sh` runs bash as `sh` unless a package provides its own. The installed commands appear as executables in a virtual `/usr/bin` and `/bin`, so `PATH` lookups, `command -v` and `ls /usr/bin` work without writing anything to OPFS. A process can also run a program by the path of its glue when the `.wasm` sits next to it, a wasm module by its own path (as a WASI program), and a script through its `#!` line (including `#!/usr/bin/env name`). Executing any other file fails with `ENOEXEC`, so bash runs it as a shell script, as POSIX shells do. The catalog is re-read at the start of every `run`, so packages installed in between are picked up.

### WASI programs

A WASI program runs in a process worker of its own like an Emscripten one, against the same kernel: its descriptors, pipes, terminals and job control are the kernel's, and its files are OPFS. Preopens are `.` (the cwd), `/dev` and every top-level directory, plus the virtual `/usr` and `/bin`. On top of preview1 it gets:

- **Threads**: `wasi.thread-spawn` (wasm32-wasip1-threads) and WASIX `thread_spawn_v2` start a worker per thread on the process's shared memory, sized from the module's own import (a 2 GiB maximum when the engine cannot reserve more). The threads share one descriptor table; `exit` or a trap in any thread ends the process. At most 64 threads per process; `SLICC_WASM_THREADS` sets another cap, up to 256.
- **WASIX** (a module importing `wasix_32v1`): fork and setjmp/longjmp through Asyncify (the module is built with `wasm-opt --asyncify`), exec, `posix_spawn`, `waitpid`, pipes, `dup2`, signal handlers and interval timers, terminal modes, and dynamic linking: a position-independent main module loads side modules with `dlopen` from `LD_LIBRARY_PATH`, its runtime path, `/lib`, `/usr/lib` and `/usr/local/lib`.
- **Sockets**: the WASIX socket calls (`sock_open`, `bind`, `listen`, `connect`, `accept`, options, local and peer names) are the kernel's loopback sockets, and preview1's `sock_recv` / `sock_send` / `sock_shutdown` work on them and on inherited ones. HTTP and HTTPS leave through the realm proxy that `https_proxy` names, as for any other program; `resolve` answers loopback names and literal addresses.
- **Diagnostics**: a trap ends the program with 134 and its message on stderr; with `SLICC_WASM_BACKTRACE=1` the wasm frames follow, named from the module's name section, or from a sidecar for a module shipped without one (`<module>.names` beside it, or the same path in a `<package>-names` package). `SLICC_WASI_STATS=1` makes a program print its calls, counted and timed, as it ends.

### Program imports

A WASI command can name an ES module of its package that provides imports of its own, for host functions a program needs beyond WASI (`"imports": "host/pnpm-host.mjs"`). Each worker of the process (the process and every thread) loads it, with the same trust as Emscripten glue, and calls its `createImports(ctx)`, which returns import namespaces (`{ pnpm_host: { … } }`). It may not define `wasi_snapshot_preview1`, `wasix_32v1`, `wasi` or `env`; any other namespace the module imports is then accepted, and functions it does not provide answer `ENOSYS`. `ctx` has:

- `memory()`, `instance()` (after instantiation), `tid` (1 for the main thread), `argv`, `env`, `cwd()`;
- `fs`: the synchronous filesystem the WASI calls use (absolute paths);
- `fds`: `open(path, { read, write, append, create, exclusive, truncate, directory, nofollow, mode })` returns a WASI descriptor of the program; `close`, `fstat` (`{ kind, path, mode, uid, gid, size, ino, mtimeMs }`), `fchmod`, and `tryLock(fd, exclusive)` / `unlock(fd)`: advisory locks held by the kernel across processes and threads, keyed by path, released on unlock, on closing the descriptor and at exit (`tryLock` returns 0, or 6 when another process holds the lock);
- `syscall(req)`: a kernel syscall, synchronously;
- `spawn({ argv, env, cwd, stdin, stdout, stderr })` starts a command (resolved like `kernel.run`) as a child and returns `{ pid, stdin, stdout, stderr }`. `env` is the child's whole environment (the program's own by default), `cwd` the program's by default. Each stdio is `'inherit'` (the default: the program's own), `'null'`, or `'pipe'`: a kernel pipe whose end the result holds as a descriptor, read and written with `fd-read` (`{ op: 'fd-read', fd, max }`, an empty read at the end), `fd-write` (`{ op: 'fd-write', fd, body }`) and `fd-close`, through `syscall` or `async.submit`; the child's ends are closed in the program. A command that does not exist throws `ENOENT`;
- `wait(pid)` blocks until a child ends and returns `{ status }`, or `{ status: 128 + signal, signal }` when a signal ended it; `kill(pid, sig)` signals it;
- `async`: operations of the process that any of its threads can wait for: `submit(req)` runs a kernel syscall without blocking the caller, `resolve(value)` completes at once, `hold()` never completes, and each returns an id; `wait(timeoutMs?)` returns the id of a completed one (0 after the timeout, -1 once `close()` was called), `take(id)` its `{ value }` or `{ error }` (`undefined` while it is pending), and `cancel(id)` drops one;
- `errno(err)`: the WASI errno of an error.

## Network

Programs talk to each other over sockets, and to the outside world through a proxy that hands every request to a transport the page passes in.

```js
import { createKernel, fetchTransport } from './node_modules/@ai-ecoverse/slicc-kernel/dist/index.js';

const kernel = await createKernel({ network: { transport: fetchTransport() } });
await kernel.run(['curl', '-sS', 'https://registry.npmjs.org/@ai-ecoverse/wasm-bash/latest']);
```

- **Sockets**: `AF_INET` stream sockets on `127.x` and `AF_UNIX` sockets are kernel descriptors on one loopback network per kernel, so processes can serve and connect to each other. They survive `dup`, `fork` and `exec` and work with `select` and `poll`, like pipe ends. A bind of an `AF_UNIX` socket creates its path in OPFS. Other addresses are unreachable: programs reach the outside world only through the proxy.
- **The proxy** listens on `127.0.0.1:3128` from the first connection on. It takes absolute-form `http:` requests and `CONNECT` tunnels, which it terminates with a certificate for the requested host, issued by the kernel's own CA, then hands each request to the transport. Programs start with `http_proxy`, `https_proxy` (and the upper-case names) pointing at it, `no_proxy` covering loopback, and `SSL_CERT_FILE`, `CURL_CA_BUNDLE` and `GIT_SSL_CAINFO` pointing at the CA certificate in `/etc/ssl/certs/slicc-kernel-ca.pem`; variables in `env` override them. The CA's key never leaves WebCrypto; it is kept in IndexedDB (`<metadata>-ca`, or in memory with `metadata: false`).
- **TLS** needs [`@ai-ecoverse/wasm-tls-engine`](https://www.npmjs.com/package/@ai-ecoverse/wasm-tls-engine) installed under `modules`, like a command. Without it, `CONNECT` is answered `501` with the reason.
- **The transport** is an object on the page with `traits` (`manualRedirects`, `encodedBodies`, `maxRequestBody`, and `crossOrigin`: `'cors'` or `'any'`) and `fetch(request)`, which answers `{ status, statusText, headers, body, cancel }` with `body` an async iterable of `Uint8Array`. The kernel pulls the body one chunk at a time, so a slow program slows the download. A rejection with a numeric `status` is answered with that status; any other with `502`. `fetchTransport()` is the plain `fetch` of the page, bound by CORS (`registry.npmjs.org` and jsDelivr allow it); an embedder with a way around CORS passes its own.
- **`localProxyTransport({ url, key })`** sends every request to a local proxy on loopback, such as [slicc-node](https://github.com/ai-ecoverse/slicc-node) or slicc-swift, which fetches it without CORS. Redirects reach the program unfollowed, with every `Set-Cookie`; bodies arrive decoded. `probeLocalProxy({ url, key })` resolves with the proxy's capabilities, or `null` when it is gone or refuses the key, so a page can fall back to `fetchTransport()`. Both take a `fetch` option, and the transport a `maxRequestBody` (default 64 MiB).
- **Without a transport**, every request is answered `502` with `slicc-kernel: no network transport (createKernel({ network: { transport } }))`.

Process workers can also use the transport directly, without a socket: the `net-request`, `net-read` and `net-close` syscalls (`Module.sliccKernel.http` in a process) open a request and read its body in pieces. Requests are per process and closed when it exits, and a request body has no size limit of its own (the transport's `maxRequestBody` applies to the proxy). `net-traits` answers the transport's `traits` with `crossOrigin`: `'cors'` when it is bound by CORS like `fetchTransport()`, `'any'` (the default for a transport that does not say) when it is not; without a transport it fails with `ENETUNREACH`.

### Local proxy protocol

The page and the proxy speak raw mode of SLICC's `/api/fetch-proxy`. Every request is one `POST {url}/api/fetch-proxy` with `credentials: 'omit'`:

- `X-Bridge-Token: <key>`, the per-process proxy key. It travels only in this header, never in a URL.
- `X-Slicc-Raw-Request: <json>`, the head to send upstream: `{ "url", "method", "headers": [[name, value], …] }`, with the headers in order and repeats kept apart. Characters past U+007E are `\u`-escaped so the value is a valid header.
- The request body, if any, as the hop's body.

The proxy answers `200` with `Content-Type: application/vnd.slicc.raw-fetch`: a big-endian `u32` length, that many bytes of UTF-8 JSON `{ "status", "statusText", "headers": [[name, value], …], "url" }`, then the upstream body until the end of the hop. Any other answer is a refusal with a JSON `{ "error" }` body and `X-Proxy-Error: 1`; programs see its status (`400` malformed head, `403` wrong origin or key, `413` body too large, `502` upstream unreachable). A probe is a `POST` with the key and `X-Slicc-Raw-Probe: 1` instead of a head; it is answered with JSON `{ "rawFetch": 1, "requestBodyStreaming", "maxRequestBodyBytes" }` and fetches nothing. The server side (origin allowlist, CORS, the Private Network Access preflight) is specified in [slicc-node's README](https://github.com/ai-ecoverse/slicc-node#protocol).

## Filesystem

`/` is the OPFS root. Each process mounts the top-level directories that exist when it starts (plus `/usr` and `/bin`), so files in them are shared by all processes and visible through the OPFS API as soon as the process that wrote them has closed them; `run` resolves only after that. `createKernel` creates `/tmp` and `/home` in OPFS, so they are shared too. Files directly in `/`, and directories created there after a process started, are OPFS as well, the same for Emscripten and WASI programs; only `/dev` and `/proc` live in each process's memory. File contents are buffered per open file and written back on close, `fsync` and exit; metadata operations (`mkdir`, `rename`, `rm`, …) go straight to OPFS. The kernel worker is the only writer.

Directories are renamed with `FileSystemHandle.move()` where available, else by copy and delete.

### Metadata

OPFS stores names, bytes, sizes and modification times, nothing else. Everything POSIX needs on top of that lives in an IndexedDB sidecar, so it survives reloads and new kernels:

- mode bits (`chmod`);
- access and change times, and a modification time set explicitly with `utime` (it holds until the file is written again);
- inode numbers that stay stable across renames;
- symbolic links (`symlink`, `readlink`, `lstat`, and following them in paths), which exist only in the sidecar.

OPFS stays authoritative: an entry is consulted only for a path that exists in OPFS (symlinks only for paths that don't), so files written straight to OPFS, for example by the BIOS installer or a page, get the defaults: directories `0755`, files `0644`, and files under `node_modules/*/bin/` `0755`. A file deleted through the OPFS API disappears at once; its leftover entry is ignored and removed when the next kernel starts. Changes go to OPFS first and then to the sidecar, so a crash in between at worst loses the metadata of that one change. Each change is a read-modify-write inside one IndexedDB transaction, so two kernels (two tabs) on the same origin don't lose each other's updates.

The database is `slicc-kernel` (or the `metadata` option), schema version 1, with one object store, `entries`, keyed by absolute path (`keyPath: 'path'`) and an index `dir` on the parent directory of symlinks. A record looks like `{ path, mode?, atimeMs?, mtimeMs?, mtimeFor?, ctimeMs?, ino?, link?, dir? }`, where `mtimeFor` is the OPFS `lastModified` an explicit `mtimeMs` belongs to. A future schema bumps the version and migrates in `onupgradeneeded`; an older kernel then closes its connection. The sidecar is keyed by path from the `root` handle, so use a different `metadata` name for each distinct root.

Not covered: hard links (they fail with `EMLINK`, as Emscripten reports; OPFS cannot share contents between names) and file ownership. Emscripten's `chown` doesn't pass the owner to filesystem backends, so there is nothing to store, and processes see every file as owned by uid and gid 1000. Emscripten also doesn't enforce permission bits, so a file runs whether or not its exec bit is set; the bits are what `ls`, `stat` and `test` report.

Reads retry briefly when a concurrent write has invalidated the OPFS file snapshot (`NotReadableError`).

A kernel caches the directory handles it has walked and the sidecar entries it has read. Its own changes keep both caches current, and the other kernels on the origin hear of them through a `BroadcastChannel` named after the database (one for the sidecar, one for directories). A cached directory is checked against its path (`resolve()`) at most once a second before a lookup goes through it, so a directory moved, removed or replaced by another writer, such as a page using the OPFS API, is found at its new place or reported missing within a second.

The filesystem is our own rather than [ZenFS](https://github.com/zen-fs/core) (which SLICC uses), because OPFS stays the single source of truth: other writers, such as the BIOS installing packages or a page writing files, need no index to stay consistent with, and nothing is preloaded into memory at mount. POSIX metadata lives in the IndexedDB sidecar described above, which has per-entry transactions instead of one JSON file rewritten on every change.

## What is in here

The kernel is ported from SLICC's `packages/webapp/src/kernel/` with the browser-specific VFS replaced by an OPFS one:

- `src/kernel/`: the kernel side, per process (`host.ts` starts the worker and answers its syscalls in `process.ts`) and shared tables (descriptors, pipes, children, jobs, signals, terminals and pseudo-terminals, `select`).
- `src/process/`: the runtime inside each process worker. It evaluates the Emscripten glue, mounts the live VFS, routes descriptors through the kernel and implements `fork` by copying the whole linear memory into a new worker (Asyncify). `src/process/wasi/` runs WASI and WASIX programs.
- `src/realm/`: the synchronous bridge (`SharedArrayBuffer` + `Atomics.wait`) and the live Emscripten filesystem on top of it.
- `src/fs/`: the OPFS filesystem and the virtual command directories.
- `src/launcher.ts`, `src/commands.ts`, `src/serve.ts`, `src/index.ts`: command resolution, the kernel worker protocol and the page API; `src/node.ts`, `src/node-process-worker.ts` and `src/node/` the headless Node entry. An embedder that uses `Launcher` directly, without `createKernel`, calls `await launcher.prepare()` first: it creates `/tmp` and `/home` and writes the CA certificate.
- `src/kernel/net/`: the proxy, HTTP/1.1, TLS termination and the local CA, and the bridge to the page's transport; `src/transport.ts` and `src/local-proxy-transport.ts` are the page side.


## Installing from git

`npm install github:ai-ecoverse/slicc-kernel#<sha>` works: the `prepare` script builds `dist/`.

## Development

```sh
npm install
npm run lint
npm test
npm run test:unit
```

`npm test` builds `dist/` and runs the integration tests in Chromium from `playwright-core`, over raw CDP through the [harness from slicc-shared-web](https://github.com/ai-ecoverse/slicc-shared-web#integration-test-harness), against a cross-origin isolated test page that installs bash and coreutils into OPFS. Each test writes screenshots, console logs and CPU profiles to `artifacts/`; V8 coverage from the page and every worker, mapped back to `src/` through the source maps, goes to `coverage/`, and `artifacts/hotspots.md` lists where the time went.

Unit tests live in `test/unit/`, which stays out of git. They run real wasm bash and coreutils through the whole stack in Node `worker_threads` against an in-memory OPFS. The pre-commit hook runs them under coverage and requires every changed line in `src/` to be covered.

The Biome, TypeScript, lefthook, Renovate and CI configuration comes from [slicc-shared-web](https://github.com/ai-ecoverse/slicc-shared-web), which also provides the `slicc-lint-comments` (no comments anywhere), `slicc-no-unit-tests` (no unit tests in git) and `slicc-diff-cover` (100% coverage of changed lines) commands that `npm run lint` and the pre-commit hook use.

## License

Apache-2.0
