#include <errno.h>
#include <pthread.h>
#include <signal.h>
#include <spawn.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
#include <sched.h>
#include <wasi/api_wasix.h>

#define IMPORT(name) __attribute__((import_module("slicc"), import_name(name)))
IMPORT("sem_open") int k_open(const char *name, int len, int oflag, int mode, int value, unsigned *out);
IMPORT("sem_close") int k_close(unsigned h);
IMPORT("sem_unlink") int k_unlink(const char *name, int len);
IMPORT("sem_post") int k_post(unsigned h);
IMPORT("sem_wait") int k_wait(unsigned h, int how, int clock, long long deadline);
IMPORT("sem_getvalue") int k_value(unsigned h, int *out);

#define CREAT 1
#define EXCL 2
#define BLOCK 0
#define TRY 1
#define TIMED 2

extern char **environ;

static const char *err(int e) { return e ? strerror(e) : "ok"; }

static int sopen(const char *name, int oflag, int mode, int value, unsigned *h) {
  return k_open(name, (int)strlen(name), oflag, mode, value, h);
}

static int unlink_name(const char *name) { return k_unlink(name, (int)strlen(name)); }

static int value_of(unsigned h) {
  int v = -1;
  k_value(h, &v);
  return v;
}

static long long now_ns(clockid_t c) {
  struct timespec ts;
  clock_gettime(c, &ts);
  return (long long)ts.tv_sec * 1000000000LL + ts.tv_nsec;
}

static int handoff(void) {
  unsigned a, b;
  printf("create %s\n", err(sopen("/ping", CREAT | EXCL, 0600, 0, &a)));
  sopen("/pong", CREAT, 0600, 0, &b);
  pid_t p = fork();
  if (p == 0) {
    unsigned ca, cb;
    sopen("ping", 0, 0, 0, &ca);
    sopen("/pong", 0, 0, 0, &cb);
    for (int i = 0; i < 100; i++) {
      if (k_wait(ca, BLOCK, 0, 0)) _exit(1);
      if (k_post(cb)) _exit(2);
    }
    _exit(0);
  }
  int rounds = 0;
  for (int i = 0; i < 100; i++) {
    k_post(a);
    if (k_wait(b, BLOCK, 0, 0) == 0) rounds++;
  }
  int st;
  waitpid(p, &st, 0);
  printf("pingpong %d child %d\n", rounds, WEXITSTATUS(st));
  return 0;
}

static int inherit(void) {
  unsigned h;
  sopen("/inh", CREAT, 0600, 0, &h);
  pid_t p = fork();
  if (p == 0) _exit(k_post(h));
  int st;
  waitpid(p, &st, 0);
  printf("child post %s, parent wait %s\n", err(WEXITSTATUS(st)), err(k_wait(h, TRY, 0, 0)));
  return 0;
}

static int child_open_post(const char *name, const char *old) {
  unsigned h;
  if (old) printf("exec old handle %s\n", err(k_post((unsigned)atoi(old))));
  int e = sopen(name, 0, 0, 0, &h);
  if (e) return e;
  return k_post(h);
}

static int spawned(void) {
  unsigned h;
  sopen("/spawn", CREAT, 0600, 0, &h);
  pid_t p;
  char *argv[] = {"semtest", "post", "/spawn", NULL};
  printf("spawn %s\n", err(posix_spawnp(&p, "semtest", NULL, NULL, argv, environ)));
  int st;
  waitpid(p, &st, 0);
  printf("spawned child %d, wait %s\n", WEXITSTATUS(st), err(k_wait(h, TIMED, 1, now_ns(CLOCK_MONOTONIC) + 2000000000LL)));
  pid_t q = fork();
  if (q == 0) {
    char num[16];
    snprintf(num, sizeof num, "%u", h);
    execlp("semtest", "semtest", "post", "/spawn", num, (char *)NULL);
    _exit(99);
  }
  waitpid(q, &st, 0);
  printf("exec child %d, wait %s\n", WEXITSTATUS(st), err(k_wait(h, TIMED, 1, now_ns(CLOCK_MONOTONIC) + 2000000000LL)));
  return 0;
}

