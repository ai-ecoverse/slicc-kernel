#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <signal.h>
#include <stdatomic.h>
#include <sys/stat.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include <wasi/api.h>

#define GUARD 64
#define RING 512
#define LATE_NS 200000000LL
#define FILL 0x5a

struct block {
  unsigned char *base;
  size_t len;
  size_t used;
  long long at;
  const char *op;
  unsigned char tag;
};

static _Atomic long calls, late, interrupted, timeouts, stale;
static _Atomic int failed, stop;
static int pipes[2];
static int iters = 300;
static int bulk;
static _Atomic long ok[10];
static pthread_t workers[64];
static _Atomic int nworkers;
static int alive[64];
static pthread_mutex_t pool = PTHREAD_MUTEX_INITIALIZER;

static long long now_ns(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (long long)ts.tv_sec * 1000000000LL + ts.tv_nsec;
}

static void fail(const char *op, const char *where, long off, int tag) {
  if (atomic_exchange(&failed, 1)) return;
  printf("canary: BAD op=%s %s offset %ld (tag %d)\n", op, where, off, tag);
  fflush(stdout);
}

static unsigned char *guarded(struct block *b, size_t len, const char *op, unsigned char tag) {
  b->base = malloc(len + 2 * GUARD);
  b->len = len;
  b->used = len;
  b->op = op;
  b->tag = tag;
  if (!b->base) {
    printf("canary: malloc(%zu) failed\n", len + 2 * GUARD);
    fflush(stdout);
    _Exit(3);
  }
  if ((size_t)b->base + len + 2 * GUARD > __builtin_wasm_memory_size(0) * 65536) atomic_fetch_add(&stale, 1);
  if (bulk) {
    memset(b->base, tag, GUARD);
    memset(b->base + GUARD, FILL, len);
    memset(b->base + GUARD + len, tag, GUARD);
    return b->base + GUARD;
  }
  volatile unsigned char *v = b->base;
  for (size_t i = 0; i < GUARD; i++) v[i] = tag;
  for (size_t i = 0; i < len; i++) v[GUARD + i] = FILL;
  for (size_t i = 0; i < GUARD; i++) v[GUARD + len + i] = tag;
  return b->base + GUARD;
}

static void check(struct block *b) {
  for (long i = 0; i < GUARD; i++) {
    if (b->base[i] != b->tag) fail(b->op, "before the buffer at", i - GUARD, b->tag);
    if (b->base[GUARD + b->len + i] != b->tag) fail(b->op, "after the buffer at", (long)b->len + i, b->tag);
  }
  for (size_t i = b->used; i < b->len; i++) {
    if (b->base[GUARD + i] != FILL) {
      fail(b->op, "past the reported length at", (long)i, b->tag);
      break;
    }
  }
}

static void settle(struct block *ring, int *n, int all) {
  long long t = now_ns();
  int kept = 0;
  for (int i = 0; i < *n; i++) {
    check(&ring[i]);
    if (all || t - ring[i].at >= LATE_NS) {
      atomic_fetch_add(&late, 1);
      free(ring[i].base);
    } else {
      ring[kept++] = ring[i];
    }
  }
  *n = kept;
}

static void keep(struct block *ring, int *n, struct block *b) {
  check(b);
  b->at = now_ns();
  atomic_fetch_add(&calls, 1);
  if (*n == RING) {
    struct timespec wait = {0, 210000000};
    nanosleep(&wait, 0);
    settle(ring, n, 1);
  }
  ring[(*n)++] = *b;
}

static size_t sizes[] = {1, 7, 64, 255, 4096, 65535, 65536, 65537, 200000};
#define NSIZES (sizeof sizes / sizeof sizes[0])

