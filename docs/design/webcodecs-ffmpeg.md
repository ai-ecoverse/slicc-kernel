# `ffmpeg` and `ffprobe` on WebCodecs

Status: **design, not approved**. Tracks [homescoop#97](https://github.com/ai-ecoverse/homescoop/issues/97).

## Problem and constraint

slicc 6 had `ffmpeg` and `ffprobe`. Seven (slicc-bios, the page that embeds this kernel) has neither. homescoop's `packages/ffmpeg` is retired: @ai-ecoverse must not distribute MPEG-family codec implementations (homescoop `docs/ladder-builds.md`, "Retired recipes"). On 2026-10-09 Lars chose the **WebCodecs bridge**: codecs come from the browser's own licensed implementations (`VideoDecoder`, `VideoEncoder`, `AudioDecoder`, `AudioEncoder`, `ImageDecoder`, and the canvas image encoders), and we ship no codec code.

This note covers where the commands run, how containers are handled, which command subset is realistic, how codec availability is reported, who owns what, and how it is tested.

## What slicc 6 did

slicc 6 (`packages/webapp/src/shell/supplemental-commands/ffmpeg/`, `ffprobe/` on slicc `main`) has one argv front end and two engines:

- **mediabunny** (`bunny-translate.ts`, `bunny-run.ts`, `bunny-probe.ts`). `bunny-translate.ts` is a pure function from argv to a plan. Options with no WebCodecs equivalent *reject*; they are never dropped silently. The plan covers codecs (h264, hevc, vp8, vp9, av1, aac, opus, mp3, vorbis, flac, pcm), `-c copy`, bitrates, `-crf`/`-q:a` mapped to mediabunny's five quality presets, `-ss/-t/-to`, `-vf scale/crop/transpose/fps`, `-s`, `-r`, `-g`, `-ac`, `-ar`, `-an`, `-vn`, `-movflags` and `-metadata`. The container comes from `-f` or the extension. `ffprobe` reads mediabunny's container index and renders slicc's `ProbeInfo` (`-of json|csv|default`, `-show_format`, `-show_streams`, `-show_entries`, `-select_streams`).
- **ffmpeg.wasm** (`@ffmpeg/core` 0.12.10, 31 MB, installed with `ipk`). This is the fallback for everything mediabunny declines: filter graphs, lavfi, image output, and codecs the browser lacks. It bundles x264, LAME and the rest. **That fallback is exactly what the constraint rules out.** It also had `-f avfoundation` camera capture through `getUserMedia`/`MediaRecorder` on the page.
- Two weaknesses: input was a `Blob` (a lazy native `File` when the VFS had one, otherwise a whole-file read), and output was mediabunny's `BufferTarget`, so the whole output file sat in memory. `bunny-run.ts` says as much: "Streaming the output to disk needs a VFS write stream".

So the mediabunny half is what we keep: the argv translator, the probe renderer and the "reject, never drop" rule. The wasm half goes. Where slicc 6 fell back to wasm, seven reports an error.

## Facts from the kernel that shape the design

- **Topology.** page → kernel worker (a dedicated worker; owns OPFS and the process table) → one nested dedicated worker per process (`process-worker.js`, run from a `blob:` copy). In Node, `worker_threads` take the same roles.
- **WebCodecs is exposed in `DedicatedWorkerGlobalScope`** in Chromium, nested workers included (`[Exposed=(Window,DedicatedWorker)]`), and so are `ImageDecoder` and `OffscreenCanvas`. A process worker can use them. Neither the kernel worker nor the page has to touch a frame. Node's `worker_threads` have none of these.
- **Process workers are synchronous.** A WASI or Emscripten program blocks its worker thread in wasm and makes syscalls through a `SharedArrayBuffer` and `Atomics.wait` (`src/realm/sync-sab-bridge.ts`). WebCodecs is callback- and promise-based. A wasm program that calls into WebCodecs from a host import cannot get its output callbacks while its thread is blocked, so any wasm-side bridge needs a second thread (see option B).
- **File I/O is already paged.** Open files are 64 KiB pages with 1 MiB readahead and positional `pread`/`pwrite` (`src/fs/ranged.ts`, `src/fs/pages.ts`). Random access into a multi-GB `.mp4` does not need the whole file.
- **There is already a program-imports hook.** A WASI command can name an ES module that gets `createImports(ctx)` with `fs`, `fds`, `syscall`, `spawn`, `wait`, `kill` and `async` (`src/process/wasi/wasi-imports.ts`, README "Program imports"). It runs in the process worker with the same trust as Emscripten glue.
- **Seven's commands are npm packages** installed into OPFS from `src/packages/package.json` and found by `slicc.commands`. Users can add more with `pnpm add -g`. Seven's page has no command code of its own.

## 1. Where the command runs

### (A) Host commands registered by the embedder

`createKernel({ commands: { ffmpeg: handler } })`, plus `client.serveCommand(name, handler)` for attached clients, as `serveCdp` does for CDP. The kernel makes a process with a pid, pgid and fd table but no worker, and relays argv, env, cwd, stdio, file access and signals to a page-side handler over a `MessagePort`.

- **Complexity: high.** The kernel needs a new kind of process with no worker. Today, signals, stop/continue, exit, `waitpid`, `/proc/<pid>`, `exec` into and out of a process, and fd inheritance all assume a worker plus a SAB. On top of that come a new client protocol version (1.6), a stream protocol with backpressure for stdio and ranged file I/O (the client `fs` today has whole-file `readFile`/`writeFile` only), and routing when several tabs offer the same command.
- **Data flow:** every byte crosses kernel worker → `MessagePort` → page (or a worker the page starts). Streaming works if the protocol is built for it; nothing like that exists yet.
- **Where WebCodecs runs:** on the page's main thread, which janks seven's UI, unless seven starts yet another worker for it.
- **Node:** `createNodeKernel({ commands })` with a fake handler.
- **Cancellation:** the handler gets an `AbortSignal` for SIGINT/SIGTERM. SIGKILL has to force the process to exit while page code keeps running.
- **Ownership:** the ffmpeg code lives in seven's page bundle and is versioned by seven's deploys, not by a package.
- **Only real advantage:** Window-only APIs (`getUserMedia`, `MediaRecorder`, `AudioContext`, permission prompts). The only ffmpeg feature that needs them is camera capture, which is out of scope (see section 3).

### (B) A `slicc_webcodecs` wasm import bridge

A WASI CLI does demux and mux in Rust or C and calls `slicc_webcodecs.*` imports to encode and decode frames.

- **The async problem.** The import runs on the blocked process thread, so WebCodecs has to live in a helper worker. Every frame is copied through a SAB: about 3 MB per 1080p I420 frame, twice per transcode, with the CLI's own thread parked in `Atomics.wait`. Workable, but slow and fiddly. Starting the helper worker also needs a turn of the event loop (Emscripten's pthread pool exists for this reason), so the imports module has to start it with top-level await before the program runs.
- **The container code has to come from somewhere.** Writing a Rust/C demux+mux CLI from scratch is the bulk of the work. Off-the-shelf choices are risky: symphonia bundles AAC/MP3 decoders; libavformat is FFmpeg, and building it without codecs is the "no-MPEG build" Lars declined, and it also carries h264/aac parsers.
- **B2, the high-fidelity variant:** real FFmpeg (fftools, libavformat, libavfilter, libswscale) built with no internal codecs, plus `*_webcodecs` AVCodec wrappers, the way `h264_videotoolbox` wraps VideoToolbox. This is the only route to real `-filter_complex`. It is still an FFmpeg build under @ai-ecoverse, which is the declined option, so it is listed only for completeness.
- **Node:** imports answer `ENOSYS`, so the error is clear but nothing works.
- **Cancellation:** default signals end the worker, as for any wasm program.
- **Verdict:** the most work for the least reach, and it pulls in exactly the code the constraint wants us to avoid.