static int trying(void) {
  unsigned h;
  sopen("/try", CREAT, 0600, 0, &h);
  printf("try %s", err(k_wait(h, TRY, 0, 0)));
  k_post(h);
  k_post(h);
  printf(", value %d", value_of(h));
  printf(", try %s", err(k_wait(h, TRY, 0, 0)));
  printf(", value %d\n", value_of(h));
  return 0;
}

static int timed(void) {
  unsigned h;
  sopen("/timed", CREAT, 0600, 0, &h);
  for (int c = 0; c < 2; c++) {
    clockid_t id = c ? CLOCK_MONOTONIC : CLOCK_REALTIME;
    long long start = now_ns(CLOCK_MONOTONIC);
    int e = k_wait(h, TIMED, c, now_ns(id) + 50000000LL);
    long long took = now_ns(CLOCK_MONOTONIC) - start;
    printf("%s: %s, %s\n", c ? "monotonic" : "realtime", err(e), took >= 50000000LL ? "not early" : "early");
  }
  printf("past deadline, empty: %s\n", err(k_wait(h, TIMED, 0, now_ns(CLOCK_REALTIME) - 1000000LL)));
  k_post(h);
  printf("past deadline, value 1: %s\n", err(k_wait(h, TIMED, 0, now_ns(CLOCK_REALTIME) - 1000000LL)));
  printf("negative deadline: %s\n", err(k_wait(h, TIMED, 0, -1)));
  int early = 0;
  for (int i = 0; i < 100; i++) {
    long long ms = 1 + i % 4, start = now_ns(CLOCK_MONOTONIC);
    k_wait(h, TIMED, 1, start + ms * 1000000LL);
    if (now_ns(CLOCK_MONOTONIC) - start < ms * 1000000LL) early++;
  }
  printf("short waits early %d of 100\n", early);
  return 0;
}

static volatile sig_atomic_t alarms;
static void on_alarm(int sig) {
  (void)sig;
  alarms++;
}

static int interrupted(void) {
  unsigned h;
  sopen("/intr", CREAT, 0600, 0, &h);
  struct sigaction sa = {0};
  sa.sa_handler = on_alarm;
  sigaction(SIGALRM, &sa, NULL);
  struct itimerval it = {.it_value = {.tv_usec = 100000}};
  setitimer(ITIMER_REAL, &it, NULL);
  int e = k_wait(h, BLOCK, 0, 0);
  printf("wait %s, alarms %d, value %d\n", err(e), (int)alarms, value_of(h));
  return 0;
}

static int stopped(void) {
  unsigned h;
  sopen("/stopped", CREAT, 0600, 0, &h);
  pid_t p = fork();
  if (p == 0) {
    long long start = now_ns(CLOCK_MONOTONIC);
    int e = k_wait(h, TIMED, 1, start + 300000000LL);
    long long took = (now_ns(CLOCK_MONOTONIC) - start) / 1000000LL;
    printf("wait %s, %s\n", err(e), took < 300 ? "early" : took < 450 ? "at the deadline" : "late");
    _exit(0);
  }
  usleep(50000);
  kill(p, SIGSTOP);
  usleep(200000);
  kill(p, SIGCONT);
  int st;
  waitpid(p, &st, 0);
  return 0;
}

static unsigned shared;
static int order[3], seen;
static volatile int tids[3];
static pthread_mutex_t lock = PTHREAD_MUTEX_INITIALIZER;

static void *waiter(void *arg) {
  int i = (int)(intptr_t)arg;
  __wasi_tid_t tid = 0;
  if (__wasi_thread_id(&tid)) tid = 0;
  __atomic_store_n(&tids[i], (int)tid, __ATOMIC_SEQ_CST);
  if (k_wait(shared, BLOCK, 0, 0) == 0) {
    pthread_mutex_lock(&lock);
    order[seen++] = i + 1;
    pthread_mutex_unlock(&lock);
  }
  return NULL;
}

