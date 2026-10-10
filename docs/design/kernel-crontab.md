# Kernel crontab (the only scheduler)

Status: **approved** (Lars via seven, 2026-10-10), **ordered after N1 (users)**. Tracks [slicc-kernel#156](https://github.com/ai-ecoverse/slicc-kernel/issues/156).

**Do not write kernel cron code until N1's enforcement PR has merged.** N1 is [users and groups](https://github.com/ai-ecoverse/slicc-kernel/blob/design/users-and-groups/docs/design/users-and-groups.md) ([#153](https://github.com/ai-ecoverse/slicc-kernel/issues/153)); implementation is in flight (@thread:thr_9ab5eajk3x).

Decision (Lars, 2026-10-09 / 2026-10-10): **the kernel crontab is the only scheduler.** A real crontab in slicc-kernel fires commands (for seven, typically `agent send …`) for scheduled agent wake-ups. The agent's durable `slicc.cron` tasks go away once this exists.

## Approved decisions (2026-10-10)

| Topic | Decision |
|---|---|
| Order | Build **users (N1) before crontab (N2)**. |
| Spools | **Per-user spools from the start** (`/var/spool/cron/crontabs/<user>`), on N1's passwd/home model — not a root-only v1. |
| Lick cards | Wakeups show as cron lick cards: `agent send` under `SLICC_CRON=1` becomes `<lick channel="cron">` (**agent-side**, in seven / slicc-agent). |
| Compat file | **Delete** `~/.slicc/crontab` after import (keep `~/.slicc/crontab.migrated` backup only). |
| Stamp | **At-most-once:** write the stamp **before** spawn. |
| Overlap | **Allow** overlapping runs of the same job (no per-job lock). |
| `crontab` command | **In-tree** kernel command (not a separate wasm package). |

## Problem

slicc 6 had [`crontask`](https://www.sliccy.com/man/crontask): a shell command that scheduled recurring tasks and routed them to scoops as licks (`packages/webapp/src/shell/supplemental-commands/crontask-command.ts` on slicc).

Seven's agent already has a durable cron of its own:

- Config: `~/.slicc/crontab` (`/home/.slicc/crontab`), one job per line: `<schedule> <name> [<target>] [<message>]`.
- Schedule: five Vixie fields, or `@yearly` / `@monthly` / `@weekly` / `@daily` / `@hourly` (local browser time). No `@reboot`.
- Persistence: each line is a background pi-durable task (`slicc.cron`) owned by the root conversation, reconciled from the file; fire id `<name>@<due ms>` so a crash does not double-deliver.
- Missed runs: when seven was closed or the tab slept, fires between the due time and now are collapsed into **one** lick (`count = 1 + missed`, text says how many, capped at 100 000), then the next fire is computed from now.
- Examples: gelatiere's nightly `0 3 * * * gelatiere scoop:<handle> Nightly pass: …`.

That puts the clock inside the agent worker. The kernel already owns processes, OPFS, boot (`/etc/fstab`), and (after N1) real users. Scheduling belongs with the OS, not with the LLM harness.

## Facts from the kernel that shape the design

- **`/` is OPFS.** Crontab files and stamps survive reloads when written through the kernel.
- **Boot already has a kernel service.** `Launcher.prepare()` mounts `/etc/fstab`. Cron fits the same slot.
- **Users (N1).** After N1: real `/etc/passwd` / `/etc/group`, per-process credentials, homes under `/home/<user>` (and `/root` for root), `kernel.users`, `spawn`/`connect({ user })`, then DAC enforcement. Cron **requires** that model for per-user spools and running jobs as the crontab owner.
- **Multi-client, multi-tab.** Web Lock `slicc-kernel-cron` so only one kernel fires against a shared OPFS root.
- **Timers in a browser tab.** Background throttling and tab close require anacron-like catch-up on `prepare()` / visibility.
- **`agent send`.** Bash script → `/var/lib/slicc/agent/requests/`. Cron sets `SLICC_CRON=1`; the agent wraps that send as `<lick channel="cron">`.

## Recommendation

A **kernel-internal cron service** (not a wasm `crond` process), reading Vixie-style per-user crontabs from OPFS, running due jobs as that user via `bash -c`, with anacron-like catch-up, stamp-before-spawn, and a Web Lock so only one kernel fires.

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
| environment lines | `NAME=value` before jobs in that file (`SHELL`, `PATH`, `HOME`, `CRON_TZ` later). No `MAILTO`. |

Times are **local wall time** of the realm. Reuse the agent's parser rules (`slicc-agent` `src/licks/cron.ts`); add `@reboot`.

`/etc/crontab` (system) has a **user field** after the schedule:

```
# m h dom mon dow user  command
0 3 * * * scoop-gelatiere  agent send scoop:gelatiere "Nightly pass: read ~/.pi/agent/GELATIERE.md and follow it."
```

Per-user crontabs omit the user field (the file name is the user):

```
*/15 9-17 * * mon-fri  agent send cone "Summarize what changed in ~/notes since the last standup"
@reboot                agent send cone "session-reload checklist"
```

### Paths

| path | role |
|---|---|
| `/etc/crontab` | system table; optional; **root-only write** (N1 DAC) |
| `/var/spool/cron/crontabs/<user>` | per-user table (Vixie). **From day one** — one file per N1 account that has a crontab (`cone`, `cone-2`, `scoop-…`, `root`, …) |
| `/var/spool/cron/stamp` | JSON map of fire keys → due ms (catch-up / at-most-once). OPFS; written only by the firer |
| `/var/log/cron/` | append-only job logs (§2); root-owned, world-readable or owner-readable per job |

Spool directory `/var/spool/cron/crontabs` is root-owned; each `<user>` file is **0600, owner = that user** (N1 ownership + enforcement). The cron service (kernel, as root) reads every spool; `crontab` as a user may only replace its own file.

**Not used as engine input:** `~/.slicc/crontab`. After migration it is **deleted** (backup `~/.slicc/crontab.migrated` only).

### Persistence

Crontabs and stamps live on OPFS through the normal VFS. The service re-reads on `fs.watch` of the spool dir and `/etc/crontab`.

---

## 2. The daemon

### Kernel-internal service, not a `crond` process

Implement next to fstab: `Launcher.prepare()` starts `CronService`, `terminate()` stops it. It is not a pid.

| | kernel service | userland `crond` |
|---|---|---|
| Survives with no shell | yes | only if something respawns it |
| Boot catch-up in `prepare()` | natural | races boot |
| Web Lock / single firer | natural in the kernel worker | each tab's crond contends awkwardly |
| Runs job as crontab user | uses N1 `spawn({ user })` / creds | would need the same |

### How a job runs

When a minute (or `@reboot`) is due:

1. Resolve the line to `{ user, shell, home, command, env }` via N1 passwd (`home`, uid/gid, shell).
2. **Stamp first** (`jobId@dueMs` or `reboot:<bootId>`), then spawn (at-most-once). If spawn fails after stamp, that due is skipped — not retried.
3. Spawn (no tty), as that user:

   ```
   argv: [shell, '-c', command]   # default /bin/bash
   cwd:  home                     # /home/<user> or /root (N1)
   cred: that user's ruid/euid/… (N1)
   env:  PATH, HOME, SHELL, LOGNAME, USER, plus file-level NAME=value,
         SLICC_CRON=1,
         SLICC_CRON_JOB=<stable id>,
         SLICC_CRON_DUE=<iso or ms>,
         SLICC_CRON_MISSED=<n>     # 0 if on time
   ```

4. **Overlap allowed:** the scheduler does not wait for the previous run of the same job; several jobs in the same minute run concurrently.
5. **Stdout/stderr** append to `/var/log/cron/<job-id>.log` with a header per run (`--- <iso> exit=<n> missed=<n> ---`). No mail. Cap each file (e.g. 256 KiB, keep the tail).

**Stable job id.** Prefer `# name: standup` comment when present (migration); else hash of `(crontab path, normalised command, schedule text)`.

### Watching config

On start and on watch events: parse all tables; invalid lines are skipped and reported once to `/var/log/cron/cron.err`. A bad line must not stop other jobs.

---

## 3. Lifecycle in a browser tab

### Clock source

Injectable **wall clock**:

```ts
type CronClock = {
  now(): number;
  localParts(ms: number): CronParts;
  sleep(untilMs: number, signal: AbortSignal): Promise<void>;
};
```

Default: `Date.now()` + chunked `setTimeout` in the kernel worker. Node tests inject a fake clock.

### Scheduling loop

1. Next due across all jobs (or next minute boundary).
2. `sleep` until then; wake early on crontab change, terminate, visibility.
3. Catch up, then arm the next sleep. Cap sleep chunks (e.g. 60s).

### Missed runs (anacron-like)

For each job, from stamp `lastFire` (or never): walk dues with the agent's `nextFire` / `missedFires` (cap 100 000); run **once** with `SLICC_CRON_MISSED`; stamp the latest covered due **before** spawn; next fire from `now`.

`@reboot`: once per kernel boot while holding the fire lock; stamp `reboot:<bootId>` (`Launcher.boot` / `/proc/stat` btime) **before** spawn.

### Deduplication across tabs

- Exclusive Web Lock `slicc-kernel-cron` for the firer's lifetime.
- Only the lock holder runs jobs and writes stamps.
- Followers still parse/watch (so `crontab -l` works) but do not fire.
- Stamp before spawn ⇒ at-most-once across reload and multi-tab.

### Clock jumps

Backward jump &gt; two minutes: do not flood; wait for a future due. Forward jump: catch-up.

---

## 4. The `crontab` command and expressing licks

### Command (in-tree)

Kernel-native command (same delivery path as other in-tree commands / `abi: 'js'` if that is how N1's `sudo` ships — match whatever in-tree pattern N1 uses). Behaviour close to Vixie:

| | |
|---|---|
| `crontab -l` | print the caller's spool file |
| `crontab -e` | temp file + `$EDITOR` / `$VISUAL`, install on success |
| `crontab -r` | remove the caller's spool file |
| `crontab file` | install `file` as the caller's crontab |
| `crontab -u user …` | **root only** |

Editing `/etc/crontab` is with a normal editor, not `crontab -e`. Without `$EDITOR`, edit `/var/spool/cron/crontabs/$USER` directly; the watch picks it up.

### Scheduled licks

```cron
*/15 9-17 * * mon-fri  agent send cone "Summarize what changed in ~/notes since the last standup"
0 3 * * *              agent send scoop:gelatiere "Nightly pass: read ~/.pi/agent/GELATIERE.md and follow it."
@reboot                agent send cone "Kernel booted; check background jobs"
```

Kernel sets `SLICC_CRON=1` (and job/due/missed). **slicc-agent** (seven follow-up): when handling `agent send` with that env, deliver as `<lick channel="cron" source="…" …>` so Spectrum shows cron cards.

---

## 5. Migrating from the agent's durable cron

Owned by **slicc-agent** (and gelatiere), after the kernel advertises cron (semver / feature file).

1. **Import once** into the **caller's** spool (the cone or root user that owns the old file — typically the first cone's user under N1, not a shared `/home/.slicc` forever). Translate:

   | agent | kernel |
   |---|---|
   | `<schedule> <name> <message…>` | `<schedule>  agent send cone "<message>"` |
   | `<schedule> <name> cone <message…>` | same |
   | `<schedule> <name> scoop:h <message…>` | `<schedule>  agent send scoop:h "<message>"` |
   | empty message | `agent send <target> "cron:<name> fired"` |

   Preserve schedule text. `# name: <name>` above each line. Backup to `~/.slicc/crontab.migrated`, then **delete** `~/.slicc/crontab`.

2. Stop reconciling `slicc.cron`; abort live durable cron tasks after import.
3. **gelatiere init** writes/replaces a line in the gelatiere scoop user's spool (or `/etc/crontab` with that user field).
4. Skills/README: schedules → kernel `crontab` + `agent send`; `SLICC_CRON=1` → cron lick.

---

## 6. Security (on N1)

| who | may |
|---|---|
| a user | `crontab` only their own spool; jobs run as that user |
| root | `crontab -u`, edit `/etc/crontab`, read all spools |
| `/etc/crontab` | root-owned `0644` (write root-only under N1 DAC) |
| spool files | `0600`, owner = user |
| elevation | `sudo` inside a cron job follows N1 / #153; cron adds no second approval path |

---

## 7. Test plan (Node entry, fake clock)

```ts
const clock = fakeCronClock();
const kernel = await createNodeKernel({ clock, users: 'enforce' /* N1 */ });
await kernel.users.add({ name: 'cone' });
await kernel.writeFile(
  '/var/spool/cron/crontabs/cone',
  '* * * * *  touch /home/cone/fired\n',
);
clock.advance(60_000);
await clock.flush();
// file exists, owned by cone
```

Cases:

1. On-time fire as the spool user (uid/HOME match N1).
2. Catch-up: one run, `SLICC_CRON_MISSED`, stamp before spawn (kill mid-job ⇒ no second run for that due).
3. `@reboot` once per boot id.
4. Hot reload of spool / `/etc/crontab`.
5. Web Lock: two kernels, one firer.
6. Invalid line skipped; next line runs.
7. Overlap: same job still due while previous child live ⇒ second spawn allowed.
8. `crontab -l/-u` permission matrix (user vs root) — needs N1 enforcement.
9. Chromium smoke: `crontab -l` in a booted page after N1+N2 cert pin.

---

## Ownership

| where | what |
|---|---|
| **slicc-kernel** | Cron service, stamp/log paths, fake clock, in-tree `crontab`, README. |
| **slicc-agent** | Migration; delete `~/.slicc/crontab`; gelatiere → spool; `SLICC_CRON=1` → cron lick; skills. |
| **slicc-bios (seven)** | Pin kernel after N1+N2; no page scheduler. |

---

## PR plan (N2)

Gate: **N1 enforcement PR merged** (`createKernel({ users: 'enforce' })` available and green). Until then: design only. Pure schedule math could be drafted behind a flag, but the coordinator holds the start signal.

N1 APIs this plan assumes (from [users-and-groups](https://github.com/ai-ecoverse/slicc-kernel/blob/design/users-and-groups/docs/design/users-and-groups.md)):

| N1 piece | Cron use | If missing |
|---|---|---|
| `/etc/passwd` + home paths (`/home/<user>`, `/root`) | spool keys, job `cwd`/`HOME`/`USER` | **block** — cannot ship per-user spools |
| Process credentials + `spawn(…, { user })` / root spawn-as-user | run job as crontab owner | **block** |
| `kernel.users.add` / `list` (tests + agent) | test fixtures; agent creates cone/scoop users before installing crontabs | stub in tests with hand-written passwd only if `add` lags; prefer real API |
| Ownership on create (`0600` spool, root `/etc/crontab`) | correct `ls` / later DAC | ship with report mode; tighten in C3 |
| **DAC enforcement** | `crontab` can't edit others' spools; non-root can't write `/etc/crontab` | **block C3/C4** — wait for N1 enforcement PR |
| `sudo` (N1 step 4) | not required for cron itself | no dependency |

### Sequence

```
N1: credentials → ownership → enforcement ──┬──▶ C1 → C2 → C3 → C4
                                            │
                                            └──▶ A1 (slicc-agent, after C2 at least)
```

| PR | Repo | Title (draft) | Changes | N1 dependency | Tests / cert |
|---|---|---|---|---|---|
| **C1** | slicc-kernel | `feat(cron): schedule parser and injectable clock` | Port/adapt 5-field + macros (`@reboot` included) `parseSchedule` / `nextFire` / `missedFires`; `CronClock` + Node `fakeCronClock`; no service yet. | None functionally; **still wait for start signal**. | Unit: field matrix, macros, day/weekday OR, missed cap, fake clock advance. |
| **C2** | slicc-kernel | `feat(cron): CronService — fire, stamp, lock, catch-up` | `CronService` in `prepare()`/`terminate()`; watch spool dir + `/etc/crontab`; Web Lock `slicc-kernel-cron`; stamp-before-spawn; anacron catch-up; `@reboot`; spawn `bash -c` **as user** with `SLICC_CRON*`; logs under `/var/log/cron/`; overlap allowed. | **Hard:** passwd lookup, `spawn` as user, homes. Soft: ownership for log/stamp files (root). | Node: cases 1–7 in §7 with `users: 'enforce'` (or `'report'` + explicit creds if enforce not default yet). Two-kernel lock test with fake `LockManager`. |
| **C3** | slicc-kernel | `feat(cron): crontab command and spool permissions` | In-tree `crontab` (`-l`/`-e`/`-r`/`file`/`-u`); install path writes `0600` owner=user; document `/etc/crontab` editing. | **Hard: N1 enforcement** (EACCES matrix). `crontab -e` needs `$EDITOR` or documented file edit. | Node: permission matrix; install/list/remove as cone vs root `-u`; editor path with a stub editor script. |
| **C4** | slicc-kernel | `docs(cron): README + feature advertisement` | README section; optional `/proc` or version note so agent can feature-detect; changelog via release. | None beyond C2+C3 merged. | Cert bump in homescoop/seven when pinned (below). |
| **A1** | slicc-agent | migrate off durable cron; cron licks | Import → per-user spool; delete `~/.slicc/crontab`; abort `slicc.cron`; gelatiere writes spool; `agent send` + `SLICC_CRON=1` → `<lick channel="cron">`; skills/README. | Needs kernel with C2 (+ ideally C3) published; N1 agent mapping for which user owns the spool. | Agent integration: import fixture, lick shape, no double-fire with durable tasks gone. |
| **B1** | slicc-bios | pin kernel (+ agent) | Bump `@ai-ecoverse/slicc-kernel` / agent; one smoke: `crontab -l` / a `@reboot` or short schedule in the booted page. | N1+N2 releases. | Existing bios integration suite + one cron smoke. |

### Cert (homescoop / seven)

- **Kernel cert** (after C2/C3): Node suite above is the bar for release; Chromium integration: stamp + spool survive OPFS reload; lock behaviour not required in browser if Node covered.
- **Seven cert:** after A1+B1 — schedule a one-minute line (or `@reboot`), assert a cron lick card (channel `cron`) once; confirm `~/.slicc/crontab` absent after migration.
- No MPEG/media interaction; no page-side scheduler.

### What we will stub vs wait for

| Need | Stub? | Wait? |
|---|---|---|
| Schedule parser / clock | Can implement in C1 in isolation | Start only when coordinator opens N2 coding |
| User home + spawn-as-user | Do not stub fake uids in production path | **Wait for N1 credentials + users API** |
| DAC on spool | Do not ship `crontab -u` security without it | **Wait for N1 enforcement PR** (explicit gate) |
| `kernel.users.add` in tests | Hand-written `/etc/passwd` + mkdir home only if `add` is late | Prefer real `users.add` |
| Agent lick wrapping | N/A in kernel | A1; kernel only guarantees `SLICC_CRON=1` |
| `sudo` | Not needed | — |

### Out of scope for N2 PRs

- Per-job timeout / skip-if-running (overlap is approved).
- `CRON_TZ`, mail, anacron periods other than "catch up missed cron slots".
- Page-visible cron UI (Spectrum cards come from agent licks).
- Implementing N1.

---

## Resolved questions

Formerly open; closed 2026-10-10:

1. Lick cards → yes, via `SLICC_CRON=1` on the agent side.
2. Compat file → delete after import (keep `.migrated`).
3. Stamp → before spawn (at-most-once).
4. Spool user → per-user from the start (N1 names).
5. `crontab` → in-tree kernel command.
6. Overlap → allowed.