### (C) Recommended: a JS program ABI, `"abi": "js"`

The kernel learns a third program ABI next to `emscripten` and `wasi`. A JS command is an ES module in an npm package. The kernel runs it in a **process worker of its own**, as a real process (pid, pgid, session, fds, `/proc`, `ps`, `kill`, job control, exit status). The worker's event loop is free because no wasm blocks it, so WebCodecs works there as it does in any dedicated worker.

```json
{ "slicc": { "commands": {
  "ffmpeg":  { "abi": "js", "module": "dist/ffmpeg.mjs" },
  "ffprobe": { "abi": "js", "module": "dist/ffmpeg.mjs", "args": ["--ffprobe"] }
} } }
```

```ts
export default async function main(ctx: JsProgramContext): Promise<number>;
```

**Kernel work (generic, nothing media-specific):**

- `commands.ts`: accept `abi: 'js'` with `module` (inside the package, like `imports`). `exec`, `posix_spawn`, `PATH`, `command -v` and the virtual `/usr/bin` work unchanged.
- `process-entry.ts`: a third branch, `init.program.abi === 'js'` → `import('./js/js-runtime.ts')` → `runJsProcess(init, port)`. The module is loaded the way the imports module is (read from the VFS, imported from a `data:`/`blob:` URL, same trust and CSP as today). v1 requires a self-contained bundle. `ctx.loadModule(relPath)` loads further files of the same package for lazy chunks.
- **An async syscall transport.** The same SAB wire as `createSyncSabTransport`, but it waits with `Atomics.waitAsync` (Chromium, and Node ≥ 16). Calls are serialized one at a time per process. A blocking read on an empty pipe or a write to a full pipe then parks a promise instead of the thread, so encoder callbacks keep running.
- **`JsProgramContext`** (first version):
  - `argv`, `env`, `cwd`, `pid`;
  - `stdin`, `stdout` and `stderr` as `ReadableStream<Uint8Array>` and `WritableStream<Uint8Array>`. Each chunk is one `fd-read`/`fd-write`, so the kernel's pipe backpressure reaches `await writer.ready`;
  - `isatty(fd)` and `fstat(fd)`. ffmpeg needs these to tell `-i - < in.mp4` (a regular file, seekable) from `cat in.mp4 | ffmpeg -i -` (a pipe, not seekable);
  - `files.open(path, flags) → { size, read(buf, position), write(buf, position), truncate, sync, close }`, over the existing `RangedFile` pages, plus `stat`, `readdir`, `mkdir`, `rename`, `rm` and `realpath`, all relative to `cwd`;
  - `signals`: `on(name, handler)` reports the signal as caught (the `SignalGate.report` path), so the kernel delivers it instead of ending the worker. Uncaught signals keep their default actions, and SIGKILL always terminates the worker. The kernel today sets `SAB_I_SIGNALS` with `Atomics.or` and no notify. The runtime needs an `Atomics.notify` there, so a program waiting on an encoder (not in a syscall) sees the signal at once;
  - `exit(code)`. If `main` rejects, the runtime prints `<argv0>: <message>` to stderr and the status is 1. A write to a pipe with no reader raises SIGPIPE (status 141), as for WASI programs.
  - Later, if a command needs them: `spawn`/`wait` (as in `ImportsContext`) and `net` (the `net-request` syscalls), which would allow `-i https://…`.
