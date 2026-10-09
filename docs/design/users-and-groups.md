# Users and groups in slicc-kernel

**Status:** design note for review (N1, from the slicc-agent plan). No code until it's approved.
**For:** Lars, Sliccy Seven, the homescoop coordinator.
**Issues:** ai-ecoverse/slicc-kernel#153 (sudo), #67 (scoop isolation).

Lars's direction, on #153:
> This has to move into the kernel. But this also means we need multiple users, the session starts as root, and each scoop or cone can get an individual user, which would move their working directories to /home.

The order agreed in the plan (N1, option a):
1. kernel users first;
2. then #67, rebuilt on uids and permissions;
3. then plan PR 25 (approvals and sudo in slicc-agent and slicc-bios).

This note covers step 1 and the kernel half of PR 25's sudo.

---

## 1. Where things stand (measured on 1.30.0)

| What | Today | Where it comes from |
|---|---|---|
| `getuid`/`geteuid`/`getgid`/`getegid`, Emscripten | 1000 | homescoop `shims/slicc/slicc_libc_gaps.c` (`#define SLICC_UID 1000`). `setuid` accepts only 1000. |
| The same, WASIX | 1000 | homescoop `packages/wasix-sysroot/slicc_identity.c`, which replaces wasix-libc's `getuid() { return 0; }` |
| `/etc/passwd`, `/etc/group` (Emscripten) | `root:0` plus `$USER` (default `web_user`):1000, home `$HOME` | synthesized by the kernel (`process-fds.ts` `accounts(env)`). A real file in the root wins. |
| passwd for WASIX | a static `user`:1000, `/home/user` | `slicc_identity.c`, which disagrees with the kernel's file |
| `getpw*`/`getgr*`, Emscripten | read the kernel's `/etc/passwd` and `/etc/group` | homescoop `slicc_pwd.c` (homescoop#146) |
| `stat` owner | always 1000:1000 (Emscripten); 0:0 (WASI `fstat`) | `realm-user.ts` `ownByRealmUser` stamps every stat |
| `chown` | accepted, stores nothing | Emscripten's FS doesn't pass the owner on, and no backend stores one |
| mode bits | stored (OPFS sidecar `MetaEntry.mode`, tmpfs, hostfs, fsa via driver), shown by `ls`/`stat` | **never enforced**: `chmod 000 f; cat f` reads. The README says so. |
| `/proc/<pid>/status` `Uid:`/`Gid:` | 1000 | `procfs.ts` constant |

Two things to keep in mind:
- **Identity is a C-library fiction today.** Both libraries hard-code 1000, and the kernel knows no uid at all.
- **Permissions are decoration.** No kernel path checks them.

The design has to add both, without breaking the ~40 packages that assume "everything is uid 1000 and allowed".

---

## 2. The user and group model

### The database
- **Source of truth:** `/etc/passwd` and `/etc/group` are real files in the root file system, owned by root with mode 0644. This is the Linux shape, and homescoop's `slicc_pwd.c` already reads them.
- **First boot:** the kernel writes defaults when the files are missing.
- **Editing:** root may edit them; everyone else gets `EACCES`.
- **Lookups:** the kernel parses them, cached and refreshed on change through the watcher it already has, to map names to ids.

Default contents on a fresh root:

```
root:x:0:0:root:/root:/bin/bash
nobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin
```
```
root:x:0:
sudo:x:27:
users:x:100:
nogroup:x:65534:
```