static char state_of(int tid) {
  char path[64], buf[256];
  snprintf(path, sizeof path, "/proc/self/task/%d/stat", tid);
  FILE *f = fopen(path, "r");
  if (!f) return '?';
  size_t n = fread(buf, 1, sizeof buf - 1, f);
  fclose(f);
  buf[n] = 0;
  char *close = strrchr(buf, ')');
  return close && close[1] == ' ' ? close[2] : '?';
}

static int threads(void) {
  sopen("/fifo", CREAT, 0600, 0, &shared);
  pthread_t t[3];
  for (int i = 0; i < 3; i++) {
    pthread_create(&t[i], NULL, waiter, (void *)(intptr_t)i);
    int tid;
    while ((tid = __atomic_load_n(&tids[i], __ATOMIC_SEQ_CST)) == 0) sched_yield();
    while (state_of(tid) != 'S') sched_yield();
  }
  printf("main still runs while 3 wait, value %d\n", value_of(shared));
  for (int i = 0; i < 3; i++) {
    k_post(shared);
    while (__atomic_load_n(&seen, __ATOMIC_SEQ_CST) <= i) sched_yield();
  }
  for (int i = 0; i < 3; i++) pthread_join(t[i], NULL);
  printf("woken in order %d %d %d\n", order[0], order[1], order[2]);
  return 0;
}

static int errors(void) {
  unsigned h;
  printf("create %s\n", err(sopen("/e", CREAT | EXCL, 0600, 0, &h)));
  printf("exclusive again %s\n", err(sopen("e", CREAT | EXCL, 0600, 0, &h)));
  printf("missing %s\n", err(sopen("/none", 0, 0, 0, &h)));
  const char *bad[] = {"", "/", "a/b", "/.", "/..", "//x/y"};
  for (int i = 0; i < 6; i++) printf("name '%s' %s\n", bad[i], err(sopen(bad[i], CREAT, 0600, 0, &h)));
  char longname[260];
  memset(longname, 'n', sizeof longname);
  longname[0] = '/';
  longname[252] = 0;
  printf("251 bytes %s\n", err(sopen(longname, CREAT, 0600, 0, &h)));
  longname[252] = 'n';
  longname[253] = 0;
  printf("252 bytes %s\n", err(sopen(longname, CREAT, 0600, 0, &h)));
  printf("value too big %s\n", err(sopen("/big", CREAT, 0600, -1, &h)));
  sopen("/max", CREAT, 0600, 0x7fffffff, &h);
  printf("post at max %s, value %d\n", err(k_post(h)), value_of(h));
  printf("close unknown %s\n", err(k_close(4242)));
  printf("unlink missing %s\n", err(unlink_name("/none")));
  return 0;
}

static int unlinked(void) {
  unsigned a, b, c;
  sopen("/gone", CREAT, 0600, 0, &a);
  sopen("/gone", 0, 0, 0, &b);
  printf("same handle %s\n", a == b ? "yes" : "no");
  printf("unlink %s\n", err(unlink_name("/gone")));
  printf("post after unlink %s, value %d\n", err(k_post(a)), value_of(a));
  printf("reopen %s\n", err(sopen("/gone", 0, 0, 0, &c)));
  printf("recreate %s, %s, new value %d, old value %d\n", err(sopen("/gone", CREAT | EXCL, 0600, 5, &c)), c != a ? "new handle" : "same handle", value_of(c), value_of(a));
  printf("close once %s, still open %s\n", err(k_close(a)), err(k_post(a)));
  printf("close twice %s, now %s\n", err(k_close(a)), err(k_post(a)));
  return 0;
}

static int owners(const char *as) {
  unsigned h;
  if (!strcmp(as, "setup")) {
    umask(0);
    printf("private %s\n", err(sopen("/priv", CREAT, 0600, 0, &h)));
    printf("public %s\n", err(sopen("/pub", CREAT, 0666, 0, &h)));
    return 0;
  }
  printf("private %s\n", err(sopen("/priv", 0, 0, 0, &h)));
  printf("public %s\n", err(sopen("/pub", 0, 0, 0, &h)));
  printf("unlink not owned %s\n", err(unlink_name("/pub")));
  printf("own %s, unlink own %s\n", err(sopen("/mine", CREAT, 0600, 0, &h)), err(unlink_name("/mine")));
  return 0;
}

