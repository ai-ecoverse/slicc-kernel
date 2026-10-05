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

## Commands

Commands come from installed packages in npm's `node_modules` layout: every `<modules>/<name>/package.json` and `<modules>/@scope/<name>/package.json` with a `slicc.commands` block (`abi` `emscripten`), for example bash's:

```json
{ "slicc": { "abi": "emscripten", "commands": { "bash": { "glue": "bin/bash", "wasm": "bin/bash.wasm" } } } }
```

Entries may also set `argv0`, `args` and `env` (with `${package}` expanded to the package directory), and a package-wide `slicc.env`. The first package to define a name wins. `sh` runs bash as `sh` unless a package provides its own. The installed commands appear as executables in a virtual `/usr/bin` and `/bin`, so `PATH` lookups, `command -v` and `ls /usr/bin` work without writing anything to OPFS. A process can also run a program by the path of its glue when the `.wasm` sits next to it, and a script through its `#!` line (including `#!/usr/bin/env name`). Executing any other file fails with `ENOEXEC`, so bash runs it as a shell script, as POSIX shells do. The catalog is re-read at the start of every `run`, so packages installed in between are picked up.

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
- **The transport** is an object on the page with `traits` (`manualRedirects`, `encodedBodies`, `maxRequestBody`) and `fetch(request)`, which answers `{ status, statusText, headers, body, cancel }` with `body` an async iterable of `Uint8Array`. The kernel pulls the body one chunk at a time, so a slow program slows the download. A rejection with a numeric `status` is answered with that status; any other with `502`. `fetchTransport()` is the plain `fetch` of the page, bound by CORS (`registry.npmjs.org` and jsDelivr allow it); an embedder with a way around CORS passes its own.
- **Without a transport**, every request is answered `502` with `slicc-kernel: no network transport (createKernel({ network: { transport } }))`.

Process workers can also use the transport directly, without a socket: the `net-request`, `net-read` and `net-close` syscalls (`Module.sliccKernel.http` in a process) open a request and read its body in pieces. Requests are per process and closed when it exits.

## Filesystem

`/` is the OPFS root. Each process mounts the top-level directories that exist when it starts (plus `/usr` and `/bin`), so files in them are shared by all processes and visible through the OPFS API as soon as the process that wrote them has closed them; `run` resolves only after that. `createKernel` creates `/tmp` and `/home` in OPFS, so they are shared too. `/dev`, `/proc` and anything created directly in `/` while a process runs live in that process's memory unless it already exists in OPFS. File contents are buffered per open file and written back on close, `fsync` and exit; metadata operations (`mkdir`, `rename`, `rm`, …) go straight to OPFS. The kernel worker is the only writer.

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

The filesystem is our own rather than [ZenFS](https://github.com/zen-fs/core) (which SLICC uses), because OPFS stays the single source of truth: other writers, such as the BIOS installing packages or a page writing files, need no index to stay consistent with, and nothing is preloaded into memory at mount. POSIX metadata lives in the IndexedDB sidecar described above, which has per-entry transactions instead of one JSON file rewritten on every change.

## What is in here

The kernel is ported from SLICC's `packages/webapp/src/kernel/` with the browser-specific VFS replaced by an OPFS one:

- `src/kernel/`: the kernel side, per process (`host.ts` starts the worker and answers its syscalls in `process.ts`) and shared tables (descriptors, pipes, children, jobs, signals, terminals and pseudo-terminals, `select`).
- `src/process/`: the runtime inside each process worker. It evaluates the Emscripten glue, mounts the live VFS, routes descriptors through the kernel and implements `fork` by copying the whole linear memory into a new worker (Asyncify).
- `src/realm/`: the synchronous bridge (`SharedArrayBuffer` + `Atomics.wait`) and the live Emscripten filesystem on top of it.
- `src/fs/`: the OPFS filesystem and the virtual command directories.
- `src/launcher.ts`, `src/commands.ts`, `src/serve.ts`, `src/index.ts`: command resolution, the kernel worker protocol and the page API.
- `src/kernel/net/`: the proxy, HTTP/1.1, TLS termination and the local CA, and the bridge to the page's transport; `src/transport.ts` is the page side.

WASI support is not included.

## Installing from git

`npm install github:ai-ecoverse/slicc-kernel#<sha>` works: the `prepare` script builds `dist/`.

## Development

```sh
npm install
npm run lint
npm test
npm run test:unit
```

`npm test` builds `dist/` and runs the integration tests in Chromium from `playwright-core`, over raw CDP, against a cross-origin isolated test page that installs bash and coreutils into OPFS. Each test writes screenshots, console logs and CPU profiles to `artifacts/`; V8 coverage from the page and every worker, mapped back to `src/` through the source maps, goes to `coverage/`, and `artifacts/hotspots.md` lists where the time went.

Unit tests live in `test/unit/`, which stays out of git. They run real wasm bash and coreutils through the whole stack in Node `worker_threads` against an in-memory OPFS. The pre-commit hook runs them under coverage and requires every changed line in `src/` to be covered.

The Biome, TypeScript, lefthook, Renovate and CI configuration comes from [slicc-shared-web](https://github.com/ai-ecoverse/slicc-shared-web), which also provides the `slicc-lint-comments` (no comments anywhere), `slicc-no-unit-tests` (no unit tests in git) and `slicc-diff-cover` (100% coverage of changed lines) commands that `npm run lint` and the pre-commit hook use.

## License

Apache-2.0