static void one(int self, int i, struct block *ring, int *n) {
  unsigned char tag = (unsigned char)(0xa0 + self);
  size_t len = sizes[(self + i) % NSIZES];
  struct block b;
  __wasi_size_t used = 0;
  int okc = 0;
  switch (i % 10) {
    case 0: {
      int fd = open("data/big", O_RDONLY);
      unsigned char *p = guarded(&b, len, "fd_read", tag);
      __wasi_iovec_t v = {p, len};
      if (fd >= 0 && __wasi_fd_read(fd, &v, 1, &used) == 0) {
        b.used = used;
        okc = 1;
      }
      if (fd >= 0) close(fd);
      break;
    }
    case 1: {
      int fd = open("data/big", O_RDONLY);
      unsigned char *p = guarded(&b, len, "fd_pread", tag);
      size_t half = len / 2;
      __wasi_iovec_t v[2] = {{p, half}, {p + half, len - half}};
      if (fd >= 0 && __wasi_fd_pread(fd, v, 2, (i * 997) % 300000, &used) == 0) {
        b.used = used;
        okc = 1;
      }
      if (fd >= 0) close(fd);
      break;
    }
    case 2: {
      int fd = open("data/dir", O_RDONLY | O_DIRECTORY);
      unsigned char *p = guarded(&b, len, "fd_readdir", tag);
      if (fd >= 0 && __wasi_fd_readdir(fd, p, len, (__wasi_dircookie_t)(i % 5), &used) == 0) {
        b.used = used;
        okc = 1;
      }
      if (fd >= 0) close(fd);
      break;
    }
    case 3: {
      unsigned char *p = guarded(&b, len % 300, "path_readlink", tag);
      if (__wasi_path_readlink(3, "data/link", p, len % 300, &used) == 0) {
        b.used = used;
        okc = 1;
      }
      break;
    }
    case 4: {
      unsigned char *p = guarded(&b, sizeof(__wasi_filestat_t), "path_filestat_get", tag);
      b.used = sizeof(__wasi_filestat_t);
      okc = !__wasi_path_filestat_get(3, i & 1, (i & 2) ? "data/link" : "data/big", (__wasi_filestat_t *)p);
      break;
    }
    case 5: {
      int fd = open("data/big", O_RDONLY);
      unsigned char *p = guarded(&b, sizeof(__wasi_filestat_t), "fd_filestat_get", tag);
      b.used = sizeof(__wasi_filestat_t);
      if (fd >= 0) {
        okc = !__wasi_fd_filestat_get(fd, (__wasi_filestat_t *)p);
        close(fd);
      }
      break;
    }
    case 6: {
      unsigned char *p = guarded(&b, len % 1000, "random_get", tag);
      okc = !__wasi_random_get(p, len % 1000);
      break;
    }
    case 7: {
      __wasi_size_t count = 0, size = 0;
      (void)__wasi_environ_sizes_get(&count, &size);
      unsigned char *ptrs = guarded(&b, count * sizeof(void *), "environ_get pointers", tag);
      struct block s;
      unsigned char *buf = guarded(&s, size, "environ_get", tag);
      okc = !__wasi_environ_get((uint8_t **)ptrs, buf);
      keep(ring, n, &s);
      break;
    }
    case 8: {
      unsigned char *p = guarded(&b, len % 4096, "fd_read on a pipe", tag);
      __wasi_iovec_t v = {p, len % 4096};
      __wasi_errno_t e = __wasi_fd_read(pipes[0], &v, 1, &used);
      if (e == 0) {
        b.used = used;
        okc = 1;
      }
      else if (e == __WASI_ERRNO_INTR) atomic_fetch_add(&interrupted, 1);
      break;
    }
    default: {
      __wasi_subscription_t subs[2];
      memset(subs, 0, sizeof subs);
      subs[0].userdata = 1;
      subs[0].u.tag = __WASI_EVENTTYPE_FD_READ;
      subs[0].u.u.fd_read.file_descriptor = pipes[0];
      subs[1].userdata = 2;
      subs[1].u.tag = __WASI_EVENTTYPE_CLOCK;
      subs[1].u.u.clock.id = __WASI_CLOCKID_MONOTONIC;
      subs[1].u.u.clock.timeout = 1000000;
      unsigned char *p = guarded(&b, 2 * sizeof(__wasi_event_t), "poll_oneoff", tag);
      __wasi_size_t got = 0;
      __wasi_errno_t e = __wasi_poll_oneoff(subs, (__wasi_event_t *)p, 2, &got);
      if (e == 0) {
        okc = 1;
        b.used = got * sizeof(__wasi_event_t);
        if (got == 1 && ((__wasi_event_t *)p)->userdata == 2) atomic_fetch_add(&timeouts, 1);
      } else if (e == __WASI_ERRNO_INTR) {
        atomic_fetch_add(&interrupted, 1);
      }
      break;
    }
  }
  atomic_fetch_add(&ok[i % 10], okc);
  keep(ring, n, &b);
}

static void *worker(void *arg) {
  int self = (int)(intptr_t)arg;
  struct block *ring = malloc(sizeof(struct block) * RING);
  int n = 0;
  for (int i = 0; i < iters && !atomic_load(&failed); i++) {
    one(self, i, ring, &n);
    settle(ring, &n, 0);
  }
  struct timespec wait = {0, 250000000};
  nanosleep(&wait, 0);
  settle(ring, &n, 1);
  free(ring);
  pthread_mutex_lock(&pool);
  alive[self] = 0;
  pthread_mutex_unlock(&pool);
  return 0;
}