### Allocation
- **Reserved:** uid/gid 0 is root, 1–999 are system ids (reserved, unused for now), 65534 is nobody.
- **Users:** from 1000 up, the lowest free id. Never reused while `/etc/passwd` still lists the name.
- **Primary group:** every user gets a personal group with the same id and name (Debian's user-private groups). Users are also members of `users`.
- **Who may add users:** only root. The kernel API does it (§6), as do `useradd`/`groupadd` programs if homescoop ships them later; both go through the same kernel call.

### The session user
- **The page is root.** `createKernel()` hands the page a root identity, so `run`, `openTerminal` and the page's own `fs` act as uid 0. The panel terminal is the human, and in v6 the human was never sudo-gated.
- **`HOME` for root** is `/root`, created 0700 on first boot.
- **Today's 1000:** the "realm user" disappears as a fixed identity. Its role moves to the first cone's user, which normally gets uid 1000, so files written today keep a plausible owner (see §8).

---

## 3. Process credentials

### What a process carries
Each kernel process gets credentials in the kernel, next to its pgid/sid. They never come from the program.

```
{ ruid, euid, suid, rgid, egid, sgid, groups: number[], umask }
```

### Inheritance
Credentials follow the same path as the ignored-signals mask and the network label once did (`StartRequest` in `launcher.ts`):

| Event | Credentials |
|---|---|
| `fork` | copied unchanged |
| `exec` / `posix_spawn` | copied unchanged; **no setuid/setgid-bit transitions** (see below) |
| `run` / `openTerminal` / a client's `spawn` | the client's identity (§6) |

**No setuid executables.** The kernel won't honour the S_ISUID/S_ISGID bits on exec. The only elevation path is `sudo` through the kernel (§5). That's one audited path instead of a bit any root-writable package could set. The bits are still stored and shown.

### Changing credentials
POSIX semantics, checked in the kernel:
- euid 0 may `setuid`/`setgid`/`setgroups` to anything.
- Anyone else may only swap among their real, effective and saved ids (`setreuid`/`setresuid` rules).
- `setgroups` needs euid 0.
- `umask` is per process and inherited. The default is 022; a scoop user's is 077 (§6).

New syscalls:
- `proc-cred`: answers the credentials.
- `proc-setcred { which, ids }`: answers the new credentials or `EPERM`.

The Emscripten and WASI runtimes call these the same way #171 made `getpid`/`getppid` come from the kernel (`proc-identity`).

### How programs see their ids
The C libraries hard-code their answers, so the kernel needs the libraries to ask. That's homescoop work, which the kernel enables:
- **Emscripten:** `slicc_libc_gaps.c` replaces the `SLICC_UID` constants with EM_JS imports (`slicc_getuid_js`, …). They call `Module.sliccKernel.cred()`, which is synchronous over the existing SAB bridge, and `setuid`-family calls go to `Module.sliccKernel.setcred(...)`. If the kernel lacks these (older than this work), the shim falls back to 1000, as #171's getppid override does.
- **WASIX:** wasix-libc has no `getuid` import, so `packages/wasix-sysroot/slicc_identity.c` imports two functions from a slicc import module (`slicc_v1.cred_get(out)`, `slicc_v1.cred_set(...)`). The kernel provides them to every WASI program, like `wasix_32v1`. Its static passwd entry goes, replaced by reading `/etc/passwd` the way `slicc_pwd.c` does.
- **Not dependent on the libraries:** enforcement uses the kernel's credentials, never what a library reports. A stale binary that still says 1000 only misinforms itself. The one place a library value matters is a program comparing its own uid with a file's owner, such as git's `safe.directory`, ssh's key checks or sudo-like tools. §8 handles that.

### Signals and the process list
- **`kill`:** POSIX permission. A sender may signal a target if its euid is 0, or if its real or effective uid equals the target's real or saved uid. Otherwise `EPERM`. Today any process may signal any other; this closes #67's "signals limited to its own".
- **`/proc` and `ps`:** with `hidepid`-like behaviour (the `/proc` mount option `hidepid=2`, on by default for non-root once users are on), a process sees only its own uid's processes in `/proc`, `ps` and the client API's `ps()`. Root sees all.
- **`/proc/<pid>/status`:** reports the real credentials.

---

## 4. Files: ownership, modes, enforcement

### What each backend stores

| Backend | Mode | uid/gid | Notes |
|---|---|---|---|
| OPFS (with the IndexedDB sidecar) | stored (`MetaEntry.mode`) | **new: `MetaEntry.uid`, `MetaEntry.gid`** | the sidecar already keys entries by path and survives reloads. Two optional fields, so no schema version bump. |
| OPFS with `metadata: false`, and the Node entry's memory root | in memory | in memory, same fields | |
| tmpfs | stored on the node | **new node fields** | a new file takes the creator's euid and egid (or the directory's gid when the directory is setgid) |
| hostfs | the host's mode, through the driver | **synthesized**: the mount's `uid=`/`gid=` options, default the uid that mounted it | the host's own uids mean nothing in the kernel (the Linux `vfat`/`uid=` model). `chown` gives `EPERM` unless the driver advertises `chown`. |
| fsa (removable) | synthesized from the driver's capabilities (0644 / 0755, or read-only) | synthesized from the mount's `uid=`/`gid=`, default the uid that mounted it | the File System Access API has no owners |
| live VFS / Emscripten's own nodes (`/dev`, `/proc`, `/tmp` in the process) | as today | root for `/dev`/`/proc` and the synthetic `/etc` files; per the process for `/proc/self` | |