- **Not supported:** `fork`. A JS process's threads are its own `Worker`s, which the kernel does not track.

**How each concern plays out:**

- **Complexity: moderate, all in the kernel.** About 600–900 lines: the runtime, the async transport and the context. It reuses the process table, fd tables, the pager and signals as they are. No protocol version bump, because clients only see ordinary processes.
- **Data flow:** OPFS ↔ kernel worker (the only writer, as now) ↔ SAB window ↔ process worker. Input is mediabunny's `CustomSource` over `pread`, or `ReadableStreamSource` over a pipe. Output is mediabunny's `StreamTarget` with positional `pwrite`, or `AppendOnlyStreamTarget` over a pipe. Nothing buffers a whole file except the cases listed under "Memory" below.
- **Where WebCodecs runs:** in the command's own process worker, so each `ffmpeg` gets its own heap with no 2 GiB wasm limit. The kernel worker never sees a frame, and the page's main thread is never involved.
- **Node:** the same runtime on `worker_threads`. `typeof VideoEncoder === 'undefined'`, and the command says so (section 4). Container work (`ffprobe`, `-c copy` remux, PCM) still works there because it needs no codecs.
- **Cancellation:** ^C sends SIGINT to the foreground group. `ffmpeg` catches SIGINT and SIGTERM, calls `conversion.cancel()`, prints `Exiting normally, received signal 2.` and exits 255, as FFmpeg does. A second ^C, SIGKILL, or a `kill` without a handler terminates the worker; the browser then reclaims the codec instances. SIGTSTP stops the program at its next syscall, and since encoding stalls on I/O, `^Z`/`fg` behave.
- **Reach beyond ffmpeg:** about 80 of slicc 6's supplemental commands were page JS (`convert`, `pdftoppm`, `imgcat`, `say`, …). A JS ABI gives seven a packaged route for the ones that make sense, with no page code.