static int killed(void) {
  unsigned work, done;
  sopen("/work", CREAT, 0600, 0, &work);
  sopen("/done", CREAT, 0600, 0, &done);
  pid_t kids[3];
  for (int i = 0; i < 3; i++) {
    kids[i] = fork();
    if (kids[i] == 0) {
      if (k_wait(work, BLOCK, 0, 0) == 0) k_post(done);
      _exit(0);
    }
  }
  usleep(100000);
  kill(kids[0], SIGKILL);
  for (int i = 0; i < 3; i++) k_post(work);
  int finished = 0;
  for (int i = 0; i < 3; i++)
    if (k_wait(done, TIMED, 1, now_ns(CLOCK_MONOTONIC) + 500000000LL) == 0) finished++;
  for (int i = 0; i < 3; i++) waitpid(kids[i], NULL, 0);
  int left = value_of(work);
  int took = 0;
  while (k_wait(work, TRY, 0, 0) == 0) took++;
  printf("consumed %d, left %d, trywait took %d\n", finished, left, took);
  return 0;
}

static int exited(void) {
  unsigned h;
  sopen("/keep", CREAT, 0600, 2, &h);
  pid_t p = fork();
  if (p == 0) _exit(k_wait(h, BLOCK, 0, 0));
  waitpid(p, NULL, 0);
  printf("value after the child took one and exited %d\n", value_of(h));
  return 0;
}

static int capped(void) {
  unsigned h;
  char name[32];
  int n = 0, e = 0;
  for (; n < 10000; n++) {
    snprintf(name, sizeof name, "/cap%d", n);
    if ((e = sopen(name, CREAT, 0600, 0, &h))) break;
    k_close(h);
  }
  printf("created %d, then %s\n", n, err(e));
  for (int i = 0; i < n; i++) {
    snprintf(name, sizeof name, "/cap%d", i);
    unlink_name(name);
  }
  printf("after unlinking %s\n", err(sopen("/cap", CREAT, 0600, 0, &h)));
  return 0;
}

static int handles(void) {
  unsigned h;
  char name[32];
  int n = 0, e = 0;
  for (; n < 300; n++) {
    snprintf(name, sizeof name, "/h%d", n);
    if ((e = sopen(name, CREAT, 0600, 0, &h))) break;
  }
  printf("opened %d, then %s\n", n, err(e));
  printf("the refused name %s\n", err(sopen(name, 0, 0, 0, &h)));
  return 0;
}

int main(int argc, char **argv) {
  setvbuf(stdout, NULL, _IONBF, 0);
  const char *mode = argc > 1 ? argv[1] : "";
  if (!strcmp(mode, "post")) return child_open_post(argv[2], argc > 3 ? argv[3] : NULL);
  if (!strcmp(mode, "handoff")) return handoff();
  if (!strcmp(mode, "inherit")) return inherit();
  if (!strcmp(mode, "spawn")) return spawned();
  if (!strcmp(mode, "try")) return trying();
  if (!strcmp(mode, "timed")) return timed();
  if (!strcmp(mode, "eintr")) return interrupted();
  if (!strcmp(mode, "stopped")) return stopped();
  if (!strcmp(mode, "threads")) return threads();
  if (!strcmp(mode, "errors")) return errors();
  if (!strcmp(mode, "unlink")) return unlinked();
  if (!strcmp(mode, "owners")) return owners(argc > 2 ? argv[2] : "");
  if (!strcmp(mode, "killed")) return killed();
  if (!strcmp(mode, "exited")) return exited();
  if (!strcmp(mode, "cap")) return capped();
  if (!strcmp(mode, "handles")) return handles();
  fprintf(stderr, "usage: semtest MODE\n");
  return 2;
}