**Paths with no stored owner** inherit the owner of their nearest ancestor that has one, and `/` defaults to root:root. That covers every file written before users existed (§8) with no migration pass over OPFS.

**`chown` actually works:**
- **Emscripten:** the kernel's `chown`/`lchown`/`fchown` wrappers (`kernel-streams.ts`) send a kernel `setattr { uid, gid }` over the sync-fs bridge instead of Emscripten's no-op.
- **WASI:** preview1 has no `chown`, so WASI programs can't change owners. homescoop could add a `slicc_v1.fd_chown` if a WASI tool needs it.
- **Who may:** only root may change the owner; the owner may change the group to one it belongs to. As on Linux, `chown` by a non-root clears the setuid/setgid bits.

### Where the checks live
All in the kernel. Neither the process worker nor the C library is trusted. Every file-system request already reaches the kernel through a path that knows the calling process:
- **Process file calls:** they go through the **sync-fs bridge**, one token per process (`sync-fs-token-registry.ts`). The token entry gains a `cred()` getter, and `sync-fs-dispatch.ts` checks before it calls the backend.
- **Kernel descriptors** (`vfs-file.ts`, `fd-*` syscalls): `fd-open` checks on open, as POSIX does. An open descriptor keeps its access mode afterwards, so a `chmod` doesn't revoke an open read.
- **Client API `fs`** (`serve-client.ts` `fsCall`): runs as the client's identity (§6).
- **Exec** (`launcher.ts` `plan`/`resolve`): a program run by path needs the `x` bit for its euid. Commands found through the package catalog (`/usr/bin/<name>`) have no real file to check, so they're executable by everyone, as `/usr/bin` is.

### The rules
Standard POSIX DAC, with no ACLs and no capabilities beyond root:
- **The class decides:** owner bits if the euid matches, group bits if the egid or a supplementary group matches, other bits otherwise. Root passes every check except `x` on a file with no `x` bit at all.
- **Directories:** `x` to traverse, `r` to list, `w`+`x` to create, delete or rename in them.
- **Sticky bit** (`/tmp` is 1777): only a file's owner, the directory's owner or root may delete or rename it.
- **New files:** `mode & ~umask`; the owner is the euid; the group is the egid, or the directory's group if the directory is setgid.
- **Errors:** `EACCES` for a failed check, `EPERM` for a forbidden `chown`/`chmod`/`utimes`. Programs already handle both.

### The layout a fresh root gets