### (B′) A fallback that needs no kernel change

If a new ABI is not wanted yet, the existing imports hook can carry the same JS. Ship a ~100-byte WASI stub as `ffmpeg.wasm`. Its imports module starts a helper `Worker` during module evaluation (top-level await) that runs the same `main(ctx)`, and the stub thread just pumps that worker's syscall requests through a SAB. This works today, but every I/O chunk takes two hops, the stub is a fake program, and the helper worker is invisible to the kernel. It is useful as a prototype of the media side while (C) is reviewed. I don't recommend shipping it.

**Recommendation: (C).**

## 2. Container handling

**My reading:** demuxing and muxing (mp4/mov ISO BMFF, WebM/Matroska, Ogg, WAV/RIFF, FLAC framing, ADTS, MP3 framing, MPEG-TS) parses and writes *containers*. They are not codec implementations: no sample is decoded or encoded by our code. **This is a question for Lars, not an assumption.** The points that make it a real question are:

1. Several of these containers are MPEG standards: ISO BMFF/MP4 is MPEG-4 Part 12/14, and MPEG-TS is MPEG-2 Systems. ADTS and MP3 framing are part of the AAC and MP3 specs.
2. mediabunny's `codec-data.ts` parses and **rewrites H.264/HEVC bitstream syntax** in JS: SPS parsing (`parseAvcSps`, `parseHevcSps`), decoder-configuration records, NAL unit framing (Annex B ↔ length-prefixed, emulation prevention), `addAvcBitstreamRestriction` and `sanitizeHevcPacketForChromium`. It decodes no pictures, but it is more than a container.
3. Core mediabunny implements PCM sample-format conversion and **G.711 µ-law/A-law** in JS (`pcm.ts`). These are codecs, though trivial and not MPEG. Under "ship no codec code at all" they need an explicit yes, or the PCM paths get disabled.

