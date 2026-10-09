# Kernel crontab (the only scheduler)

Status: **design, not approved**. Tracks [slicc-kernel#156](https://github.com/ai-ecoverse/slicc-kernel/issues/156).

Decision already made (Lars, 2026-10-09): **the kernel crontab is the only scheduler.** A real crontab in slicc-kernel fires commands (for seven, typically `agent send …`) for scheduled agent wake-ups. The agent's durable `slicc.cron` tasks go away once this exists. This note designs that crontab.

## Problem

slicc 6 had [`crontask`](https://www.sliccy.com/man/crontask): a shell command that scheduled recurring tasks and routed them to scoops as licks (`packages/webapp/src/shell/supplemental-commands/crontask-command.ts` on slicc).

Seven's agent already has a durable cron of its own:

- Config: `~/.slicc/crontab` (`/home/.slicc/crontab`), one job per line: `<schedule> <name> [<target>] [<message>]`.
- Schedule: five Vixie fields, or `@yearly` / `@monthly` / `@weekly` / `@daily` / `@hourly` (local browser time). No `@reboot`.
- Persistence: each line is a background pi-durable task (`slicc.cron`) owned by the root conversation, reconciled from the file; fire id `<name>@<due ms>` so a crash does not double-deliver.
- Missed runs: when seven was closed or the tab slept, fires between the due time and now are collapsed into **one** lick (`count = 1 + missed`, text says how many, capped at 100 000), then the next fire is computed from now.
- Examples: gelatiere's nightly `0 3 * * * gelatiere scoop:<handle> Nightly pass: …`.

That puts the clock inside the agent worker. The kernel already owns processes, OPFS, boot (`/etc/fstab`), and the page's single process table. Scheduling belongs with the OS, not with the LLM harness: any command can be scheduled, Stop/rewind cannot abort it, and seven can retire `crontask` / agent-side cron without inventing another product.

## Facts from the kernel that shape the design

- **`/` is OPFS.** `createKernel` creates `/tmp` and `/home` there. Files under `/etc`, `/var`, `/home` survive reloads when they are written through the kernel. There is no separate "cron database"; the crontab files *are* the database.
- **Boot already has a kernel service.** `Launcher.prepare()` mounts `/etc/fstab`. Cron fits the same slot: start with the kernel, not as a userland daemon the user can kill.
- **Identity today.** Programs run as the realm user (uid/gid 1000). Reading a missing `/etc/passwd` synthesises root (uid 0) and the realm user (`USER` or `web_user`). Real multi-user identity is still open ([#153](https://github.com/ai-ecoverse/slicc-kernel/issues/153) is the related sudo/elevation decision; the README already documents the virtual passwd). Cron should be **per-user-ready** (spool paths and ownership) while v1 stays single-user.
- **Multi-client, multi-tab.** The page owns one kernel; other tabs can each start a kernel against the same OPFS. Clients already use Web Locks (`navigator.locks`) so a dead peer is detected. The agent takes `slicc-agent` so only one tab owns the agent worker. Cron needs the same exclusivity for *firing*, or two kernels would run the same due minute twice.
- **Timers in a browser tab.** Background tabs throttle `setTimeout`. Closing the tab ends the kernel. Catch-up on the next `prepare()` (and when the tab becomes visible again) is mandatory, the way the agent's missed-fire path is today.
- **`agent send`.** Installed as a bash script that posts into `/var/lib/slicc/agent/requests/`. `agent send <handle> "message"` steers an idle cone/scoop or steers a busy one; `--follow-up` queues. From a scoop, `agent send parent "…"` posts a progress lick. Scheduled licks are ordinary commands on that path, not a second IPC.

## Recommendation

A **kernel-internal cron service** (not a wasm `crond` process), reading Vixie-style crontabs from OPFS, running due jobs as real processes via `bash -c`, with anacron-like catch-up and a Web Lock so only one kernel fires.

---

## 1. Format and where files live

### Syntax

Standard **five-field** crontab (minute hour day-of-month month day-of-week), with:

| | |
|---|---|
| lists, ranges, steps | `1,15`, `9-17`, `*/15`, `1-10/2` |
| names | `jan`–`dec`, `sun`–`sat`; `7` = Sunday |
| day-of-month × day-of-week | either matches when both are restricted (Vixie / agent today) |
| macros | `@yearly` / `@annually`, `@monthly`, `@weekly`, `@daily` / `@midnight`, `@hourly`, **`@reboot`** |
| comments / blanks | `# …`, empty lines ignored |
| environment lines | `NAME=value` before jobs in that file (`SHELL`, `PATH`, `HOME`, `CRON_TZ` later). No `MAILTO` (there is no mail). |

Times are **local wall time** of the realm (the browser's local zone today; later whatever the kernel's timezone is). Reuse the agent's parser rules (`slicc-agent` `src/licks/cron.ts`) so migration does not change when jobs fire; add `@reboot` only.

`/etc/crontab` (system) has a **user field** after the schedule:

```
# m h dom mon dow user  command
0 3 * * * root  agent send scoop:gelatiere "Nightly pass: read ~/.pi/agent/GELATIERE.md and follow it."
```

Per-user crontabs omit the user field (the file's owner is the user):

```
*/15 9-17 * * mon-fri  agent send cone "Summarize what changed in ~/notes since the last standup"
@reboot                agent send cone "session-reload checklist"
```

### Paths (v1 and later)

| path | role |
|---|---|
| `/etc/crontab` | system table; optional; root-only write |
| `/var/spool/cron/crontabs/<user>` | per-user table (Vixie layout). **v1:** only `root` (or the single realm user name, see below) |
| `/var/spool/cron/stamp` | JSON map of last completed fire keys → due ms (catch-up / dedupe). OPFS |
| `/var/log/cron/` | append-only job logs (see §2) |

**v1 user name.** Until real users land, the spool file is `/var/spool/cron/crontabs/root` and `/etc/crontab` lines use `root`. Jobs still run as today's realm credentials (uid 1000, `HOME=/home`), because that is what every process is. When `/etc/passwd` becomes real, the spool key is the account name and the job's uid/gid/HOME follow that account.

**Not used:** `~/.slicc/crontab` as the engine's source of truth (that file is the agent's today). After migration it may remain as a one-shot import input or a short-lived shim (open question).

### Persistence

Crontabs and stamps live on OPFS through the normal VFS. No IndexedDB, no durable task. Editing a file (or `crontab -e`) is enough; the service re-reads on `fs.watch` of the spool and `/etc/crontab`, the way fstab is read at boot (cron also hot-reloads).

---

## 2. The daemon

### Kernel-internal service, not a `crond` process

| | kernel service (recommended) | userland `crond` |
|---|---|---|
| Survives with no shell | yes | only if something respawns it |
| Boot catch-up in `prepare()` | natural | races boot |
| Web Lock / single firer | natural in the kernel worker | each tab's crond contends awkwardly |
| `ps` shows a daemon | no | yes, cosmetic |
| Killable by mistake | no | yes |

Implement next to fstab: `Launcher.prepare()` starts `CronService`, `terminate()` stops it. It is not a pid. Optional later: a tiny `crond` status command that prints the in-kernel schedule (like reading `/proc`).

### How a job runs

When a minute (or `@reboot`) is due:

1. Resolve the line to `{ user, shell, home, command, env }`.
2. Spawn a process (not attached to a terminal):

   ```
   argv: [shell, '-c', command]   # shell default /bin/bash (PATH has bash)
   cwd:  home                     # /home in v1
   env:  PATH, HOME, SHELL, LOGNAME, USER, plus file-level NAME=value,
         SLICC_CRON=1,
         SLICC_CRON_JOB=<stable id>,
         SLICC_CRON_DUE=<iso or ms>,
         SLICC_CRON_MISSED=<n>     # 0 if on time
   ```

3. Do **not** wait in the scheduler loop beyond booking the child: several jobs in the same minute run concurrently (each its own process / process group). A stuck job does not block the next minute; a per-job timeout is out of scope for v1 (the command can use `timeout` if installed).
4. **Stdout/stderr** append to `/var/log/cron/<job-id>.log` with a header line per run (`--- <iso> exit=<n> missed=<n> ---`). No mail. Log rotation is a later concern; v1 caps each file (e.g. 256 KiB, keep the tail).

**Stable job id.** Hash of `(crontab path, normalised command, schedule text)` (not line number, so reordering comments does not matter). Used in stamps, logs, and `SLICC_CRON_JOB`.

### Watching config

On start and on watch events: parse all tables; invalid lines are skipped and reported once to `/var/log/cron/cron.err` (and optionally a kernel log hook the embedder can surface). A bad line must not stop other jobs — same spirit as the agent's per-line config errors.

---

## 3. Lifecycle in a browser tab

### Clock source

Injectable **wall clock**:

```ts
type CronClock = {
  now(): number;                       // epoch ms
  localParts(ms: number): CronParts; // local y/m/d/h/min/weekday
  sleep(untilMs: number, signal: AbortSignal): Promise<void>;
};
```

Default: `Date.now()` + `setTimeout` (clamped; see below) in the kernel worker. Node tests pass a fake clock (§7).

### Scheduling loop

1. Compute the next due time across all jobs (or the next minute boundary).
2. `sleep` until then, but wake early on: crontab change, abort/terminate, and (in the browser) `visibilitychange` / a page hook if the embedder forwards one.
3. On wake: **catch up** (§ below), then arm the next sleep.

Browser throttling: never trust a single long `setTimeout` across hours. Cap sleep chunks (e.g. 60s) and re-check `now()` each time.

### Missed runs (anacron-like, matching today's agent)

For each job, with `lastFire` from `/var/spool/cron/stamp` (or "never"):

- Walk due times after `lastFire` up to `now` with the same `nextFire` / `missedFires` logic the agent uses (cap count at 100 000).
- If any are due: run the command **once**, set `SLICC_CRON_MISSED` to the number of skipped slots after the first, stamp the **latest** due time that was covered.
- Then compute the next fire from `now` (not from each missed slot).

So a daily job after a week offline runs once, not seven times. `@reboot` is special: fire once per kernel boot when this kernel holds the fire lock, recorded as `reboot:<bootId>` in the stamp so a second tab that later takes the lock does not reboot-fire again until the next boot id. `bootId` is the kernel's existing boot time (`Launcher.boot` / `/proc/stat` btime).

### Deduplication across tabs / kernels

- Take an exclusive Web Lock named `slicc-kernel-cron` for the lifetime of the service (same pattern as attach / `slicc-agent`).
- Only the lock holder runs jobs and writes stamps.
- A follower kernel still **parses and watches** crontabs (so `crontab -l` works) but does not fire.
- Stamp keys are `jobId@dueMs` (and `reboot:bootId`). Before running, read the stamp; if the key is present, skip. Write the stamp **before** spawn if we need crash-safety against double run after a kill mid-job; accept that a crash between stamp and successful `agent send` can skip one fire (same class of trade-off as stamping after — prefer stamp-after-exit for "at least once" toward the agent, and rely on agent's own idempotency if any). **Recommendation: stamp after the process exits** so a reload mid-job retries; `agent send` / lick delivery should remain safe to repeat (agent already dedupes cron event ids today — after migration, agent may dedupe on `SLICC_CRON_JOB` + due, open question).

### Clock jumps

If `now` jumps backward more than two minutes, do not flood: leave stamps as they are and wait for the next future due. If it jumps forward, catch-up applies.

---

## 4. The `crontab` command and expressing licks

### Command

Ship `crontab` as an ordinary command package (wasm or `abi: 'js'` once that exists), behaviour close to Vixie:

| | |
|---|---|
| `crontab -l` | print the caller's spool file (v1: root's) |
| `crontab -e` | copy to a temp file, run `$EDITOR` / `$VISUAL`, install on success |
| `crontab -r` | remove the caller's spool file |
| `crontab file` | install `file` as the caller's crontab |
| `crontab -u user …` | root only; v1 accepts only the single user |

Editing `/etc/crontab` is with a normal editor (`nano` / `vi` / `cat`), not `crontab -e`. The service accepts either.

Without a usable `$EDITOR`, users and the agent edit `/var/spool/cron/crontabs/root` directly; the watch picks it up. Document that path in the licks skill.

### Scheduled licks as cron lines

Kernel cron does not know about licks. Seven's idiom is a command that talks to the agent:

```cron
# cone wake-up (replaces: */15 9-17 * * mon-fri standup cone Summarize …)
*/15 9-17 * * mon-fri  agent send cone "Summarize what changed in ~/notes since the last standup"

# scoop (replaces gelatiere line)
0 3 * * *  agent send scoop:gelatiere "Nightly pass: read ~/.pi/agent/GELATIERE.md and follow it."

@reboot  agent send cone "Kernel booted; check background jobs"
```

`agent send` already means: idle → new request; busy → steer. That matches "wake the agent on a schedule." Spectrum lick cards with `channel="cron"` are an **agent-side** concern: either `agent send` grows a `--lick cron` (or reads `SLICC_CRON=1` and wraps the text in a `<lick channel="cron" …>`), or scheduled wakes show as ordinary steers. See open questions.

---

## 5. Migrating from the agent's durable cron

Owned by **slicc-agent** (and gelatiere), triggered when the kernel version advertises cron (e.g. `/proc` feature file or README/semver gate).

1. **Import once.** If `/var/spool/cron/crontabs/root` is missing and `~/.slicc/crontab` has entries, translate each line:

   | agent | kernel |
   |---|---|
   | `<schedule> <name> <message…>` | `<schedule>  agent send cone "<message>"` |
   | `<schedule> <name> cone <message…>` | same |
   | `<schedule> <name> scoop:h <message…>` | `<schedule>  agent send scoop:h "<message>"` |
   | empty message | `agent send <target> "cron:<name> fired"` (so the wake is never an empty send) |

   Preserve the schedule text byte-for-byte. Put the old `name` in a comment above the line (`# name: standup`) for humans; put it in `SLICC_CRON_JOB` via a stable id derived from that name when present so logs stay recognisable.

2. **Stop reconciling `slicc.cron`.** Remove `cronTask` registration (or leave it inert). Stop watching `~/.slicc/crontab` for schedules. Leave watches and webhooks as they are.

3. **Abort live durable cron tasks** after a successful import so nothing double-fires.

4. **gelatiere init** appends/replaces a line in the kernel crontab (or `/etc/crontab`) instead of `~/.slicc/crontab`.

5. **Docs / skills.** Licks skill: schedules → kernel `crontab`; point at this design. Retire v6 `crontask` as "use `crontab` + `agent send`".

6. **Rollback.** Keep a backup `~/.slicc/crontab.migrated` copy of the pre-import file.

---

## 6. Security (users later)

| who | may |
|---|---|
| v1 (single user) | anyone who can write the VFS can edit the spool (same as today for `~/.slicc/crontab`). No extra kernel gate. |
| after real users | a user may `crontab` only their own spool; root may `-u` anyone and edit `/etc/crontab`; jobs run as the crontab owner (uid/gid/HOME from passwd) |
| `/etc/crontab` | root-only write (mode `0644`, owner root) |
| spool files | `0600`, owner = user |
| elevation | scheduling `sudo` / privileged commands follows whatever #153 decides for sudo; cron does not add a second approval path |

Per-user readiness without implementing users now: **path layout and the user field in `/etc/crontab` are final in v1**; only one spool file is consulted until passwd says otherwise.

---

## 7. Test plan (Node entry, fake clock)

Extend `createNodeKernel` with an optional `cron: { clock }` (or a top-level `clock` shared with other services). Default clock is real time; tests inject:

```ts
const clock = fakeCronClock(); // now(), advance(ms), flush()
const kernel = await createNodeKernel({ clock });
await kernel.writeFile('/var/spool/cron/crontabs/root', '* * * * *  touch /home/fired\n');
await kernel.prepare?.(); // if prepare is explicit in the test harness
clock.advance(60_000);
await clock.flush();
assert.equal(await kernel.readFile('/home/fired').then(() => 'yes'), 'yes');
```

Cases:

1. **On-time fire** — advance to the next minute; `touch` or `echo` ran once.
2. **Catch-up** — stamp in the past, advance wall clock by three hourly boundaries; command ran once; `SLICC_CRON_MISSED` visible in the log header; stamp updated to the last covered due.
3. **@reboot** — one fire after prepare; second prepare with the same boot id does not refire; new boot id does.
4. **Reload parse** — rewrite crontab via `writeFile`; watch picks up; old schedule stops, new one runs.
5. **Lock** — two Node kernels with a shared fake `LockManager`; only one creates `/home/fired`.
6. **Invalid line** — bad schedule does not block the next good line; error logged.
7. **Concurrency** — two lines in the same minute both run (two marker files).
8. No browser / Playwright requirement for v1 unit/integration on the Node entry; one Chromium smoke later that `crontab -l` works in a booted page is enough for seven.

---

## Ownership

| where | what |
|---|---|
| **slicc-kernel** | Cron service, stamp/log paths, fake clock hook, `crontab` command (or a tiny package it pins), README section. |
| **slicc-agent** | Migration off `slicc.cron`; gelatiere writes kernel crontab; optional `SLICC_CRON` → lick wrapping; skills/README. |
| **slicc-bios (seven)** | Pin kernel version; no page scheduler. |
| **slicc (v6)** | `crontask` stays historical; man page can point at seven's `crontab`. |

---

## Open questions for Lars

1. **Lick cards.** Should `agent send` under `SLICC_CRON=1` become a `<lick channel="cron">` (keeping today's UI), or is a plain steer enough?
2. **Compat file.** Delete `~/.slicc/crontab` after import, keep it as a deprecated mirror the agent rewrites into the spool, or leave a pointer comment only?
3. **Stamp before vs after.** Prefer at-least-once (stamp after exit) or at-most-once (stamp before spawn)?
4. **v1 spool user name.** `root` or the realm `USER` / `web_user`?
5. **`crontab` package home.** In-tree kernel command vs `@ai-ecoverse/wasm-cronie` (or similar) on the homescoop ladder?
6. **Job timeout / overlap.** v1 allows overlap; should a still-running job skip the next tick (lock per job id)?
