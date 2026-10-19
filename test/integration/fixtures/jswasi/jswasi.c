typedef unsigned int u32;
typedef unsigned long long u64;
typedef unsigned short u16;
typedef unsigned char u8;

#define WASI(name) __attribute__((import_module("wasi_snapshot_preview1"), import_name(#name)))

typedef struct { const u8 *buf; u32 len; } ciovec;
typedef struct { u8 *buf; u32 len; } iovec;

WASI(fd_write) u16 fd_write(u32 fd, const ciovec *iovs, u32 n, u32 *out);
WASI(fd_read) u16 fd_read(u32 fd, const iovec *iovs, u32 n, u32 *out);
WASI(fd_close) u16 fd_close(u32 fd);
WASI(fd_readdir) u16 fd_readdir(u32 fd, u8 *buf, u32 len, u64 cookie, u32 *used);
WASI(fd_prestat_get) u16 fd_prestat_get(u32 fd, u8 *out);
WASI(fd_prestat_dir_name) u16 fd_prestat_dir_name(u32 fd, u8 *buf, u32 len);
WASI(fd_renumber) u16 fd_renumber(u32 from, u32 to);
WASI(path_open) u16 path_open(u32 dirfd, u32 flags, const char *path, u32 len, u16 oflags, u64 base, u64 inh, u16 fdflags, u32 *out);
WASI(path_create_directory) u16 path_create_directory(u32 dirfd, const char *path, u32 len);
WASI(args_sizes_get) u16 args_sizes_get(u32 *count, u32 *size);
WASI(args_get) u16 args_get(u8 **argv, u8 *buf);
WASI(environ_sizes_get) u16 environ_sizes_get(u32 *count, u32 *size);
WASI(environ_get) u16 environ_get(u8 **env, u8 *buf);
WASI(clock_time_get) u16 clock_time_get(u32 id, u64 precision, u64 *out);
WASI(random_get) u16 random_get(u8 *buf, u32 len);
typedef struct {
  u64 userdata;
  u8 tag;
  u8 pad[7];
  u32 fd_or_clock;
  u32 pad2;
  u64 timeout;
  u64 precision;
  u16 flags;
  u8 pad3[6];
} subscription;
typedef struct {
  u64 userdata;
  u16 error;
  u8 type;
  u8 pad[5];
  u64 nbytes;
  u16 flags;
  u8 pad2[6];
} event;
WASI(poll_oneoff) u16 poll_oneoff(const subscription *in, event *out, u32 n, u32 *got);
WASI(proc_exit) _Noreturn void proc_exit(u32 code);

static u32 len_of(const char *s) {
  u32 n = 0;
  while (s[n]) n++;
  return n;
}

static void put(u32 fd, const char *s, u32 n) {
  ciovec v = {(const u8 *)s, n};
  u32 out;
  fd_write(fd, &v, 1, &out);
}

static void say(const char *s) { put(1, s, len_of(s)); }

static void num(u32 v) {
  char b[12];
  int i = 11;
  b[i] = 0;
  do {
    b[--i] = (char)('0' + v % 10);
    v /= 10;
  } while (v);
  say(b + i);
}

static u16 open_at(u32 dir, const char *path, u16 oflags, u32 *fd) {
  return path_open(dir, 1, path, len_of(path), oflags, ~0ULL, ~0ULL, 0, fd);
}

static u8 heap[65536];

static void io(void) {
  u32 fd, n;
  if (open_at(3, "in.txt", 0, &fd)) {
    say("no in.txt\n");
    return;
  }
  iovec v = {heap, sizeof heap};
  fd_read(fd, &v, 1, &n);
  put(1, (const char *)heap, n);
  fd_close(fd);
  if (open_at(3, "sub/out.txt", 1 | 8, &fd) == 44) {
    path_create_directory(3, "sub", 3);
    open_at(3, "sub/out.txt", 1 | 8, &fd);
  }
  put(fd, "written by the guest\n", 21);
  fd_close(fd);
  u32 dir, used;
  open_at(3, ".", 2, &dir);
  fd_readdir(dir, heap, sizeof heap, 0, &used);
  u32 count = 0;
  for (u32 at = 0; at + 24 <= used;) {
    u32 namelen = *(u32 *)(heap + at + 16);
    count++;
    at += 24 + namelen;
  }
  fd_close(dir);
  say("entries ");
  num(count);
  say("\n");
}