**Library:** [mediabunny](https://github.com/Vanilagy/mediabunny) 1.61.3, **MPL-2.0**, by Vanilagy (not @ai-ecoverse). It is pure TypeScript with no WebAssembly in the core bundle, and its only dependencies are two `@types` packages. slicc 6 pins 1.61.0. Its optional extension packages *are* codec implementations and stay out: `@mediabunny/aac-encoder`, `@mediabunny/ac3` and `@mediabunny/dts` (libavcodec), `@mediabunny/mp3-encoder` (LAME), `@mediabunny/flac-encoder` (libFLAC, not MPEG but still a codec) and `@mediabunny/prores`.

**Who ships it.** There are two ways, and this is also a question for Lars:

- **Bundle** mediabunny into our package's single module (what the v1 loader wants). MPL-2.0 is file-level copyleft: we ship it unmodified, keep its licence notice and point to its source. @ai-ecoverse then redistributes mediabunny's container code.
- **Depend on it.** `mediabunny` is a normal npm dependency that pnpm installs as its own package, and the JS loader resolves bare imports through `node_modules`. @ai-ecoverse then redistributes none of it, at the cost of more kernel loader work: a `blob:` module graph with bare-specifier resolution, or an import map for the process worker.

## 3. Command surface

These are realistic, mostly ported from slicc 6's mediabunny path:

| | |
|---|---|
| `ffprobe` | `-v`/`-loglevel`, `-hide_banner`, `-show_format`, `-show_streams`, `-show_entries`, `-select_streams`, `-of`/`-print_format json\|csv\|default\|flat`, `-count_packets`/`-show_packets` (packet index only, no decoding). Works on every container mediabunny reads, **even when the browser cannot decode the codec**. |
| transcode | one input → one output: `-c:v`/`-c:a`/`-codec`/`-vcodec`/`-acodec` with ffmpeg encoder names mapped (`libx264`/`h264` → avc, `libx265`/`hevc`, `libvpx`, `libvpx-vp9`, `libaom-av1`/`libsvtav1`, `aac`, `libopus`, `pcm_*`), `-c copy`, `-b:v`/`-b:a`, `-g`, `-r`, `-s`, `-ac`, `-ar`, `-f`/extension → container, `-metadata`, `-y`/`-n` (with the overwrite prompt on a tty) |
| trim | `-ss`/`-t`/`-to`, input- and output-side. Exact when re-encoding; with `-c copy`, from the previous key frame, as in FFmpeg |
| scale / fps | `-vf` with a small grammar: `scale=W:H` (`-1`/`-2`), `fps=N`, `crop=w:h:x:y`, `transpose=1\|2`, `hflip`, `vflip`, chained with `,`. Scaling is canvas-based (`OffscreenCanvas`) |
| frame extract | `-frames:v N`, `-update 1`, `out_%03d.png` sequences with `-vf fps=…`. Frames come from `VideoDecoder` and are written with `OffscreenCanvas.convertToBlob` (PNG, JPEG with `-q:v`, WebP): the browser's image encoders |
| audio extract | `-vn` with `-c:a copy` (m4a/ogg/webm), re-encode to Opus or AAC where available, or WAV/PCM |
| quality | `-crf` → WebCodecs `bitrateMode: 'quantizer'` where the encoder supports it (VP9, AV1, AVC in Chrome), otherwise mediabunny's quality presets. **Approximate**: it does not match x264's CRF scale |
| pipes | `-i -`/`pipe:0`, and `-`/`pipe:1` output with `-f`. Pipe output needs an append-only format: WebM, MKV, fragmented MP4 (`-movflags frag_keyframe` or `-f mp4` to a pipe implies it), MPEG-TS, Ogg, ADTS. A pipe input of an MP4 whose `moov` comes last is buffered up to a cap (256 MiB), and beyond it the command fails with "input is not seekable; use a file" |
| test sources | `-f lavfi -i testsrc=…\|color=…\|sine=…\|anullsrc`, drawn on a canvas or generated as `AudioData`. Cheap to do, and they make certs self-contained |
| info | `-version` (states plainly that this is not FFmpeg, but an ffmpeg-compatible CLI on WebCodecs and mediabunny), `-h`, `-formats`, and `-encoders`/`-decoders`/`-codecs`, **computed live** from `isConfigSupported` probes |
| progress | FFmpeg-style `frame= fps= time= bitrate= speed=` on stderr (with `\r` on a tty, throttled lines otherwise), `-stats`/`-nostats`, `-progress pipe:1` |

These can't work, and say so by name, as slicc 6's "reject, never drop" rule does:

- `-filter_complex`, and `-vf`/`-af` beyond the grammar above: overlay, drawtext, subtitle burn-in, loudnorm, atempo, eq, and so on. No libavfilter, by construction.
- Codecs the browser lacks: no fallback, by the constraint. On Chrome that means **MP3, Vorbis and FLAC encoding**, AAC encoding on some platforms, HEVC on many, and ProRes, DNxHD, MPEG-2, MPEG-4 Part 2 and Theora entirely.
- Bit-exact output, lossless video (FFV1, `-qp 0`), `-pix_fmt` beyond what the encoder takes (10-bit, 4:4:4), two-pass, `-preset`/`-tune`/`-profile` beyond the few WebCodecs config fields, `-hwaccel`.
- Multiple inputs and `-map` across inputs, such as muxing `video.mp4` with `audio.m4a`. mediabunny's `Conversion` takes one input, so this needs a packet-level pipeline: v2.
- Capture devices (`-f avfoundation`, slicc 6's webcam path). `getUserMedia` exists only on the page, so this needs a page-side service, which is option (A)'s territory: later and separate.
- **Divergence on SIGINT:** FFmpeg finalizes a partial output file. We cancel, and the file is left unfinalized (still exit 255). Fixing that needs our own pipeline instead of `Conversion`: v2.

**Memory.** Nothing reads a whole input. The exceptions that buffer, each with a cap and an error past it, are: a non-seekable MP4 input (above), and `-movflags +faststart`. mediabunny's `'reserve'` mode needs packet counts; we take them from the input index, and when they are unknown we fail rather than fall back to `'in-memory'`. The default MP4 output is `fastStart: false` (`moov` at the end, patched with positional writes).

## 4. Codec availability and "unsupported codec"

Availability depends on browser, build and OS, so **nothing is assumed and every check happens at runtime**:

- **Before any work**, each output track's encoder config goes through `VideoEncoder.isConfigSupported` / `AudioEncoder.isConfigSupported` (codec string, size, frame rate, bitrate, bitrate mode), and each input track's decoder config through `VideoDecoder.isConfigSupported` / `AudioDecoder.isConfigSupported`. mediabunny's `canEncode`/`canDecode` and `Conversion.discardedTracks` (`undecodable_source_codec`, `no_encodable_target_codec`) wrap the same checks. Any track mediabunny would drop on its own is an error, not a silently different file (slicc 6's rule).
- **The message** names the codec in FFmpeg's terms and in WebCodecs terms, the config that was refused, and what does work here. One line, a stable prefix, exit 1 (FFmpeg's status for a missing encoder):

  ```
  ffmpeg: encoder 'libx264' (avc1.640028, 1920x1080) is not supported by this browser (VideoEncoder.isConfigSupported)
  ffmpeg: video encoders available here: libvpx (vp8), libvpx-vp9 (vp9), libaom-av1 (av1)
  ```