static void *writer(void *arg) {
  (void)arg;
  char chunk[512];
  memset(chunk, 'p', sizeof chunk);
  struct timespec gap = {0, 2000000};
  while (!atomic_load(&stop)) {
    if (write(pipes[1], chunk, (size_t)(rand() % 511) + 1) < 0 && errno != EINTR) break;
    nanosleep(&gap, 0);
  }
  return 0;
}

static void *signaller(void *arg) {
  (void)arg;
  if (getenv("NOSIG")) return 0;
  int direct = getenv("NOTHREADKILL") == 0;
  struct timespec gap = {0, 2000000};
  while (!atomic_load(&stop)) {
    int w = atomic_load(&nworkers);
    if (direct && w > 0) {
      int pick = rand() % w;
      pthread_mutex_lock(&pool);
      if (alive[pick]) pthread_kill(workers[pick], SIGUSR1);
      pthread_mutex_unlock(&pool);
    }
    kill(getpid(), SIGUSR1);
    nanosleep(&gap, 0);
  }
  return 0;
}

static void *spinner(void *arg) {
  (void)arg;
  volatile unsigned long x = 0;
  while (!atomic_load(&stop)) x++;
  return 0;
}

static void on_usr1(int sig) { (void)sig; }

static int setup(void) {
  char name[128], target[300];
  mkdir("data", 0755);
  mkdir("data/dir", 0755);
  int fd = open("data/big", O_WRONLY | O_CREAT | O_TRUNC, 0644);
  if (fd < 0) return 1;
  static unsigned char big[400000];
  for (size_t i = 0; i < sizeof big; i++) big[i] = (unsigned char)(i * 31);
  if (write(fd, big, sizeof big) != (ssize_t)sizeof big) return 1;
  close(fd);
  for (int i = 0; i < 40; i++) {
    snprintf(name, sizeof name, "data/dir/entry-with-a-longer-name-%d", i);
    fd = open(name, O_WRONLY | O_CREAT, 0644);
    if (fd < 0) return 1;
    close(fd);
  }
  memset(target, 'z', 250);
  memcpy(target, "/data/a/target", 14);
  target[250] = 0;
  unlink("data/link");
  return symlink(target, "data/link") != 0;
}

int main(int argc, char **argv) {
  int threads = argc > 1 ? atoi(argv[1]) : 6;
  if (argc > 2) iters = atoi(argv[2]);
  bulk = argc > 3 && strcmp(argv[3], "bulk") == 0;
  struct sigaction sa;
  memset(&sa, 0, sizeof sa);
  sa.sa_handler = on_usr1;
  sigaction(SIGUSR1, &sa, 0);
  signal(SIGPIPE, SIG_IGN);
  if (setup() != 0) {
    printf("canary: setup failed (%d)\n", errno);
    return 2;
  }
  if (pipe(pipes) != 0) return 2;
  pthread_t helpers[4];
  if (threads > 64) threads = 64;
  pthread_create(&helpers[0], 0, writer, 0);
  pthread_create(&helpers[1], 0, signaller, 0);
  pthread_create(&helpers[2], 0, spinner, 0);
  pthread_create(&helpers[3], 0, spinner, 0);
  for (int t = 0; t < threads; t++) {
    alive[t] = 1;
    pthread_create(&workers[t], 0, worker, (void *)(intptr_t)t);
    atomic_store(&nworkers, t + 1);
  }
  for (int t = 0; t < threads; t++) pthread_join(workers[t], 0);
  atomic_store(&nworkers, 0);
  atomic_store(&stop, 1);
  close(pipes[0]);
  for (int h = 0; h < 4; h++) pthread_join(helpers[h], 0);
  printf("canary: %s, %ld calls, %ld checked 200 ms later, %ld interrupted, %ld timed out, %ld stale memory.size\n",
         atomic_load(&failed) ? "FAIL" : "clean", atomic_load(&calls), atomic_load(&late),
         atomic_load(&interrupted), atomic_load(&timeouts), atomic_load(&stale));
  printf("canary: answered with data:");
  for (int i = 0; i < 10; i++) printf(" %ld", atomic_load(&ok[i]));
  printf("\n");
  return atomic_load(&failed) ? 1 : 0;
}
