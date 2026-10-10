# `node` and `.jsh` on JS programs

Status: **design; Lars answered its questions on 2026-10-10** (see "Decisions" at the end). Tracks [slicc-kernel#68](https://github.com/ai-ecoverse/slicc-kernel/issues/68). Builds on `abi: "js"` ([#174](https://github.com/ai-ecoverse/slicc-kernel/pull/174)).

Lars decided on 2026-10-09 to rebuild #68 on JS programs instead of porting slicc 6's JS realm as it is. This note says how `node` and `.jsh` map onto JS programs, what the kernel has to add, which Node APIs the shim offers, how modules resolve, and what is out of scope.

## What slicc 6 does

`node -e`, `node file.js`, `.jsh` scripts and workflows all run in one JS realm, a dedicated worker per run, with these pieces:

- **Modules:** a synchronous CJS module system over a module graph the host resolves. ESM entries are lowered to CJS.
- **Sync calls:** `readFileSync` and friends read a snapshot of the VFS taken before the script starts, flushed at exit. `execSync` goes over a sync-XHR bridge to the Service Worker. Stdin is buffered whole.
- **Shims:** `fs`, `path`, `crypto` (md5/sha1/sha256 in pure JS), `child_process`, `process`, `console`, `buffer`, `assert`, `util`, `events`, `os`, `stream` (stubs without backpressure), `tty` (`isatty` always false), `url`, `module`, `zlib` (pako) and a best-effort `vm`.
- **Interception:** a `playwright` shim over CDP, a list of native packages that are refused, and `sliccy:` capability modules (`exec`, `agent`, `browser`, `skill`, `http`, `usb`/`serial`/`hid`, `computer`, plus the pure helpers `cli`, `color`, `time`, `fmt`, `pool`).
- **`.jsh` globals:** a `.jsh` script runs in an async wrapper with `process`, `console`, `fetch`, `require`, `Buffer`, timers, `__dirname`/`__filename` and `module`/`exports`.

Most of the workarounds exist because the realm is not a process. It has no descriptors, no pipes, no blocking calls, and no live view of the file system. A JS program has all of those, so the shim can be thinner and more faithful.

## The mapping

| v6 realm | on JS programs |
|---|---|
| a realm per run | a **process** per run: `node` and `jsh` are `abi: "js"` commands in a package |
| `.jsh` dispatched by the shell | **a `.jsh` file is executable**: the kernel runs it with `jsh` (see "binfmt" below), so `./x.jsh`, `PATH` lookup and `#!` all work |
| sync fs from a snapshot | **real sync calls** on a blocking syscall lane: `readFileSync` sees the live file, and `writeFileSync` is durable when it returns |
| `execSync` over sync XHR | **`ctx.spawn` plus a blocking wait** on that lane; the child is a real process with pipes |
| buffered stdin | streaming stdin over fd 0, with `setRawMode` on a terminal |
| `tty.isatty` always false | `ctx.isatty(fd)` |
| stream stubs | real Node streams (`readable-stream`) over fds, with backpressure |
| exits when the script's promise settles | **exits when the event loop is empty**, as Node does (the shim counts handles; see below) |

## What the kernel adds (in slicc-kernel)

Each item is generic, released and certified like other kernel features. None of them is specific to Node.

1. **A blocking lane: `ctx.sync`.** Node's sync APIs (`readFileSync`, `execSync`, `require` of a CJS file) must block the worker's thread. The async lane can't serve them: while an async call holds the SAB, a blocking call has nowhere to go, and the async call's continuation can't run while the thread is blocked. So a JS process gets **a second SAB and responder**, the way WASI threads have their own today. `ctx.sync` offers the same calls as the context (`read`, `write`, `open`/`pread`/`pwrite`, `fs.*`, `wait`) and returns values instead of promises, using `Atomics.wait`. A caught signal interrupts a blocked sync call with `EINTR`, the same as for WASI programs; the handlers run when the call returns.
2. **Processes: `ctx.spawn`, `ctx.wait`, `ctx.kill`.** These match the imports context: `spawn({ argv, env, cwd, stdin, stdout, stderr })` with `'inherit' | 'pipe' | 'null' | fd` for each stdio, returning `{ pid, stdin?, stdout?, stderr? }` as descriptors. `wait(pid)` comes in both lanes, and `kill(pid, sig)` too. `child_process` builds on them.
3. **Network: `ctx.fetch`.** A `fetch` over the kernel's transport (the `net-request`/`net-read`/`net-close` syscalls), so it follows the same rules as every program's HTTP. The worker's own `fetch` stays withheld. The shim installs `ctx.fetch` as the global `fetch`.
4. **Terminal: `ctx.tty`.** Get and set termios (raw mode) and read the window size; `SIGWINCH` arrives through the existing signal handlers.
5. **binfmt.** A package can map a file suffix to an interpreter command: `"slicc": { "binfmt": { ".jsh": "jsh" } }`. Exec of a non-wasm file with that suffix and no `#!` runs `jsh <path> args…`, as execve with a shebang would. `#!` still wins. This is generic: `.py` → `python3` would work the same way, if anyone wants it.
6. **Sockets: `ctx.listen` and `ctx.connect`.** Listeners and connections on the kernel loopback, the same sockets WASIX servers use. A JS server is reachable from other processes, as `<port>.kernel.localhost` from the page and through `loopbackFetch`. The design is in [a comment on #68](https://github.com/ai-ecoverse/slicc-kernel/issues/68#issuecomment-6095035961). `net` and `http.createServer` build on it.
7. **Module loading: `ctx.loadModule(path)`.** It imports a VFS file as an ES module from a `blob:` URL, and takes a resolver for its specifiers (see "Modules"). The `data:` import the runtime uses today can't resolve relative imports.

Items 1, 2 and 5 are merged (#222, #229, #218, #214, #224). Item 3 is in review, and WebSocket over the same transport follows it. Items 4, 6 and 7 come next.

## The shim (its own package)

`node` and `jsh` are commands of one package, **`@ai-ecoverse/slicc-jsh`**, in its own repo ("slicc-node" is taken by the local proxy). It is ported from slicc's realm (Apache-2.0) and changed where JS programs make the real thing possible.

- **`process`:**
  - `argv`, `argv0`, `env`;
  - `cwd()` and `chdir()`; the cwd is tracked by the shim and passed to children and to path resolution;
  - `pid` and `ppid`;
  - `exit()`, `exitCode`;
  - `stdin`/`stdout`/`stderr` as real streams (`isTTY`, `setRawMode`, `columns`/`rows`);
  - `on('SIGINT' | 'SIGTERM' | …)` through `ctx.signals`;
  - `kill(pid, sig)`;
  - `nextTick`, `hrtime`/`hrtime.bigint`, `memoryUsage` (best effort), `platform: 'linux'`, `arch`, `versions.node` (a stated Node level, such as 22.x);
  - `emitWarning`, and `on('exit' | 'beforeExit' | 'uncaughtException' | 'unhandledRejection')`.
- **`fs` and `fs/promises`:**
  - promise, callback and sync forms over `ctx` and `ctx.sync`;
  - a **real descriptor table** (`open`/`openSync`, `read`, `write`, `fstat`, `close`), plus `createReadStream`/`createWriteStream`;
  - symlinks (`symlink`, `readlink`, `lstat`, `realpath`), `Dirent`s, `mkdtemp`, `cp`, `appendFile` (atomic through `O_APPEND`) and `utimes`.
  - `watch` comes later, over the kernel's `fs.watch`.
- **`child_process`:**
  - `spawn`, `exec`, `execFile` and `fork`-free `spawnSync`/`execSync`/`execFileSync`, over `ctx.spawn`/`wait`/`kill`;
  - the children are real processes, so their pipes, exit codes, signals and `cwd`/`env` follow Node's rules;
  - `shell: true` runs `sh -c`.
- **Ported mostly as they are:** `path`, `events`, `util` (with `parseArgs`, `inspect`, `promisify`, and `types` added), `assert`, `buffer` (feross `buffer`), `url`, `querystring`, `string_decoder`, `os`, `readline` (now over a real stream), `tty`, `timers`/`timers/promises` and `module`.
- **`stream`:** `readable-stream` (MIT), Node's own stream code, with backpressure, so `pipe` and `pipeline` behave.
- **`crypto`:** `randomBytes`/`randomUUID`/`webcrypto`/`subtle` and `createHash`/`createHmac` for md5, sha1, sha256 and sha512. The SHA family uses WebCrypto for one-shot digests, with a pure-JS fallback for streaming `update()`. Ciphers, signing and KDFs other than `pbkdf2` stay out.
- **`zlib`:** `pako` for the sync and callback forms. The streaming classes come for free through `readable-stream`.
- **`http`/`https`:** the client (`request`/`get`) over `ctx.fetch`, and `http.createServer` over `ctx.listen`, with HTTP/1.1 parsed in the shim. **`net`:** `net.createServer`, `net.connect` and `net.Socket` over `ctx.listen`/`ctx.connect`. Servers are in the first milestone (decision 5). `tls` servers stay out.
- **`.jsh`:** `jsh script.jsh args` runs the script in v6's async wrapper. The globals are the same: `process`, `console`, `fetch`, `require`, `Buffer`, timers, `__dirname`/`__filename`, `module`/`exports`, and `process.argv.parseFlags()`. A `.jsh` from slicc 6 runs unchanged when it uses only those globals and the pure `sliccy:` helpers.
- **`sliccy:` modules:**
  - `cli`, `color`, `time`, `fmt` and `pool` ship in the shim;
  - `exec` is a thin layer over `child_process`;
  - **the embedder provides the rest** (`agent`, `browser`, `skill`, `http`, `usb`/`serial`/`hid`, `computer`): `sliccy:<name>` resolves to the first `sliccy-<name>` package found the usual way (for example `@ai-ecoverse/sliccy-agent`, shipped with slicc-agent);
  - an unknown name throws, as in v6;
  - the shim knows nothing about the agent.
- **The event loop and exit:** the shim keeps Node's rule. The program exits when no handle is left: a timer, an interval, a stream reading or writing, a child process, a server, a pending `fetch`. It counts handles with `ref`/`unref` and resolves the JS program's `main` only then. `process.exit()` exits at once (after pending writes, as `ctx.exit` already does).

## Modules

- **CommonJS:** a synchronous `require` over `ctx.sync`, with Node's algorithm:
  - relative paths, then `node_modules` up the directory tree, then `$NODE_PATH`;
  - `package.json` `main` and `exports` (conditions `require`, `node`, `default`), `.js`/`.cjs`/`.json`, and directory `index` files;
  - `require.resolve`, `require.cache` and `module.createRequire`;
  - files are read live, with no snapshot.
- **ES modules:** real ESM, not lowered to CJS. The shim reads a module through `ctx.sync`, finds its specifiers with `es-module-lexer` (MIT, small wasm), rewrites each one to the `blob:` URL of its resolved target, and imports through `ctx.loadModule`.
  - Resolution follows Node's ESM rules (`exports` conditions `import`, `node`, `default`; no directory indexes or bare extensions).
  - `node:` builtins map to the shim's modules through a generated wrapper.
  - `import.meta.url` is the module's `file:` URL; `import.meta.dirname`/`filename` are set too.
  - Top-level await and live bindings work, because this is real ESM.
  - Which files are ESM: `.mjs`, or `.js` under `"type": "module"`. `node --input-type=module -e` works too.
- **`require()` of ESM:** Node 22 can `require()` a synchronous ES module. With `blob:` imports that can't be synchronous, so `require()` of an ES module throws `ERR_REQUIRE_ESM` with a hint to use `import()`. This is the one deliberate gap in module loading.
- **Native addons:** `.node` files, and the packages v6 refused, still throw with the same hint.
- **CDP:** a `playwright` package import keeps v6's shim as an embedder-provided module, the same as the `sliccy:` modules, not built into the shim.

## Out of scope (v1)

- **`tls` servers** and `https.createServer`. Plain `net` and `http` servers are in v1 (decision 5).
- `worker_threads`, `cluster`, `inspector`, `v8`, `dgram`, `dns` (beyond `lookup` of loopback names), and an isolated `vm`, since a worker can't create a realm synchronously. v6's best-effort `vm` comes along.
- `fork()`. JS programs can't fork; `child_process.fork` would need IPC channels over a pipe, which can come later.
- Native addons and WASI addons (`.node`).
- **npm itself** (`npm install` under the shim): pnpm is wasi-pnpm. **`npx <bin>` is in** (decision 4): it and `node_modules/.bin/*` scripts such as prettier and eslint run under the shim.
- **QuickJS code mode (pi-codemode):** kept separate, as #68 says; this shim doesn't touch it.

## Testing

- **Kernel:** each addition gets the `jstest` treatment, in unit tests on the Node launcher and in the Chromium integration suite.
  - The sync lane: a blocking read on a pipe while signals arrive, and sync and async calls interleaved.
  - spawn/wait/kill, with pipes both ways.
  - `fetch` through the kernel's transport, a mock in Node.
  - Raw mode and `SIGWINCH` on a terminal.
  - binfmt: `./x.jsh` with and without `#!`, and through `PATH`.
- **The shim:** v6's realm tests, ported. In addition:
  - small Node programs compared byte for byte with real Node 22 output (fs, streams, child_process, module resolution, ESM/CJS interop, `process.exit` timing);
  - and a set of real npm CLIs run from `node_modules`: prettier, eslint (flat config), typescript `tsc --noEmit`, marked, js-yaml.
- **The cert:** slicc 6's `.jsh` skills (`wiki.jsh`, `x_search.jsh`, the jshd examples) under `jsh` in Chromium, plus `node -e` with pipes and `^C` on a terminal.

## Decisions (Lars, 2026-10-10)

1. **Home:** its own repo, `@ai-ecoverse/slicc-jsh`, with commands `node` and `jsh`.
2. **Node version:** 22.x.
3. **`sliccy:` modules** come from `sliccy-<name>` packages, not from registration at `createKernel`.
4. **`npx`:** yes. `npx <bin>` and `node_modules/.bin/*` scripts run under the shim.
5. **Servers:** yes, in the first milestone. `net.createServer` and `http.createServer` on the kernel loopback, over `ctx.listen` (kernel item 6).