- **`ffmpeg -encoders`/`-decoders`** print the live matrix, so an agent can check before it tries.
- **No WebCodecs at all** (the Node entry, or a non-Chromium context without it): `ffmpeg: WebCodecs is not available in this runtime; ffprobe, stream copy (-c copy) and PCM work, re-encoding needs a browser`, exit 1. `ffprobe` is unaffected.
- **Expectations, not promises.** Chromium's software VP8, VP9 and Opus encoders ship in every Chromium build, and AV1 (libaom) encoding in Chrome desktop. H.264 and AAC decoding need a build with proprietary codecs (Chrome yes, plain Chromium no). H.264 encoding uses platform encoders or OpenH264 in Chrome. AAC and HEVC encoding depend on the platform. Safari and Firefox differ again. The certs (section 6) are written so they pass on any of these.

## 5. Ownership

| where | what |
|---|---|
| **slicc-kernel** | The generic `abi: 'js'` program runtime: manifest field, loader, async SAB transport, `JsProgramContext`, the signal-word notify, Node parity, and a README section "JS programs". Released through semantic-release (a minor version) and certified like other kernel features. Nothing media-specific. |
| **new package** (name and home are questions for Lars) | `ffmpeg` and `ffprobe` as one JS command package: slicc 6's translator, probe and renderers ported, plus the streaming I/O, lavfi sources, image output and the availability reporting above. mediabunny is bundled or a dependency (section 2). Ported from slicc (Apache-2.0, same as this repo). My suggestion is its own repo, e.g. `ai-ecoverse/slicc-media`, published as `@ai-ecoverse/slicc-media` (the name avoids implying it is FFmpeg). homescoop's ladder builds upstream projects from recipes, and this is first-party JS, so it does not fit there. |
| **slicc-bios (seven)** | Pin the package in `src/packages/package.json` next to the kernel bump. List `ffmpeg`/`ffprobe` in the README's command list. Add one integration test (section 6). **No page code.** Camera capture, if ever wanted, would be a separate page-side service. |
| **homescoop** | No build. `packages/ffmpeg` stays retired. Update the "Retired recipes" note ("SLICC owns `ffmpeg`") to name the new package, and close #97 when seven ships it. |

## 6. Testing

**slicc-kernel (no WebCodecs needed).** A fixture package `test/integration/fixtures/jstest` (an `abi: 'js'` command) covers, in both the Chromium integration suite and the Node entry:

- argv, env, cwd and exit statuses (return, `exit()`, a throw → 1);
- streaming stdin → stdout with bounded memory: `head -c 64M /dev/zero | jstest cat | wc -c`, which proves pipe backpressure reaches the program;
- random-access `pread`/`pwrite` on a file larger than the pager's clean limit;
- redirects (`jstest … > f`, `< f`, `2>&1`), `isatty` on a terminal versus a pipe;
- signals: a caught SIGINT → cleanup → 130; an uncaught one → killed, 130; `jstest yes | head -1` → SIGPIPE 141; SIGKILL; `^Z`/`fg` on a terminal; `ps` and `kill` from another client;
- `jstest webcodecs` prints `typeof VideoEncoder`: `function` in the Chromium suite and `undefined` in Node. This is the one place the kernel itself checks the "WebCodecs lives in the process worker" assumption.