| Path | Mode | Owner |
|---|---|---|
| `/` | 0755 | root |
| `/root` | 0700 | root |
| `/home` | 0755 | root |
| `/home/<user>` | 0700 for a cone; 0750 group-readable by the cone for a scoop (§6) | the user |
| `/tmp` | 1777 | root |
| `/etc` | 0755 | root |
| `/etc/sudoers`, `/etc/sudoers.d` | 0440 / 0750 | root |
| `/node_modules`, `$PNPM_HOME` | 0755 | root (installs run as root, see §8) |
| `/workspace` (today's agent folder, if present) | 0755 | root, until the agent moves its folders to `/home` |

---

## 5. sudo: elevation through the kernel

### The path
v6's `sudo` was policy in the webapp (`/etc/sudoers` `Cmnd`/`Read`/`Write` rules, `NOPASSWD`, self-protection, a 5-minute timeout; `docs/approvals.md`). In the kernel it becomes one syscall, with no setuid binary:

```
proc-sudo { argv, user = 'root', reason? } → { pid } | errno
```

The `sudo` command is a small kernel-native program, now possible as an `abi: 'js'` program after #174, or a homescoop C shim. It calls `proc-sudo` and waits for the child like `exec`. The kernel:
1. **Checks policy** in `/etc/sudoers` and `/etc/sudoers.d/*`, with v6's grammar extended by a principal: `[NOPASSWD] <user|%group|ALL> Cmnd <glob>`, with `ALL Cmnd *` meaning anyone, anything.
   - No matching rule: `EPERM` ("not in sudoers"), and no prompt is shown.
   - A matching `NOPASSWD` grant: no prompt.
   - Any other match: an approval.
2. **Asks for approval** through a new page hook:
   ```ts
   createKernel({
     approve?(req: {
       kind: 'sudo';
       uid: number;
       user: string;
       target: string;
       argv: string[];
       cwd: string;
       reason?: string;
       pid: number;
     }): Promise<'once' | 'always' | 'deny'>
   })
   ```
   The page owns the UI: bios's prompt today, plan PR 25's `question` part tomorrow.
   - **Fails closed:** no hook, a rejection or a malformed answer gives `deny`.
   - **Timeout:** 5 minutes, then `ETIMEDOUT`, reported as v6 did ("unanswered", not "refused").
   - **`always`** appends a `NOPASSWD <user> Cmnd <argv-glob>` line to `/etc/sudoers.d/<user>`, written by the kernel as root.
3. **Starts the child** as the target user: real, effective and saved ids, groups from `/etc/group`, `HOME`/`USER`/`LOGNAME` set, cwd kept. Its exit status becomes `sudo`'s. A denial exits 1 with `sudo: approval denied`, as in v6.

### The rest
- **Self-protection** falls out of ownership: `/etc/sudoers*` is root-owned 0440. A non-root process can't touch it, and root (the human or an approved `sudo`) can.
- **Who can `sudo` by default:** the `sudo` group, with one default rule `%sudo Cmnd *`, approval required. Cone users are in it; scoop users aren't (§6).
- **v6's `Read`/`Write` rules** become plain file permissions (`chmod`/`chown`), plus `sudo` for the occasional elevated access. They don't need their own gate.

### How plan PR 25 hooks in
The kernel does the policy and the elevation. slicc-agent and slicc-bios provide `approve()`:
- **bios:** shows the prompt when the human is the approver (no agent running).
- **slicc-agent:** turns a sudo request into a `question` part in the requesting conversation, routed to the cone (or the human) per the approval router in plan §"Approvals, sudo". The same machinery covers guest seats.
- **`beforeTool`** stays the agent's own gate for tool calls that never reach the kernel (browser actions and the like).

---

## 6. The agent mapping

Lars: each cone and each scoop gets its own user, working folders under `/home`.

| Agent object | User | Home and working folder | Groups |
|---|---|---|---|
| the session, the human, the panel terminal | root | `/root` | root |
| cone `cone` (the first) | `cone`, normally uid 1000 | `/home/cone` (0700) | `cone`, `users`, `sudo` |
| cone `cone-<n>` | `cone-<n>` | `/home/cone-<n>` | likewise |
| scoop `<folder>` of cone C | `scoop-<folder>` | `/home/scoop-<folder>` (0750, group C), replacing today's `/scoops/<folder>/workspace` | `scoop-<folder>`, `users` (no `sudo`) |

The group is what lets a cone read its scoops' work, the same thing today's read-only cone folder gives the other way round. A scoop can't read the cone's home or another scoop's home (0700, or 0750 with a group it isn't in). `/tmp` stays shared scratch (sticky), as v6's built-in `/tmp` grant did.

