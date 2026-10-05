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
| `worker` | `new URL('./kernel-worker.js', import.meta.url)` | the kernel worker script |

### `kernel.run(argv, options?) → Promise<{ status, stdout, stderr }>`

Runs `argv[0]` with `argv` as its arguments and resolves when it exits. `stdout` and `stderr` are decoded as UTF-8; `status` is the exit status, `128 + n` for a process killed by signal `n`, and `127` when `argv[0]` cannot be found.

| option | |
| --- | --- |
| `cwd` | working directory, default `/`; created in OPFS if missing |
| `env` | extra environment; the defaults are `PATH=/usr/bin:/bin`, `HOME=/`, `PWD=<cwd>` |
| `stdin` | a string or `Uint8Array`; without it stdin is `/dev/null` |
| `onStdout`, `onStderr` | called with each chunk of text as it is written |

### `kernel.terminate()`

Stops the kernel worker and every process. Pending and later calls reject.

## Commands

Commands come from installed packages in npm's `node_modules` layout: every `<modules>/<name>/package.json` and `<modules>/@scope/<name>/package.json` with a `slicc.commands` block (`abi` `emscripten`), for example bash's:

```json
{ "slicc": { "abi": "emscripten", "commands": { "bash": { "glue": "bin/bash", "wasm": "bin/bash.wasm" } } } }
```

Entries may also set `argv0`, `args` and `env` (with `${package}` expanded to the package directory), and a package-wide `slicc.env`. The first package to define a name wins. `sh` runs bash as `sh` unless a package provides its own. The installed commands appear as executables in a virtual `/usr/bin` and `/bin`, so `PATH` lookups, `command -v` and `ls /usr/bin` work without writing anything to OPFS. A process can also run a program by the path of its glue when the `.wasm` sits next to it, and a script through its `#!` line (including `#!/usr/bin/env name`). The catalog is re-read at the start of every `run`, so packages installed in between are picked up.

## Filesystem

`/` is the OPFS root. Each process mounts the top-level directories that exist when it starts (plus `/usr` and `/bin`), so files in them are shared by all processes and visible through the OPFS API as soon as the process that wrote them has closed them; `run` resolves only after that. `/tmp`, `/dev`, `/proc` and anything created directly in `/` while a process runs live in that process's memory unless the directory already exists in OPFS. File contents are buffered per open file and written back on close, `fsync` and exit; metadata operations (`mkdir`, `rename`, `rm`, …) go straight to OPFS. The kernel worker is the only writer.

OPFS stores no POSIX metadata, so modes are synthesized: directories `0755`, files `0644`, and files under `node_modules/*/bin/` `0755`. `chmod` and `utime` are remembered for the lifetime of the kernel worker. Symlinks are not supported (`ENOSYS`). Directories are renamed with `FileSystemHandle.move()` where available, else by copy and delete.

## What is in here

The kernel is ported from SLICC's `packages/webapp/src/kernel/` with the browser-specific VFS replaced by an OPFS one:

- `src/kernel/`: the kernel side, per process (`host.ts` starts the worker and answers its syscalls in `process.ts`) and shared tables (descriptors, pipes, children, jobs, signals, terminals and pseudo-terminals, `select`).
- `src/process/`: the runtime inside each process worker. It evaluates the Emscripten glue, mounts the live VFS, routes descriptors through the kernel and implements `fork` by copying the whole linear memory into a new worker (Asyncify).
- `src/realm/`: the synchronous bridge (`SharedArrayBuffer` + `Atomics.wait`) and the live Emscripten filesystem on top of it.
- `src/fs/`: the OPFS filesystem and the virtual command directories.
- `src/launcher.ts`, `src/commands.ts`, `src/serve.ts`, `src/index.ts`: command resolution, the kernel worker protocol and the page API.

SLICC's networking (sockets, the TLS proxy) and WASI support are not included.

## Development

```sh
npm install
npm run lint
npm test
npm run test:unit
```

`npm test` builds `dist/` and runs the integration tests in Chromium from `playwright-core`, over raw CDP, against a cross-origin isolated test page that installs bash and coreutils into OPFS. Each test writes screenshots, console logs and CPU profiles to `artifacts/`; V8 coverage from the page and every worker, mapped back to `src/` through the source maps, goes to `coverage/`, and `artifacts/hotspots.md` lists where the time went.

Unit tests live in `test/unit/`, which stays out of git. They run real wasm bash and coreutils through the whole stack in Node `worker_threads` against an in-memory OPFS. The pre-commit hook runs them under coverage and requires every changed line in `src/` to be covered.

## License

Apache-2.0