static void escape(void) {
  u32 fd;
  say("dotdot ");
  num(open_at(3, "../outside.txt", 0, &fd));
  say(" absolute ");
  num(open_at(3, "/etc", 0, &fd));
  say(" inner dotdot ");
  u16 e = open_at(3, "sub/../in.txt", 0, &fd);
  num(e);
  say(" file as dir ");
  u32 inner;
  num(open_at(fd, "x", 0, &inner));
  if (!e) fd_close(fd);
  say(" stdin as dir ");
  num(open_at(0, "x", 0, &inner));
  say("\n");
}

static void collide(void) {
  u32 fd, n;
  open_at(3, "guest.txt", 1 | 8, &fd);
  say("guest fd ");
  num(fd);
  say("\n");
  put(fd, "guest bytes\n", 12);
  u32 other = 9;
  say("renumber ");
  num(fd_renumber(fd, other));
  say(" ");
  num(fd_renumber(fd, 7));
  say(" ");
  u32 more;
  open_at(3, "guest2.txt", 1 | 8, &more);
  num(fd_renumber(fd, more));
  say("\n");
  put(more, "after renumber\n", 15);
  fd_close(more);
  iovec v = {heap, 4};
  say("stray fd 5 ");
  num(fd_read(5, &v, 1, &n));
  say("\n");
}

static void leak(void) {
  u32 fd;
  for (int i = 0; i < 3; i++) open_at(3, "in.txt", 0, &fd);
}

static void prestat(void) {
  u8 out[8];
  for (u32 fd = 3; fd < 10; fd++) {
    if (fd_prestat_get(fd, out)) break;
    u32 n = *(u32 *)(out + 4);
    fd_prestat_dir_name(fd, heap, n);
    heap[n] = 0;
    say("preopen ");
    num(fd);
    say(" ");
    say((const char *)heap);
    say("\n");
  }
}

static void args(void) {
  u32 count, size;
  args_sizes_get(&count, &size);
  u8 **argv = (u8 **)heap;
  args_get(argv, heap + 1024);
  for (u32 i = 0; i < count; i++) {
    say((const char *)argv[i]);
    say(i + 1 < count ? " " : "\n");
  }
  environ_sizes_get(&count, &size);
  environ_get(argv, heap + 1024);
  for (u32 i = 0; i < count; i++) {
    say((const char *)argv[i]);
    say("\n");
  }
  u64 t = 0;
  u8 r[8] = {0};
  clock_time_get(0, 1, &t);
  random_get(r, 8);
  say(t > 0 ? "clock ok\n" : "clock zero\n");
}

static void thread_write(u32 n) {
  u32 fd;
  char name[] = "t-0.txt";
  name[2] = (char)('0' + n % 10);
  open_at(3, name, 1 | 8, &fd);
  put(fd, name, 7);
  fd_close(fd);
}

static void poll(void) {
  subscription subs[3] = {0};
  subs[0].userdata = 10;
  subs[0].tag = 1;
  subs[0].fd_or_clock = 0;
  subs[1].userdata = 11;
  subs[1].tag = 1;
  subs[1].fd_or_clock = 42;
  subs[2].userdata = 12;
  subs[2].tag = 0;
  subs[2].fd_or_clock = 1;
  subs[2].timeout = 1000000000ULL;
  event out[3];
  u32 got = 0;
  u16 e = poll_oneoff(subs, out, 3, &got);
  say("poll ");
  num(e);
  say(" got ");
  num(got);
  for (u32 i = 0; i < got; i++) {
    say(" ");
    num((u32)out[i].userdata);
    say(":");
    num(out[i].error);
  }
  say(" fds kept ");
  num(subs[0].fd_or_clock);
  say(",");
  num(subs[1].fd_or_clock);
  say("\n");
}

static void mkdir_ro(void) {
  say("mkdir ");
  num(path_create_directory(3, "made", 4));
  say("\n");
}

__attribute__((export_name("run"))) u32 run(u32 mode) {
  switch (mode) {
    case 1: io(); break;
    case 2: escape(); break;
    case 3: collide(); break;
    case 4: leak(); break;
    case 5: proc_exit(3);
    case 6: prestat(); break;
    case 7: args(); break;
    case 8: mkdir_ro(); break;
    case 9: poll(); break;
    default: if (mode >= 100) thread_write(mode - 100); break;
  }
  return mode;
}

__attribute__((export_name("_start"))) void _start(void) {
  args();
  proc_exit(4);
}