### The kernel API the agent uses
- **`kernel.users`** (page and root clients only):
  - `add({ name, home?, groups?, umask? })` returns `{ uid, gid, home }`. It creates the user and home and appends to `/etc/passwd` and `/etc/group`.
  - `remove(name, { keepHome })` and `list()`.
- **`kernel.connect({ user })`** returns a client port bound to that user. That's a capability: its `spawn`, `run`, `openTerminal`, `fs`, `ps` and `kill` act as that user, and only `sudo` can raise it. A root client may connect for any user; a non-root client can only connect for itself. This replaces the agent's path checks in its read/write/edit tools: the kernel enforces them.
- **`spawn(argv, { user })`** on a root client: a one-off without a new port.

### What a scoop can see (#67's goals)
- **Files:** DAC on `/home`, `/root` and `/etc/sudoers*`, which covers the read/write limits slicc-agent enforces in its tools today.
  - The rest of `/` stays readable, as on a Linux box. That includes `/node_modules`, `/usr`, `/etc`, `/tmp`, and `/workspace` if it remains.
  - #67's stronger options (chroot-like views, read-only mounts per process) can follow on top of users with no change to this model: per-user mount namespaces later.
- **Processes:** `hidepid`, plus POSIX `kill` permission. A scoop sees and signals only its own uid's processes. `spawn({ pgid })` (already in the kernel) keeps a scoop's processes in one group.
- **Network:** per Lars's Tailscale decision, the whole machine gets the network, with no per-user policy. If one's ever wanted, the uid is the natural key.

---

## 7. Lifecycle and persistence

- **Persistence:** `/etc/passwd`, `/etc/group` and `/etc/sudoers*` live in OPFS and survive reloads. So do owners and modes, through the sidecar.
- **The kernel doesn't remember agents;** slicc-agent does. On session load it calls `users.add` idempotently: an existing name returns its ids.
- **Dropping a scoop** (`dropped` in `slicc.agents`): `users.remove(name, { keepHome: true })` keeps its files, owned by a now-unnamed uid that `ls` shows numerically. The agent may archive them, then remove them as root.

---

## 8. Migration and compatibility

Everything runs as uid 1000 today, with no enforcement. Turning both on at once would break real workflows:

| Risk | Example | Mitigation |
|---|---|---|
| Owner checks in programs | git's `safe.directory` ("dubious ownership") compares the repo's owner with `geteuid()`. An old git binary reports 1000 while the repo is owned by root. | Ship the shim updates (§3) **before** ownership is visible. Until then the kernel reports a file's owner as the caller's euid whenever the caller is the legacy 1000. That's the compat mode below. |
| Files from before users | an OPFS root with no stored owners | Inheritance from the ancestor (§4): `/` is root, so everything is root-owned; homes created by `users.add` are owned correctly. The agent moves a scoop's folder from `/scoops/<f>` to `/home/scoop-<f>` (one `rename`, then `chown -R` as root). |
| Tools that refuse or warn as root | pip ("running as root"), npm lifecycle scripts, `ssh` (fine as root) | Installs run as root on purpose: `/node_modules` must be root-owned, so scoops can't plant code that cones run. Agent tools run as their cone or scoop user, not root. |
| Key and permission checks | `ssh` refuses a key with mode > 0600; gpg warns on its home dir | Modes are stored already. `ssh-keygen` writes 0600, and users' homes are 0700. |
| Packages that `chmod +x` and expect exec | build scripts producing `./configure` | Enforcement checks `x` for direct-path exec. Packages setting it is the norm; the catalog path is unaffected. |
| Emscripten programs with no chown support | — | `chown` through the kernel (§4) |