**The ffmpeg package.**

- Unit tests: argv → plan (slicc 6's translator tests come along), the ffprobe renderers, the error messages.
- On the Node kernel entry: `ffprobe` on small fixture files (mp4/H.264, webm/VP9, ogg/Opus, wav). These are a few KB of *media files*, not codec code. Also `-c copy` remuxes and WAV/PCM transcodes, which need no WebCodecs. The "unsupported" path is tested both with WebCodecs absent and with a stub `isConfigSupported` that refuses.
- A **fake WebCodecs** for pipeline logic: minimal `VideoEncoder`/`VideoDecoder`/`VideoFrame`/`EncodedVideoChunk` globals that pass bytes through under a fake codec string. It drives the progress, cancellation, backpressure and output paths in Node without a browser. It proves our plumbing, not media correctness.

**The Chromium cert** (the package's own playwright suite, with the kernel from its released tarball, as other certs do). Everything starts from lavfi sources, so no fixtures are needed:

1. `ffmpeg -f lavfi -i testsrc=d=2:s=320x240:r=30 -f lavfi -i sine=d=2 -c:v libvpx-vp9 -c:a libopus a.webm`, then `ffprobe -of json -show_streams -count_packets a.webm`: assert vp9 at 320×240 with 60 packets, and opus.
2. `ffmpeg -i a.webm -vf scale=160:-2,fps=15 b.webm` → 160×120 at 15 fps.
3. `ffmpeg -ss 1 -i a.webm -frames:v 1 f.png` → a PNG signature and an IHDR of 320×240.
4. `ffmpeg -i a.webm -vn a.wav` → a RIFF header with the right sample rate.
5. `cat a.webm | ffmpeg -i - -c copy -f webm - | ffprobe -` → pipes both ways.
6. **Conditional codecs** (H.264, AAC, HEVC, AV1): if `ffmpeg -encoders` lists one, a transcode to it must succeed and probe correctly. If not, it must fail with the unsupported message and exit 1. Either way the run is deterministic on any Chromium build, and the cert log records which branch ran.
7. A long encode interrupted with ^C on a terminal → exit 255, the prompt comes back, no process is left in `ps`.

**seven** gets one test in slicc-bios's integration suite: after boot, `ffmpeg -version` and step 1 above run in the booted page. That proves the package is installed and wired, not the media stack again.

## Open questions for Lars

1. **Containers versus codecs.** Is shipping (bundling) container parsers and muxers for MPEG-family *containers* (MP4/MOV, MPEG-TS, ADTS, MP3 framing) acceptable under "no MPEG-family codec implementations"? And mediabunny's H.264/HEVC bitstream-syntax code (SPS parsing, NAL framing, `addAvcBitstreamRestriction`)?
2. **PCM and G.711.** Core mediabunny does PCM sample-format conversion and µ-law/A-law in JS. Are these fine, or should the PCM paths be disabled so the rule reads "no codec code at all"?
3. **Bundle or depend.** Should @ai-ecoverse bundle mediabunny (MPL-2.0, notices kept) or depend on it from npm so we redistribute none of it? Depending costs bare-import resolution in the kernel's JS loader.
4. **Name and home.** Should the new package be its own repo, e.g. `@ai-ecoverse/slicc-media`, or live somewhere else? Can the commands be called `ffmpeg`/`ffprobe` (FFmpeg is a trademark), given `-version` says plainly what they are?
5. **No fallback.** When the browser lacks a codec, the command fails with the unsupported message; there is never a shipped encoder behind it. Confirm.
6. **Scope cuts for v1.** Multiple inputs, `-filter_complex`, camera capture and FFmpeg-style finalizing on SIGINT are all out. Is that acceptable?
7. **The kernel feature.** Is `abi: 'js'` acceptable as a general kernel feature, given it also opens a route for other slicc 6 JS commands? Or should v1 use the no-kernel-change B′ path?
