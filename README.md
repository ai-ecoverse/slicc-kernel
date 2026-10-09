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
- **The kernel lives in a dedicated worker owned by the page.** A `SharedWorker` is never cross-origin isolated in Chromium (and has no `Worker` constructor), so it cannot host the kernel. `createKernel` starts `dist/kernel-worker.js`; that worker owns OPFS and starts one nested dedicated worker (`dist/process-worker.js`) per process. The kernel worker reads `process-worker.js` once when it starts and runs every process and thread from that copy (a `blob:` URL), so updating the package in place while a kernel runs does not mix versions: the next page load switches both.
- The page's CSP must allow `eval`, since each process evaluates its program's Emscripten glue with `new Function`, and `blob:` workers (`worker-src 'self' blob:`, or the `script-src` it falls back to), since processes run from the kernel's pinned copy of `process-worker.js`.

`dist/` is plain ESM with no bare imports, and the workers are referenced with `new URL('./….js', import.meta.url)`, so the files work when served as-is (for example from OPFS through a service worker). Whatever serves them must send the COOP/COEP headers on the page and a compatible `Cross-Origin-Resource-Policy` on the scripts.

## API

### `createKernel(options?) → Promise<Kernel>`

| option | default | |
| --- | --- | --- |
| `root` | `navigator.storage.getDirectory()` | the `FileSystemDirectoryHandle` that becomes `/` |
| `modules` | `'/node_modules'` | where installed packages are scanned for commands |
| `env` | `{}` | environment added to every run |
| `metadata` | `'slicc-kernel'` | the IndexedDB database for POSIX metadata (see [Metadata](#metadata)); `false` keeps it in memory for the kernel's lifetime |
| `ca` | `'<metadata>-ca'`, or `'slicc-kernel-ca'` | the IndexedDB database for the proxy's CA (see [Network](#network)); `false` keeps it in memory |
| `media` | `'<metadata>:media'` | the IndexedDB database for the folder handles of `fsa` drives (see [Removable media](#removable-media-fsa)); `false` keeps them in memory, as `metadata: false` does |
| `worker` | `new URL('./kernel-worker.js', import.meta.url)` | the kernel worker script |
| `network` | none | `{ transport, uplink }`: how programs reach the outside world (see [Network](#network) and [Uplink](#uplink)) |
| `requestDirectory` | none | `() => Promise<FileSystemDirectoryHandle>`, typically `showDirectoryPicker`: how an `fsa` mount gets its folder (see [Removable media](#removable-media-fsa)) |
| `hostfs` | none | `(source, { readonly }) => Promise<{ url, token, capabilities? }>`: a grant for a `hostfs` mount from the local proxy (see [Host folders](#host-folders-hostfs)) |
| `onMountPending` | none | `({ target, source, insert }) => void`: an `fsa` mount needs a folder; call `insert()` from a user gesture |
| `processMounts` | `true` | whether programs may call `mount(2)` and `umount2(2)`: `false`, or `(req) => boolean \| Promise<boolean>` to decide each call (see [Mounting from a program](#mounting-from-a-program)) |
| `hostname` | `'slicc'` | the kernel's node name (see [Node name](#node-name)) |
| `cdp` | none | `({ runtime }) => Promise<CdpConnection>`: a browser-level DevTools connection for programs that drive a browser (see [Browser automation](#browser-automation-cdp)) |

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
| `write(data)` | types a string or bytes into the terminal; with `ISIG` on, `^C`, `^Z` and `^\` signal the foreground process group. A key typed while a child of that group is still setting up is held until the child has finished, then sent to the group in the foreground at that point. Setting up means the child's calls before its first other one: `setpgid`, `tcsetpgrp` and signal masks. The hold ends 250 ms after the child's first call at the latest. So `^Z` right after a command line stops the new job, as it does on Linux, where that setup takes microseconds rather than a worker start. |
| `resize(cols, rows)` | sets the window size (`TIOCGWINSZ`) and sends `SIGWINCH` to the foreground process group |
| `signal(name)` | sends a signal (`'SIGINT'`, `'SIGTSTP'`, `'SIGQUIT'`, `'SIGHUP'`, …) to the foreground process group, regardless of termios |
| `exited` | resolves with the session leader's exit status (`128 + n` if killed by signal `n`) |
| `close()` | hangs up: `SIGHUP` to the foreground process group, and reads from the terminal return end-of-file |

### `kernel.terminate()`

Stops the kernel worker and every process. Pending and later calls reject.

### `kernel.connect() → Promise<MessagePort>`

Makes a port for another client of the same kernel. Hand it to a dedicated worker, or through a SharedWorker to another tab: it can be transferred any number of times. All clients share one process table, so a terminal on the page can `ps` and `kill` what a worker started.

### `kernel.setRoutes({ prefixes, exit }) → Promise<void>`

Replaces the [uplink](#uplink)'s route table: `prefixes` are addresses or CIDR prefixes (`100.64.0.0/10`, `fd7a:115c:a1e0::/48`), and `exit: true` routes every address, as an exit node does. A prefix that does not parse rejects the whole table and keeps the old one.

### `kernel.dial({ port, host? })` and `kernel.loopbackFetch(input, { port, host?, signal? })`

Reach a server a program runs on the kernel's loopback (a dev server, `python -m http.server`) from the page, a service worker or an attached client, which have both calls too (protocol 1.4).

- **`dial`** connects to `127.0.0.1:<port>` inside the kernel (`host` may also be `localhost` or `::1`) and resolves with `{ readable, writable, close() }`: a `ReadableStream` and a `WritableStream` of bytes. `writable.close()` half-closes the connection, as `shutdown(SHUT_WR)` does, and `close()` closes it. Each connection has a `MessagePort` of its own, and an attached client's connections close when it detaches; the other end then reads `ECONNRESET`.
- **`loopbackFetch`** sends an HTTP/1.1 request over `dial` and resolves with a `Response` as soon as the headers arrive. The body streams (chunked, counted, or until the connection closes), so server-sent events and long polls work; cancelling the body or aborting `signal` closes the connection. The request is routed by `port`, not by the URL, whose host is sent as `Host`; a request body is sent with `Content-Length`, and every request uses a connection of its own (`Connection: close`).
- **Errors** reject with an `Error` whose `code` is the errno: `ECONNREFUSED` when nothing listens on the port or the port is kernel-only (`9222`, the [CDP facade](#browser-automation-cdp)), `ENETUNREACH` for a host that is not the loopback, `EINVAL` for a port outside 1–65535.
- **Names**: a page reaches the kernel's loopback as `<port>.kernel.localhost`, which is the loopback and a secure context, so a request no service worker routes lands on port 80 of the real machine instead of a real server on that port; the service worker routes the name to `loopbackFetch` with that port. Programs find the name in `SLICC_PAGE_LOOPBACK` (`kernel.localhost`) and `SLICC_PAGE_LOOPBACK_URL` (`http://{port}.kernel.localhost`), to print or inject the right URL.

### `attachKernel(port, options?) → Promise<KernelClient>`

Attaches to a kernel over a port from `kernel.connect()`, in any realm: a worker, another tab, or Node. `options.timeoutMs` (10 s by default) bounds the handshake: a port with no kernel behind it rejects with `KernelGoneError`.

| Client | |
|---|---|
| `spawn(argv, { cwd, env, stdin, pgid, onStdout, onStderr })` | runs over pipes and resolves with `{ pid, pgid, exited, signal(name) }` once the process has started; output arrives in chunks, as bytes, and the kernel keeps no copy; every spawn leads its own process group, which `signal` (default `SIGTERM`) signals, unless `pgid` names an existing group to join (protocol 1.3): the process then joins that group and that group's session, as `setpgid` would (a client has no session of its own: each of its spawns and terminals leads one, and `setpgid` cannot cross sessions), and `signal` signals the whole group. The group must have been started by this client (a spawn or a terminal it opened), even if its leader has exited; an unknown group rejects with `code: 'ESRCH'`, another session's with `code: 'EPERM'`, and against a 1.2 kernel the client rejects with `code: 'ENOSYS'` before sending anything, as an older kernel would ignore the option; a program that cannot start rejects with `code: 'ENOENT'` |
| `run(argv, options?)` | `spawn` and wait: `{ pid, status, stdout, stderr }` as text, with `onStdout`/`onStderr` streaming text |
| `openTerminal(argv, options?)` | a pty session, as `kernel.openTerminal` |
| `ps()` | the kernel's processes: `{ pid, ppid, pgid, sid, argv, tty, started, state }`, `state` being `'S'` or `'Z'` |
| `kill(pid, signal?)` | any process, or a process group with a negative pid; no such process rejects with `code: 'ESRCH'` |
| `fs` | `readFile`, `readText`, `writeFile(path, string \| bytes)`, `stat`, `lstat`, `readdir`, `mkdir` (with parents), `rm(path, { force })` (recursive), `rename`, `realpath`, `symlink(target, path)`, `readlink`, `exists`, on the processes' file system; failures reject with `KernelCallError` and a POSIX `code` |
| `fetch({ url, method, headers, body, signal })` | through the kernel's network transport (the one the page passed to `createKernel`), with a streaming body; `transport` is the same as a `NetworkTransport` |
| `fs.watch(paths, { recursive }, onChange)` | resolves with `{ close() }`; `onChange` gets `{ paths }`, the changed paths at, below (or, without `recursive`, directly in) the watched ones, batched per task, or `{ overflow: true }` when there were too many to list, to rescan; it covers every change made through this kernel, by its processes and its clients |
| `serveCdp(hook, { runtime })` | offers this client's browser to the kernel's programs (protocol 1.5): `hook` is the `cdp` hook of `createKernel`, asked once per program connection; resolves with `{ close() }`, and closing or detaching takes the offer back and closes its connections (see [Browser automation](#browser-automation-cdp)) |
| `close({ kill })` | detaches: the client's processes keep running unless `kill` is set, which ends their process groups with `SIGKILL`; its terminals are hung up |
| `closed` | resolves with the error that ended the client |

When the kernel goes away (the page closed or reloaded, `terminate()`), pending calls and `exited` reject with `KernelGoneError`, and so do later calls. Each side holds a Web Lock and waits on the other's, since a `MessagePort` reports no close in browsers; in Node, the port's `close` event does the same. The first message is a handshake on the protocol version, `1.7` (`1.0` had no `watch`, `1.1` no mounts, `1.2` no `spawn` into a group, `1.3` no `dial` and `1.4` no `serveCdp`, which reject with `code: 'ENOSYS'` on such a kernel; a `1.5` kernel has no [uplink](#uplink), and a `1.6` kernel resolves names through one but connects nothing to it): a client or kernel of another major version is refused with an error naming both.

### Headless in Node, for tests

`@ai-ecoverse/slicc-kernel/node` runs the same kernel in Node without a browser, so packages built for SLICC can test against it. It is a testing entry, not a supported runtime: there is no OPFS and no isolation, and nothing beyond what its tests use is promised.

```js
import { createNodeKernel, nodeTransport } from '@ai-ecoverse/slicc-kernel/node';

const kernel = await createNodeKernel({ network: { transport: nodeTransport() } });
await kernel.writeFile('/node_modules/@ai-ecoverse/wasm-bash/package.json', manifest);
const { status, stdout } = await kernel.run(['bash', '-c', 'echo hi'], { cwd: '/home' });
kernel.terminate();
```

`createNodeKernel({ root, modules, env, network, worker, processMounts, fstabRetries, cdp, hostfs, hostfsOrigin, hostfsFetch })` takes the options of `createKernel` except `metadata`, and `fstabRetries`, the delays in ms between tries of a failing `/etc/fstab` line (default `[1000, 4000, 16000]`). `root` is an in-memory directory by default (`memoryRoot()` makes another), which keeps each file in 1 MiB chunks, and POSIX metadata stays in memory. Processes and threads run on `worker_threads`. The kernel has `run`, `openTerminal`, `setRoutes` and `terminate` as above, plus `root`, `writeFile(path, data)` (creating the parent directories) and `readFile(path)` to put files in place and read results. `nodeTransport()` is `fetchTransport()` with Node's `fetch`, which no CORS binds (`crossOrigin: 'any'`). `connect()` and `attachKernel` work as in the browser: the port is a `worker_threads` `MessagePort`, which a worker thread can attach with, and `terminate()` ends every attached client.

## Commands

Commands come from installed packages in npm's `node_modules` layout: every `<modules>/<name>/package.json` and `<modules>/@scope/<name>/package.json` with a `slicc.commands` block. An Emscripten program names its glue and module, for example bash's:

```json
{ "slicc": { "abi": "emscripten", "commands": { "bash": { "glue": "bin/bash", "wasm": "bin/bash.wasm" } } } }
```

A WASI preview1 or WASIX program (Zig, Rust, Go, wasi-libc or wasix-libc C) has no glue: `"abi": "wasi"`, on `slicc` or per command (which wins), and the command names only its module. A command can also be a `#!` script of the package, which its interpreter runs as execve(2) would:

```json
{ "slicc": { "abi": "wasi", "commands": { "rg": { "wasm": "bin/rg.wasm" }, "rustc": { "script": "bin/rustc" } } } }
```

Entries may also set `argv0`, `args` and `env`, and a package can set `slicc.env` for all of its commands. A WASI entry with `"preopenRoot": true` also gets `/` as a preopen (see [WASI programs](#wasi-programs)). An entry with `"argv0Path": true` gets the absolute path it was run by as `argv[0]` when that path is a link outside `/bin` and `/usr/bin` to the command, as a venv's `bin/python` is (the `#!` line of a script naming such a link included), so it can find what sits beside that link; other entries keep their `argv0`. In `env`, `${package}` is the package directory, `${cwd}` the process's working directory, and `${NAME}` the caller's `NAME` when the program starts (a default naming an unset variable is left out); a relative path that exists in the package (`lib/python3.14`, `./`) becomes that absolute path. The caller's environment wins over these defaults; a `null` value removes the variable for the command, after the caller's environment is applied (a host-networked program can drop the kernel's proxy settings that way), and a command entry can set a variable its package's `slicc.env` removes. The first package to define a name wins. `sh` runs bash as `sh` unless a package provides its own. The installed commands appear as executables in a virtual `/usr/bin` and `/bin`, so `PATH` lookups, `command -v` and `ls /usr/bin` work without writing anything to OPFS. A process can also run a program by the path of its glue when the `.wasm` sits next to it, a wasm module by its own path (as a WASI program), and a script through its `#!` line (including `#!/usr/bin/env name`). Executing any other file fails with `ENOEXEC`, so bash runs it as a shell script, as POSIX shells do. Commands also come from pnpm's global directory. Every process gets `PNPM_HOME=/home/.local/share/pnpm`, unless the embedder sets its own, and has `$PNPM_HOME/bin` on `PATH`. The kernel scans each of pnpm's global install groups (`$PNPM_HOME/global/*/<group>/node_modules`) after `/node_modules`, which wins when both provide a command. The catalog is re-read whenever anything under either changes, so `pnpm add -g @ai-ecoverse/wasi-ripgrep` makes `rg` work in the same shell, and `pnpm remove -g` removes it again.

### WASI programs

A WASI program runs in a process worker of its own like an Emscripten one, against the same kernel: its descriptors, pipes, terminals and job control are the kernel's, and its files are OPFS. **Preopens**, in order:
1. `.`, the cwd, as fd 3, which Zig's std takes for its cwd;
2. `/dev` and every top-level directory, plus the virtual `/usr` and `/bin`, sorted by name.

Every WASI program sees `/` through the cwd.

**`preopenRoot`.** A command whose manifest entry sets `"preopenRoot": true` gets two more preopens after those:
3. `/`, the root;
4. `./`, the cwd again.

That's for programs that walk to the root, such as Go's (`GOOS=wasip1`) and esbuild's resolver. The order serves each runtime:
- **Go** takes its working directory from `PWD`, which every process gets, and resolves absolute paths against the longest matching preopen name. So `os.ReadDir("/")`, `filepath.Abs("../..")` and walking up to the root work. Without `preopenRoot`, nothing is named `/` and they fail with `EBADF`.
- **wasi-libc** (C, and Rust's `wasm32-wasip1`) reads `.`, `/` and `./` as the same empty prefix, and the last one wins. So the trailing `./` keeps relative paths on the cwd.
- **Zig** keeps fd 3, and a second `.` would stop it from starting.

**Working directory.** wasi-libc's own `getcwd()` stays `/` (Rust's `current_dir()`, `canonicalize(".")`) in either layout, because the C library starts with a working directory of `/` and no runtime can change it. A wasi-libc program that needs its real directory takes it from `PWD` (`set_current_dir($PWD)` at start); relative paths are the cwd either way. WASIX programs ask the kernel for their cwd and get the real one.

**Descriptor numbers.** Preopens take consecutive descriptors from 3, since WASI libraries look for them until the first gap:
- without `preopenRoot`: fds 3 through 3 + *n*, *n* being the number of top-level directories, `/dev`, `/usr` and `/bin` together;
- with it: two more, through 3 + *n* + 2.

A descriptor a program inherits at one of those numbers (from bash's `3<file`, or a `posix_spawn` file action) moves to the first free number above them. One above the range keeps its number. A command that takes descriptors by number from its caller should leave `preopenRoot` off, which keeps the shorter range.

On top of preview1 a WASI program gets:

- **Threads**: `wasi.thread-spawn` (wasm32-wasip1-threads) and WASIX `thread_spawn_v2` start a worker per thread on the process's shared memory, sized from the module's own import (a 2 GiB maximum when the engine cannot reserve more). The threads share one descriptor table; `exit` or a trap in any thread ends the process. At most 64 threads per process; `SLICC_WASM_THREADS` sets another cap, up to 256.
- **WASIX** (a module importing `wasix_32v1`): fork and setjmp/longjmp through Asyncify (the module is built with `wasm-opt --asyncify`), exec, `posix_spawn`, `waitpid`, pipes, `dup2`, signal handlers and interval timers, terminal modes, and dynamic linking: a position-independent main module loads side modules with `dlopen` from `LD_LIBRARY_PATH`, its runtime path, `/lib`, `/usr/lib` and `/usr/local/lib`.
- **Sockets**: the WASIX socket calls (`sock_open`, `bind`, `listen`, `connect`, `accept`, options, local and peer names) are the kernel's loopback sockets, and preview1's `sock_recv` / `sock_send` / `sock_shutdown` work on them and on inherited ones. Writing to a socket whose peer is gone fails with `EPIPE`, through `fd_write` as through `sock_send`, as if `MSG_NOSIGNAL` were set, since a WASI program cannot ignore `SIGPIPE`; a pipe or terminal whose reader is gone still ends the program with status 141. HTTP and HTTPS leave through the realm proxy that `https_proxy` names, as for any other program; `resolve` answers `/etc/hosts` names and literal addresses, and the [uplink](#uplink)'s names.
- **Diagnostics**: a trap ends the program with 134 and its message on stderr; with `SLICC_WASM_BACKTRACE=1` the wasm frames follow, named from the module's name section, or from a sidecar for a module shipped without one (`<module>.names` beside it, or the same path in a `<package>-names` package). `SLICC_WASI_STATS=1` makes a program print its calls, counted and timed, as it ends.

### Program imports

A WASI command can name an ES module of its package that provides imports of its own, for host functions a program needs beyond WASI (`"imports": "host/pnpm-host.mjs"`). Each worker of the process (the process and every thread) loads it, with the same trust as Emscripten glue, and calls its `createImports(ctx)`, which returns import namespaces (`{ pnpm_host: { … } }`). It may not define `wasi_snapshot_preview1`, `wasix_32v1`, `wasi` or `env`; any other namespace the module imports is then accepted, and functions it does not provide answer `ENOSYS`. A WASI program (one that imports `wasi_snapshot_preview1` or `wasix_32v1`) needs no imports module for that: without one, its function imports from namespaces of its own all answer `ENOSYS`, so the same binary runs the commands that need no host functions anywhere. A stub answers in the import's own result type: 52 for `i32`, `f32` and `f64`, `52n` for `i64`, and nothing for a function without a result. An import whose result cannot carry an errno (several values, `v128`, a reference) is refused (126) unless the imports module provides it. A module with no WASI imports, or a foreign import that is not a function, is still refused (126). `ctx` has:

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

- **Sockets**: `AF_INET` stream sockets on `127.x` and `AF_UNIX` sockets are kernel descriptors on one loopback network per kernel, so processes can serve and connect to each other. They survive `dup`, `fork` and `exec` and work with `select` and `poll`, like pipe ends. A bind of an `AF_UNIX` socket creates its path in OPFS. Other addresses are unreachable (`ENETUNREACH`) unless the [uplink](#uplink) routes them: otherwise programs reach the outside world only through the proxy.
- **The proxy** listens on `127.0.0.1:3128` from the first connection on. It takes absolute-form `http:` requests and `CONNECT` tunnels, which it terminates with a certificate for the requested host, issued by the kernel's own CA, then hands each request to the transport. Programs start with `http_proxy`, `https_proxy` (and the upper-case names) pointing at it, `no_proxy` covering loopback and the [node name](#node-name), and `SSL_CERT_FILE`, `CURL_CA_BUNDLE` and `GIT_SSL_CAINFO` pointing at the CA bundle in `/etc/ssl/certs/slicc-kernel-ca.pem`; variables in `env` override them. The CA's key never leaves WebCrypto; it is kept in IndexedDB, in `<metadata>-ca`, or in `slicc-kernel-ca` when `metadata` is the default or `false`, so kernels on one origin share one CA whether or not they keep metadata. `ca` names another database, and `ca: false` keeps a CA in memory for the kernel's lifetime. Each kernel adds its CA to the bundle instead of replacing it, so every kernel on the origin stays trusted; the bundle keeps the newest 16.
- **TLS** needs [`@ai-ecoverse/wasm-tls-engine`](https://www.npmjs.com/package/@ai-ecoverse/wasm-tls-engine) installed under `modules`, like a command. Without it, `CONNECT` is answered `501` with the reason.
- **The transport** is an object on the page with `traits` (`manualRedirects`, `encodedBodies`, `maxRequestBody`, and `crossOrigin`: `'cors'` or `'any'`) and `fetch(request)`, which answers `{ status, statusText, headers, body, cancel }` with `body` an async iterable of `Uint8Array`. The kernel pulls the body one chunk at a time, so a slow program slows the download. A rejection with a numeric `status` is answered with that status; any other with `502`. `fetchTransport()` is the plain `fetch` of the page, bound by CORS; its `hint` option is appended to the message of a request it could not make, so a program's 502 can name a way around CORS (`registry.npmjs.org` and jsDelivr allow it); an embedder with a way around CORS passes its own. A response body that delivers no data for `bodyIdleMs` (default 5 minutes; `0` or `Infinity` turns it off) fails with `ETIMEDOUT` instead of waiting forever, which matters because Chrome under heavy load can stop handing a page the rest of a body. A slow body that keeps delivering is never cut off.
- **`localProxyTransport({ url, key })`** sends every request to a local proxy on loopback, such as [slicc-node](https://github.com/ai-ecoverse/slicc-node) or slicc-swift, which fetches it without CORS. Redirects reach the program unfollowed, with every `Set-Cookie`; bodies arrive decoded. `probeLocalProxy({ url, key })` resolves with the proxy's capabilities, or `null` when it is gone or refuses the key, so a page can fall back to `fetchTransport()`. `checkLocalProxy({ url, key })` says why: it resolves with `{ state }`, which is `ready` (with `probe`), `blocked` (the user denied Chrome's Local Network Access permission, `loopback-network`), `unreachable` (nothing answered; its `permission` is `granted`, `prompt` or `unknown`, and with `prompt` the page cannot tell a dismissed prompt from a proxy that is not running, since Chrome asks only once it has a connection), `refused` (with `status` and `error`, such as a stale key) or `incompatible`. The permission is not consulted when the page itself is on loopback. Both take a `fetch` option, and the transport `maxRequestBody` (default 64 MiB) and `bodyIdleMs` like `fetchTransport`.
- **The host machine** is `host.slicc.internal` (`SLICC_HOST_LOOPBACK`), as `host.docker.internal` is in Docker, while `localhost` and `127.0.0.1` stay the kernel's own loopback. The proxy forwards `http(s)://host.slicc.internal:<port>/…` to the transport as `http(s)://127.0.0.1:<port>/…`, so it reaches the real machine's loopback through the local proxy or Node's `fetch` (through the page's own `fetch`, a request needs CORS from that server and Chrome's Local Network Access permission); other loopback addresses are still refused. This is HTTP and HTTPS through the proxy only: `/etc/hosts` and WASIX name resolution give the name `10.0.2.2`, QEMU's address for its host, so a program that connects a socket to it directly fails with `ENETUNREACH` instead of reaching the kernel's loopback.
- **Without a transport**, every request is answered `502` with `slicc-kernel: no network transport (createKernel({ network: { transport } }))`.

### Node name

The kernel has one node name, `slicc` unless `createKernel({ hostname })` (or `createNodeKernel`) names another; it must be a valid host name, and not `localhost`, a `*.localhost` name, `host.slicc.internal`, `wasmer.sh` or an IPv4 address, or `createKernel` rejects. `no_proxy` lists it (and `emscripten`), so HTTP clients reach the kernel's own servers by it directly.
- **Where programs see it:** every process gets it in `HOSTNAME`, which the kernel sets on every start whatever the caller's environment says. Emscripten programs also see it in `/etc/hostname` (next to the synthetic `/etc/hosts` and `/etc/passwd`, which only they have; WASI programs resolve names through the kernel instead) and in `Module.sliccKernel.hostname`.
- **What `uname` says:** `uname -n` and `gethostname()` still report what each program's C library compiled in. That's `emscripten` for Emscripten programs and `wasmer.sh` for WASIX ones; no runtime can change it.
- **Resolving it:** `/etc/hosts` maps the node name and both of those names to `127.0.1.1` (Debian's convention), and name resolution answers them, and `localhost.localdomain`, itself, as `127.0.1.1` and `::1`. So a program that looks up its own host name, as git does for every commit, never asks the [uplink](#uplink), and `127.0.1.1` is the kernel's loopback.
- **The trade-off:** a raw connection to the real `wasmer.sh` resolves to loopback too. HTTP(S) to it still goes through the realm proxy and the transport, which resolve names themselves; `wasmer.sh` is deliberately not in `no_proxy`.
- **A real file wins:** a root that has its own `/etc/hostname` (or `/etc/hosts`, `/etc/passwd`) keeps it, and programs read that file rather than the synthetic one. The kernel's name still drives `HOSTNAME` and name resolution.

### Uplink

`createKernel({ network: { uplink } })` (or `createNodeKernel`) gives the kernel a page-owned way into another network, such as a tailnet. It is the whole kernel's: while the page passes an uplink, every process gets its names. The uplink is an object with:

- `traits`: `{ tcp: true, udp: false, ipv6 }`. Without `ipv6: true`, the kernel asks only for, and keeps only, IPv4 addresses.
- `routes`: the first route table, `{ prefixes, exit }`, which `kernel.setRoutes` replaces when it changes. The kernel matches it itself, so a destination outside it costs no round trip.
- `resolve(name, family, signal)`: resolves with the name's addresses, as a list or as `{ addresses, ttl }` (seconds). `[]` means the name is not the uplink's. `family` is `4`, `6` or `0` (either), and `signal` aborts when the kernel stops waiting.
- `dial({ network: 'tcp', host, port, signal })`: opens a TCP connection and resolves with `{ localAddr, remoteAddr, read(), write(bytes), closeWrite(), close() }`.
  - `read()` resolves with the next bytes, or `null` at the end.
  - `write` resolves with how many bytes it took.
  - `closeWrite()` is `shutdown(SHUT_WR)`.
  - A rejection's `code` (`ECONNREFUSED`, `ENETUNREACH`, `EHOSTUNREACH`, `ETIMEDOUT`, `ECONNRESET`) is what the program sees, and any other is `EHOSTUNREACH`.
  - `signal` aborts when the program gives up.

**Name resolution** (WASIX `sock_addr_resolve`; `Module.sliccKernel.net.resolve(name, family)` for Emscripten programs):
- `/etc/hosts` names are answered by the kernel itself: `localhost`, every `*.localhost`, `host.slicc.internal`, and literal addresses, IPv6 included.
- Any other name goes to the uplink. With no uplink or no answer, the name is not found (`EAI_NONAME`).
- Answers are cached for their TTL, at most 60 s, so a change of exit node takes effect quickly.
- **DNS cannot bridge into the kernel:** an answer that is loopback (`127.0.0.0/8`, `::1`), unspecified (`0.0.0.0`, `::`), the host (`10.0.2.2`), link-local, multicast or otherwise reserved, including the `::ffff:` forms, is dropped and logged with `console.warn`. A name cannot lead a program back to the kernel's loopback.
- An uplink that does not answer within 10 s resolves nothing.

**Connections.** A `connect()` decides in a fixed order:
1. Loopback (`127.0.0.0/8`, `::1`, `0.0.0.0`, `localhost`) is always the kernel's own, including the [CDP facade](#browser-automation-cdp) on `9222`.
2. `host.slicc.internal` (`10.0.2.2`) and reserved addresses are `ENETUNREACH`.
3. An address the route table matches goes through `dial`.
4. Anything else is `ENETUNREACH`.

`bind()` still takes only loopback and `0.0.0.0`, so nothing listens on an uplink address.

An uplink connection is an ordinary socket fd: it survives `dup`, `fork` and `exec`, and works with `select` and `poll`.
- **Blocking `connect`** waits for the dial, at most 30 s (then `ETIMEDOUT`, even if the uplink ignores `signal`; a connection it opens later is closed). A signal interrupts it with `EINTR` while the dial goes on.
- **Non-blocking `connect`** answers `EINPROGRESS`. The socket turns writable when the dial is done, and `SO_ERROR` says how it went.
- **Closing the socket** during the dial gives `ECONNABORTED`.
- **A connection that fails** (its `read()` rejects) closes; the program's next read fails with `ECONNRESET`, and its writes with `EPIPE`. `read()` resolving `null` is an orderly end of stream.
- **`getsockname` and `getpeername`** answer the uplink's `localAddr` and `remoteAddr`.
- **Flow control:** the kernel reads from the connection only while the socket's receive buffer (64 KiB) has room, and writes as the program does, so a slow side slows the other.

In the browser, the page serves the uplink to the kernel worker over the same port as the transport, with buffers copied and transferred. `terminate()` closes every connection and cancels whatever is pending, and the page refuses to dial loopback, `10.0.2.2` or reserved addresses itself as well.

`@ai-ecoverse/slicc-kernel/testing` is test support, kept out of the main entry so it never reaches a page bundle. It runs with the Node kernel and needs no wasm of its own. `fakeUplink({ names, routes, ipv6, peers, address })` is an uplink to pass as `network.uplink`:
- **Names:** `resolve` answers from `names` (a list or `{ addresses, ttl }` per name) and records each question in `asked`.
- **Routes:** `routes` is the first table; `kernel.setRoutes` changes it as for a real uplink.
- **Dials:** each dial is recorded in `dialled`. `localAddr` is `address` (default `100.100.100.100`) with a fresh port. `peers`, keyed `'host:port'` (or `'[v6]:port'`), decides how a dial ends:
  - `{ error: 'ETIMEDOUT' }` (or any code) rejects with that code;
  - `{ hang: true }` never answers, until the kernel aborts the dial;
  - anything not listed is refused with `ECONNREFUSED`;
  - a function is called with the server's side of the connection.
- **The server's side**, `{ read(), write(bytes), end(), reset(code?), buffered, drained(), closed }`:
  - `read()` resolves with what the program wrote, and `null` after its `shutdown(SHUT_WR)` or `close()`. The program's write completes only once the server reads it, so a server that doesn't read holds the program back.
  - `write` queues bytes for the program, and `buffered` counts those the kernel hasn't taken yet; `drained()` resolves when it has taken them all.
  - `end()` is the server's end of stream.
  - `reset(code)` (default `ECONNRESET`) breaks the connection both ways: writes the peer has not read fail, the program's next read fails with `ECONNRESET`, and its writes with `EPIPE`.
  - `closed` resolves when the kernel closes the connection.

### Browser automation (CDP)

Programs drive a browser with the Chrome DevTools Protocol over a WebSocket, whichever host actually has the browser: slicc-extension's `chrome.debugger`, slicc-node's or slicc-swift's CDP proxy, or a test harness. The kernel relays; it does not launch a browser.

- **Programs** find the endpoint in `SLICC_CDP_URL`, `ws://127.0.0.1:9222/devtools/browser/<id>`, where `<id>` is random for each kernel boot. `http://127.0.0.1:9222/json/version` answers `{ "Browser", "Protocol-Version", "webSocketDebuggerUrl" }` with the same URL (carrying the request's query), and `/json/list` (or `/json`) lists the host's targets, without per-target sockets. Every other path is `404`. The listener starts on the first connection, on the kernel's loopback; a program that binds `9222` first keeps it.
- **Sessions** are Chrome's flattened ones: `Target.attachToTarget` with `flatten: true`, then commands with a top-level `sessionId`. Messages pass unchanged, as text frames up to 256 MiB (a larger one closes the socket with `1009`). Each program WebSocket gets a host connection of its own: closing the socket (or exiting) closes it, which detaches its sessions, and a host that closes is passed on as a close frame (`1011` with its reason). The kernel then waits up to a second for the program's close frame before it hangs up, as RFC 6455 has it, so a program that answers the close can still report the code. `terminate()` closes them all.
- **Runtime**: a program adds `runtime=<name>` to the query of the URL it opens, and the kernel gives it to the host; the kernel does not interpret it.
- **No host**: `/json/*` and the WebSocket handshake answer `503` with `slicc-kernel: no CDP host is attached (createKernel({ cdp }) or client.serveCdp)`, and a host that refuses (an unknown runtime, say) gives `502` with its message.
- **Kernel-only**: port `9222` takes connections only from programs in the kernel. `kernel.dial`, a client's `dial` and `loopbackFetch` (and so `9222.kernel.localhost` and slicc-node's tunnel) are refused with `ECONNREFUSED`, since the facade drives the user's real browser.

An embedder offers a browser with the `cdp` option of `createKernel` or `createNodeKernel`, or from an attached client with `client.serveCdp(hook, { runtime })`:

```ts
interface CdpConnection {
  send(message: string): void;
  onmessage: ((message: string) => void) | null;
  onclose: ((reason?: string) => void) | null;
  close(): void;
}
type CdpHook = (request: { runtime?: string }) => Promise<CdpConnection>;
```

A connection is one browser-level CDP session; a host with only per-tab debugging emulates the `Target` domain behind it. A connection asking for a `runtime` goes to the newest client that offered that name; any other goes to the `cdp` option, or else to the newest client offer. In the browser the hook runs on the page, with a `MessagePort` per connection to the kernel worker.

Process workers can also use the transport directly, without a socket: the `net-request`, `net-read` and `net-close` syscalls (`Module.sliccKernel.http` in a process) open a request and read its body in pieces. Requests are per process and closed when it exits, and a request body has no size limit of its own (the transport's `maxRequestBody` applies to the proxy). `net-traits` answers the transport's `traits` with `crossOrigin`: `'cors'` when it is bound by CORS like `fetchTransport()`, `'any'` (the default for a transport that does not say) when it is not; without a transport it fails with `ENETUNREACH`.

### Local proxy protocol

The page and the proxy speak raw mode of SLICC's `/api/fetch-proxy`. Every request is one `POST {url}/api/fetch-proxy` with `credentials: 'omit'`:

- `X-Bridge-Token: <key>`, the per-process proxy key. It travels only in this header, never in a URL.
- `X-Slicc-Raw-Request: <json>`, the head to send upstream: `{ "url", "method", "headers": [[name, value], …] }`, with the headers in order and repeats kept apart. Characters past U+007E are `\u`-escaped so the value is a valid header.
- The request body, if any, as the hop's body.

The proxy answers `200` with `Content-Type: application/vnd.slicc.raw-fetch`: a big-endian `u32` length, that many bytes of UTF-8 JSON `{ "status", "statusText", "headers": [[name, value], …], "url" }`, then the upstream body until the end of the hop. Any other answer is a refusal with a JSON `{ "error" }` body and `X-Proxy-Error: 1`; programs see its status (`400` malformed head, `403` wrong origin or key, `413` body too large, `502` upstream unreachable). A probe is a `POST` with the key and `X-Slicc-Raw-Probe: 1` instead of a head; it is answered with JSON `{ "rawFetch": 1, "requestBodyStreaming", "maxRequestBodyBytes" }` and fetches nothing. A proxy that tunnels to the kernel for `<port>.kernel.localhost` adds `"kernelTunnel"` and `"kernelPort"`, and one that serves a `/cdp` endpoint adds `"cdp"` (a version, e.g. `1`). `checkLocalProxy` and `probeLocalProxy` pass these on when they are numbers. The server side (origin allowlist, CORS, the Private Network Access preflight) is specified in [slicc-node's README](https://github.com/ai-ecoverse/slicc-node#protocol).

## Filesystem

`/` is the OPFS root. Each process mounts the top-level directories that exist when it starts (plus `/usr` and `/bin`), so files in them are shared by all processes and visible through the OPFS API as soon as the process that wrote them has closed them; `run` resolves only after that. `createKernel` creates `/tmp` and `/home` in OPFS, so they are shared too. Files directly in `/`, and directories created there after a process started, are OPFS as well, the same for Emscripten and WASI programs; only `/dev` and `/proc` live in each process's memory. File contents are buffered per open file and written back on close, `fsync` and exit; metadata operations (`mkdir`, `rename`, `rm`, …) go straight to OPFS. The kernel worker is the only writer.

Directories are renamed with `FileSystemHandle.move()` where available, else by copy and delete.

### Mounts

`kernel.mount({ type, source, target, options })` mounts a file system on an existing directory. Every process sees it, Emscripten and WASI alike, and so does every attached client. `kernel.umount(target)` unmounts it, and fails with `EBUSY` while a process has a file open under it. `kernel.mounts()` lists the table, as does `/proc/mounts`. The Node entry and attached clients have the same three calls (client protocol 1.2).

- **Built in:** `tmpfs`, which lives in memory until unmounted, in 1 MiB chunks; `fsa`, a folder the user picks (see [Removable media](#removable-media-fsa)); and `hostfs`, a folder the local proxy exports (see [Host folders](#host-folders-hostfs)).
- **Package drivers:** a package declares a type in `"slicc": { "filesystems": { "<type>": { "module": "<file>" } } }`, and the kernel starts that module in a worker of its own for each mount. The module is a single self-contained file: it can't import bare specifiers.
  - Its default export receives `{ fetch }`, the kernel's network transport. It returns `{ handlers, capabilities }`.
  - The handlers are path-based: `getattr`, `readdir`, `open`/`read`/`write`/`release` on handles, `mkdir`, `rmdir`, `unlink`, `rename`, and optionally `symlink`, `readlink`, `setattr` (`mode`, `mtime`, and `size` to truncate) and `statfs`.
  - An optional `mount({ source, options })` handler validates the source.
  - Errors carry a POSIX `code`.
  - `@ai-ecoverse/slicc-kernel/driver` exports the types and `fsError`.
- **Capabilities:** `readonly`, `symlinks`, `chmod`, `ranges`, `maxIo` (the largest read or write per message), `maxFile`, `listingStats`, `linkTimes`, and `attrTtl`/`entryTtl` (in ms, default 1000). `linkTimes` promises that `setattr` with `mtime` on a symlink sets the link's own time. Without it, setting a link's own times (`touch -h`, `utimensat` with `AT_SYMLINK_NOFOLLOW`) fails with `EOPNOTSUPP` and never reaches the target. tmpfs has it; hostfs does not. Setting times through a link follows it in the kernel, so `setattr` gets the target. `ranges` (driver protocol 1.1) promises that a write lands in the file at once, with no copy of the whole file on `open` or `release`, and that `setattr` takes `size`.
- **Caching:** the kernel caches attributes and listings for those TTLs, and a driver can push `invalidate` for changes made outside.
- **File contents:** on a mount with `ranges`, as `tmpfs` is, and on the root file system when it is in OPFS (in a browser with sync access handles) or an in-memory root, a program reads and writes a file in 64 KiB pages: reads come from the driver 1 MiB at a time, and changed pages go back in 1 MiB runs once 8 MiB have changed, at `fsync`, and when the file is closed (from the kernel's own descriptors also 250 ms after a write). A file of any size the mount can hold works, with memory to spare for about one more copy of it. In OPFS a write opens a sync access handle for just that write. Elsewhere (`fsa` mounts, `hostfs` with an older proxy, and a root outside OPFS), file contents are read whole when a program opens a file and written back when it closes it. Both give close-to-open consistency, as NFS has. A process that ends without closing its files keeps what it wrote: on exit, on a trap, and when a signal kills it. For a killed WASI program, the kernel lets its worker write its changed pages back before `waitpid` reports the death. The only exception is a worker that makes no call into the kernel for 2 seconds after the signal; it is stopped without that write-back.
- **Rules on a mount:**
  - a rename across mounts is `EXDEV`, so `mv` copies;
  - `df` reports each mount from its driver's `statfs`;
  - each mount has its own device number;
  - without `chmod` support, `chmod` succeeds and changes nothing;
  - a write or truncate that would make a file larger than `maxFile` fails with `EFBIG` at once and changes nothing, and `options.maxfile` (`"2G"`, or `"0"` for none) changes that limit for one mount;
  - `options.ro` makes any mount read-only: writes fail with `EROFS`;
  - a driver that crashes or doesn't answer within 30 s makes its mount's calls fail with `EIO`, and the mount is listed as `failed`.

### `/etc/fstab`

At boot the kernel mounts what `/etc/fstab` lists, in fstab(5) format: `source target type options` (the dump and pass fields are ignored), with `#` comments and `\040` for a space in a field. Options are those of `mount -o`, and lines with `noauto` are left out.

```
none           /mnt/scratch  tmpfs   maxfile=1G   0 0
fsa:<id>       /mnt/folder   fsa     rw           0 0
project        /mnt/project  hostfs  ro           0 0
```

- **Boot never waits for it:** the lines are mounted in the background once the kernel has started, all at once, so a slow source holds up nothing.
- **Retries:** a line that fails is tried again after 1, 4 and 16 seconds (a driver package installed meanwhile, a mount point created later), except when it cannot succeed (`EINVAL`, `EBUSY`, `EPERM`, `EACCES`). `terminate()` stops the retries.
- **Failures are listed:** until it mounts, a line is in `kernel.mounts()` with state `pending`, and once it gives up with state `failed`, each with the last `error`. `/proc/mounts` and `mount` show the state in its options, as `none /mnt/bad nosuchfs rw,failed 0 0`. Unmounting a failed line's target takes it off the list. A line whose target another line mounted is not listed.
- **No user involvement:** an `fsa` line names a drive by its id: it comes up with the folder it had while its permission holds, and otherwise with no medium, asking the page for the folder through `onMountPending`, as any `fsa` mount does. With `media: false` the drive finds its folder only within the same kernel. With the default `media`, an `fsa` line reads its folder handle back from IndexedDB at boot, which crashes Chrome in an Incognito or other off-the-record profile ([#95](https://github.com/ai-ecoverse/slicc-kernel/issues/95)); a page cannot reliably tell it runs in one, so an embedder that cannot rule it out passes `media: false`, which keeps `fsa` lines in `/etc/fstab` safe. A `hostfs` line waits only for its first connection, and comes up with no medium if the proxy is not there yet.

### Removable media: `fsa`

An `fsa` mount is a drive for a local folder, from the File System Access API, and the folder is its medium.

- **Mounting** never waits for the user. `kernel.mount({ type: 'fsa', source: 'none', target })` mounts the drive with no medium:
  - it is listed in `/proc/mounts` and by `kernel.mounts()` with state `nomedium`;
  - `df` shows it with size 0;
  - the mount point is an empty directory, and every other operation under it fails with `ENOMEDIUM` ("No medium found");
  - WASI has no `ENOMEDIUM`, so WASI programs get `ENODEV` ("No such device"), the nearest errno.
- **Insert request:** at the same time the kernel calls the page's `onMountPending({ target, source, insert })`, so the page can show "Insert a folder for /mnt/x" with a button.
- **Inserting:** calling `insert()` from that button's click picks the folder with `requestDirectory()`, or asks for permission again on a folder the drive had before. The medium goes in without a remount, and the state becomes `ok`. `kernel.insert(target, handle)` inserts a handle the page already has.
- **Persistence:** the drive's source is `fsa:<id>`, and the kernel keeps the folder's handle under that id in IndexedDB (`<metadata>:media`). Mounting `fsa:<id>` again, after a reboot too, inserts the folder at once while its permission holds, and asks again when it is back to `prompt`. In an Incognito window Chrome crashes a page that reads a folder handle back from IndexedDB ([#95](https://github.com/ai-ecoverse/slicc-kernel/issues/95)). Pass `media: false` there: the kernel then never opens the handle database, and keeps the handles in memory, so a remount finds its folder only within the same kernel, while POSIX metadata still persists. `metadata: false` keeps the handles in memory too.
- **Ejecting:** `umount` ejects. So does the permission going away: the next operation fails with `ENOMEDIUM` and the kernel asks again. The folder is untouched either way.
- **Limits:** the folder has no symlinks or modes, and `df` reports no size for it either.

### Host folders: `hostfs`

A `hostfs` mount is a folder exported by the local proxy ([slicc-node](https://github.com/ai-ecoverse/slicc-node) or slicc-swift), with no picker and no permission prompt. The protocol is specified in [slicc-node#13](https://github.com/ai-ecoverse/slicc-node/issues/13).

- **Grants:** `kernel.mount({ type: 'hostfs', source: 'project', target: '/mnt/project' })` asks the page's `hostfs(source, { readonly })` hook for a grant. The page holds the proxy key and asks the proxy (`POST /api/hostfs/grant`) for a token scoped to that one folder. The kernel sees only `{ url, token }`, never the proxy key, and the token never appears in mount options or `/proc/mounts`. When the proxy refuses a token, the kernel asks the hook once for a new one.
- **Options:** `ro` mounts read-only, and `maxfile` caps file size as on any mount. There is no other size limit: reads and writes go in `maxIo` pieces (16 MiB unless the proxy says otherwise), so a file of any size the host can hold works. A proxy that advertises `ranges` in its grant (slicc-node 2.4, slicc-swift 1.4) makes the mount ranged, so programs read and write its files in pages and truncate through `setattr` `size`. With an older proxy files go whole, and a truncate on a ranged mount whose proxy was replaced by an older one is done by rewriting the file.
- **Changes on the host** arrive as invalidations on a watch stream (`POST /api/hostfs/watch`), so an edit made outside shows up on the next access without a remount.
- **Proxy loss:** when the watch stream ends, or is silent for 45 s, the kernel reconnects once at once. If that fails, the mount is `nomedium`, as with [removable media](#removable-media-fsa): operations fail with `ENOMEDIUM` (`ENODEV` for WASI), and the kernel keeps reconnecting with backoff (1 s to 30 s), so the folder comes back by itself when the proxy does. A mount made while the proxy is down starts as `nomedium`, and so does one whose grant or first watch takes more than 15 s; it comes up by itself when they arrive.
- **Consistency:** a file that changes on the host while a program reads it fails with `ESTALE`, and the kernel restarts the whole read (up to 3 times) instead of stitching two versions together. On a ranged mount an open file keeps the version it was opened at (its ETag) until it writes, also when it is handed to a child process: a page fetched after the host changed the file fails the program's read with `ESTALE` ("Stale file handle") instead of mixing versions. A file deleted on the host while a program holds it open fails the next read that goes to the host with `ENOENT`, not with NFS's `ESTALE`.
- **Node:** a page's requests carry its `Origin`, and slicc-node grants a token to that origin only. Node's `fetch` sends none, so a Node embedder passes `createNodeKernel` the origin its `hostfs` hook asked for the grant with, as `hostfsOrigin`, and the kernel adds it to every hostfs request. Without it the mount stays `nomedium`. `hostfsFetch(url, init)` replaces the `fetch` those requests use (for an agent or a test proxy), and gets the `Origin` too when both are given.

### Mounting from a program

Programs mount and unmount with `mount(2)` and `umount2(2)`, so a `mount`/`umount` package works as on Linux. They reach the same table as `kernel.mount` and `kernel.umount`, with the same types, insert requests and grants: `mount -t fsa none /mnt/x` returns at once with the drive in the `nomedium` state, and `mount -t hostfs project /mnt/p` asks the page's `hostfs` hook. The grant's token never reaches the program.

- **Emscripten:** `Module.sliccKernel.mount(source, target, fstype, flags, data)` and `Module.sliccKernel.umount2(target, flags)` return `0` or a negative errno. A relative target is taken from the program's cwd.
- **WASI:** the import module `slicc` has `mount(source, source_len, target, target_len, fstype, fstype_len, flags, data, data_len)` and `umount2(target, target_len, flags)`, with UTF-8 strings as pointer and length, and return a preview1 errno. Kernels without them answer `ENOSYS`.
- **Flags:** `MS_RDONLY` sets `ro`. `MS_NOSUID`, `MS_NODEV`, `MS_NOEXEC`, `MS_SYNCHRONOUS`, `MS_DIRSYNC`, `MS_NOATIME`, `MS_NODIRATIME`, `MS_SILENT`, `MS_RELATIME`, `MS_STRICTATIME` and `MS_LAZYTIME` are accepted and change nothing, and the old `MS_MGC_VAL` magic is dropped. Remounts, bind and move mounts, and any other flag are `EINVAL`.
- **Options:** `data` is the `-o` string, such as `ro,maxfile=1G`. `key=value` and `key` become `options`, `rw` cancels `ro`, and generic words (`defaults`, `noatime`, `nofail`, …) are dropped. A bad `maxfile` is `EINVAL`.
- **Unmounting:** `umount2(target, 0)` fails with `EBUSY` while a file is open under the mount. `MNT_DETACH` (`umount -l`) and `MNT_FORCE` unmount anyway: the mount leaves the table and `/proc/mounts` at once and its driver stops, and descriptors still open on it fail with `EIO`, without ever writing to the directory below.
- **Waiting:** `mount` waits for the mount to be made, which for `hostfs` is the grant and the first watch, up to 15 s. A signal ends the wait with `EINTR`, and a mount that is made after that is unmounted again.
- **Policy:** seven is single-user and every program runs as uid 1000, so any program may mount, unless the page passes `processMounts: false` (then every call fails with `EPERM`) or a function. The function gets `{ op: 'mount' | 'umount', pid, target, type?, source?, options? }` and returns whether to allow it. Whatever the policy, the kernel refuses mounts on `/` and on or under `/proc` and `/dev` with `EBUSY`.
- **Errors** are Linux's: `ENODEV` for an unknown type (or `hostfs` without a hook), `ENOENT` and `ENOTDIR` for the target, `EBUSY` for a target that is mounted already, and `EINVAL` for unmounting what is not a mount point.
- **`/proc/mounts`** escapes spaces and backslashes as Linux does, and adds `nomedium` or `failed` to the options of a mount in that state.

### Exec

An exec'd program takes over the pid of the process it replaces, as on Linux: `getpid()` and `$$` in the new image, `/proc`, `ps`, `kill` and the parent's `waitpid` all agree on that pid, and the image's parent pid is the replaced process's. Its own children see that pid as their parent. A file removed or renamed over while programs hold it open keeps its bytes for them, as on Linux: the kernel keeps one copy for all holders, shared by their descriptors (writes through one are seen through the others), and frees it when the last one closes. Signals a program ignores stay ignored in the image it execs and in the children it spawns or forks, as POSIX has it, so `nohup cmd` and `trap '' TERM; exec cmd` keep `cmd` safe from them; caught signals go back to their default. The kernel holds what was handed down, so a new image that sets one of those signals back to the default with `signal(SIG_DFL)` still ignores it, until it installs a handler.

- **Emscripten:** `Module.sliccKernel.execve(file, argv, env, cwd)` runs `file` as this process's new image on its fds 0, 1 and 2, waits for it, and returns its wait status, or a negative errno when it cannot start. `env` and `cwd` may be `null` for this process's own. An exec shim detects it with `typeof Module.sliccKernel.execve === 'function'` and exits with the status it returns, as `execve` never returns on success. Older shims spawn the program and then call `Module.sliccKernel.execWait(pid)`; that works the same way: a new program asks the kernel for its pid before `main`, and the kernel answers once its parent has made its next call, so an image an older shim execs also reports the pid it replaced (the wait starts once the program is loaded; should the parent make no call within 100 ms after that, the kernel answers anyway, and the image may then report its own pid; `launcher.identities` counts the programs that asked and those answered by that timeout).
- **WASIX:** `proc_exec` does this by itself.

### `/proc`

Every process of the kernel has `/proc/<pid>/` with `cmdline`, `comm`, `stat`, `statm` and `status`, in the formats procps reads, and `/proc/self` is a link to the `/proc/<pid>` of the process that reads it, as on Linux (`readlink /proc/self` is its pid, the one it was exec'd under included). They come from the kernel's process table when they are opened, so a terminal sees the processes of every client; an exec'd program shows under the pid its parent knows. `/proc/uptime`, `/proc/loadavg`, `/proc/stat` and `/proc/meminfo` are there too, and `/proc/mounts`. A process with no parent in the kernel (one a page, a client or the Node entry started) has parent 1, as children of init do, in `getppid()`, `/proc/<pid>/stat` and `ps` alike, and so does a process whose parent has ended, waited for or not (`getppid()` asks the kernel each time; a shell's `$PPID` keeps the value it started with, as on Linux). Pids, parents, process groups, sessions, command lines, terminals, start and boot times are real, and so is each process's memory: the size of its wasm memory (`VSZ` and `RSS` alike, as wasm has no paging), which `/proc/meminfo` counts as used. CPU times, load and `MemTotal` (from `navigator.deviceMemory`, else 4 GiB) are placeholders. Only Emscripten processes see this `/proc`.

While OPFS has no `/etc/passwd`, `/etc/group` or `/etc/mtab`, reading them gets per-process ones: root is uid 0 and the realm user, uid 1000, is named after `USER`, or `web_user` (Emscripten's default) without one, so it matches `$USER`, with `HOME` as its home, so `id`, `whoami`, `ls -l` and `ps` show names. Nothing is written to OPFS, and a real file there wins.

### Metadata

OPFS stores names, bytes, sizes and modification times, nothing else. Everything POSIX needs on top of that lives in an IndexedDB sidecar, so it survives reloads and new kernels:

- mode bits (`chmod`);
- access and change times, and a modification time set explicitly with `utime` (it holds until the file is written again);
- inode numbers that stay stable across renames;
- symbolic links (`symlink`, `readlink`, `lstat`, and following them in paths), which exist only in the sidecar, with their own times: `touch -h`, `lutimes` and `utimensat` with `AT_SYMLINK_NOFOLLOW` set the link's, never the target's. A link's own mode can't be changed, as on Linux: `chmod -h`, `lchmod` and `fchmodat` with `AT_SYMLINK_NOFOLLOW` fail with `EOPNOTSUPP` (which `chmod -h` and `tar` ignore for links) and never follow it, and `open` with `O_PATH | O_NOFOLLOW` gives a descriptor for the link itself.

OPFS stays authoritative: an entry is consulted only for a path that exists in OPFS (symlinks only for paths that don't), so files written straight to OPFS, for example by the BIOS installer or a page, get the defaults: directories `0755`, files `0644`, and files under `node_modules/*/bin/` `0755`. A file deleted through the OPFS API disappears at once; its leftover entry is ignored and removed when the next kernel starts. Changes go to OPFS first and then to the sidecar, so a crash in between at worst loses the metadata of that one change. Each change is a read-modify-write inside one IndexedDB transaction, so two kernels (two tabs) on the same origin don't lose each other's updates.

The database is `slicc-kernel` (or the `metadata` option), schema version 1, with one object store, `entries`, keyed by absolute path (`keyPath: 'path'`) and an index `dir` on the parent directory of symlinks. A record looks like `{ path, mode?, atimeMs?, mtimeMs?, mtimeFor?, ctimeMs?, ino?, link?, dir? }`, where `mtimeFor` is the OPFS `lastModified` an explicit `mtimeMs` belongs to. A future schema bumps the version and migrates in `onupgradeneeded`; an older kernel then closes its connection. The sidecar is keyed by path from the `root` handle, so use a different `metadata` name for each distinct root.

Not covered: hard links (they fail with `EMLINK`, as Emscripten reports; OPFS cannot share contents between names) and file ownership. Emscripten's `chown` doesn't pass the owner to filesystem backends, so there is nothing to store, and processes see every file as owned by uid and gid 1000. Emscripten also doesn't enforce permission bits, so a file runs whether or not its exec bit is set; the bits are what `ls`, `stat` and `test` report.

Reads retry briefly when a concurrent write has invalidated the OPFS file snapshot (`NotReadableError`).

A kernel caches the directory handles it has walked and the sidecar entries it has read. Its own changes keep both caches current, and the other kernels on the origin hear of them through a `BroadcastChannel` named after the database (one for the sidecar, one for directories). A cached directory is checked against its path (`resolve()`) at most once a second before a lookup goes through it, so a directory moved, removed or replaced by another writer, such as a page using the OPFS API, is found at its new place or reported missing within a second.

The filesystem is our own rather than [ZenFS](https://github.com/zen-fs/core) (which SLICC uses), because OPFS stays the single source of truth: other writers, such as the BIOS installing packages or a page writing files, need no index to stay consistent with, and nothing is preloaded into memory at mount. POSIX metadata lives in the IndexedDB sidecar described above, which has per-entry transactions instead of one JSON file rewritten on every change.

## What is in here

The kernel is ported from SLICC's `packages/webapp/src/kernel/` with the browser-specific VFS replaced by an OPFS one:

- `src/kernel/`: the kernel side, per process (`host.ts` starts the worker and answers its syscalls in `process.ts`) and shared tables (descriptors, pipes, children, jobs, signals, terminals and pseudo-terminals, `select`).
- `src/process/`: the runtime inside each process worker. It evaluates the Emscripten glue, mounts the live VFS, routes descriptors through the kernel and implements `fork` by copying the whole linear memory into a new worker (Asyncify). `fork` is the only call allowed to suspend through Asyncify: an `fsync` that Emscripten made asynchronous is answered synchronously by the file's own stream instead. `src/process/wasi/` runs WASI and WASIX programs.
- `src/realm/`: the synchronous bridge (`SharedArrayBuffer` + `Atomics.wait`) and the live Emscripten filesystem on top of it.
- `src/fs/`: the OPFS filesystem and the virtual command directories.
- `src/launcher.ts`, `src/commands.ts`, `src/serve.ts`, `src/index.ts`: command resolution, the kernel worker protocol and the page API; `src/node.ts`, `src/node-process-worker.ts` and `src/node/` the headless Node entry. An embedder that uses `Launcher` directly, without `createKernel`, calls `await launcher.prepare()` first: it creates `/tmp` and `/home` and writes the CA certificate.
- `src/kernel/net/`: the proxy, HTTP/1.1, TLS termination and the local CA, and the bridge to the page's transport; `src/transport.ts` and `src/local-proxy-transport.ts` are the page side.
- `src/cdp/`: the CDP facade on `127.0.0.1:9222`, its WebSocket framing, the registry of hosts and the `MessagePort` bridge to them.


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

`tools/big-file.mjs [bytes]` is a manual check, not part of any suite. It writes a file of that size (64 MiB by default) through a tmpfs mount with the unit-test launcher, reads it back, and prints the peak RSS and its ratio to the file size. A 256 MiB file peaks at about 1.8 times its size. Before ranged I/O (#127), a 1.1 GiB file peaked at 18 GB of RSS. **Do not run it past 1 GiB on a workstation.** It refuses anything over 256 MiB unless `SLICC_BIG_FILE_I_HAVE_THE_RAM=1` is set. Measure a small file and extrapolate instead. The unit suite checks a 32 MiB file the same way, and allows a fixed 192 MiB for garbage V8 has yet to collect, which dominates at that size.

Releases are cut by semantic-release on every push to `main`. A failure after the version is tagged (a rejected push, a failed `npm publish`) doesn't strand that version: `tools/release-recover.mjs` runs next. For any version tagged at HEAD, it first pushes the tag if origin lacks it, then publishes the version if npm lacks it, with retries, and creates its GitHub release if that is missing too. Re-running the Release workflow completes such a version the same way.

## License

Apache-2.0