### Rollout, each step a minor release with a client-protocol bump
1. **Credentials and identity.**
   - Process credentials, `proc-cred`/`proc-setcred`, `slicc_v1` imports, `/proc` status, POSIX `kill` permission.
   - `kernel.users` and `connect({ user })`.
   - Everyone defaults to root, the page included. No file checks yet.
   - homescoop updates `slicc_libc_gaps.c` and `slicc_identity.c` against it.
2. **Ownership.** uid/gid stored per backend, real `chown`, owners in `stat`, the fresh-root layout. Still no enforcement. A compat flag, `users: 'report'`, lets certs exercise it.
3. **Enforcement**, opt-in through `createKernel({ users: 'enforce' })`: DAC, sticky bit, exec `x`, `hidepid`. slicc-agent switches to per-cone and per-scoop users here, and #67 closes on this step.
4. **sudo:** `proc-sudo`, `/etc/sudoers` parsing, the `approve()` hook, the `sudo` program. Plan PR 25 builds on it.
5. **Enforcement by default**, once seven and the certs have run with it.

---

## 9. Test plan

**Unit** (Node, fakes; the kernel already has fakes for each layer):
- **credentials:** fork, exec and spawn inheritance; the `setuid`/`setresuid`/`setgroups` matrix for root and non-root (POSIX table); umask inheritance.
- **DAC:** a matrix over owner, group and other × r/w/x × file and directory, with root's overrides. Includes:
  - sticky `/tmp` (delete and rename by others refused);
  - setgid directories passing on their group;
  - `chown`/`chmod` rules and setuid/setgid clearing on chown.
- **ownership storage:** each backend, as stored or synthesized per §4; inheritance from the nearest owned ancestor; the OPFS sidecar round trip across a reopen.
- **`/etc/passwd` and `/etc/group`:** parsing, `users.add`/`remove` idempotence and id allocation, and refusing non-root edits.
- **`kill`:** permission per POSIX; `hidepid` filtering in `/proc`, `ps` and the client's `ps()`.
- **sudo:**
  - policy matching (`NOPASSWD`, `%group`, no rule gives `EPERM`);
  - `approve()` answering `once`/`always`/`deny`, throwing, or never answering (fake timers, 5-minute timeout);
  - `always` writing `/etc/sudoers.d/<user>`, and the self-protection writes.

**Node entry** (real bash, coreutils, Python and git):
- `id`, `whoami` and `ls -l` as root, a cone and a scoop. Python `os.getuid()` and `pwd.getpwuid()` (WASIX) agree with the kernel.
- A scoop can't read `/home/cone` (`EACCES`), can read its own home, can write `/tmp` and can't delete another user's `/tmp` file. A cone can read its scoop's home (group).
- `chmod 000 f; cat f` fails for the owner unless root; `chmod +x` makes a script runnable by path.
- git in a repo owned by the current user works, and one owned by another user gives the `safe.directory` error (as on Linux); `ssh-keygen` key modes.
- `kill` across users gives `EPERM`; `ps` shows only one's own processes.
- `sudo id` with a fake `approve()`: `uid=0` after `once`, `EPERM` without a rule, exit 1 after `deny`.

**Chromium** (integration harness):
- Owners and modes persist in the OPFS sidecar across a reload.
- An OPFS root written by 1.30 (no owners) migrates by inheritance.
- The page's `approve()` hook is called from a real `sudo`.

**Cert** (homescoop):
- The rebuilt `slicc_libc_gaps.c` and `slicc_identity.c` report the kernel's ids.
- Unchanged binaries still run with `users: 'report'`.

---

## 10. Open questions for Lars

1. **Scoop homes:** group-readable by their cone (0750, recommended), or fully private (0700), with the cone reading only through `sudo`?
2. **The panel terminal:** root (recommended, it's the human), or the first cone's user, with `sudo` for root?
3. **`/workspace`:** keep it as a shared, root-owned 0755 folder, or retire it in favour of `/home/<user>`?
4. **Users' names:** `cone`/`cone-<n>`/`scoop-<folder>` (recommended, predictable), or ids derived from the conversation?
5. **The `users: 'enforce'` default** (step 5): after seven runs with it for a while, or from the start for new roots?
