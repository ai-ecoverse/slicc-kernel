#include <fcntl.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

__attribute__((import_module("slicc"), import_name("fcntl_lock"))) int k_lock(int fd, int cmd, void *flock);

struct klock {
  int16_t type;
  int16_t whence;
  int32_t pad;
  int64_t start;
  int64_t len;
  int32_t pid;
  int32_t tail;
};

_Static_assert(sizeof(struct klock) == 32, "struct flock is 32 bytes");

static int fds[8];

static const char *name(int e) {
  switch (e) {
  case 0: return "ok";
  case 6: return "EAGAIN";
  case 8: return "EBADF";
  case 16: return "EDEADLK";
  case 27: return "EINTR";
  case 28: return "EINVAL";
  case 52: return "ENOSYS";
  default: return "other";
  }
}

static int type_of(const char *t) { return t[0] == 'r' ? 0 : t[0] == 'w' ? 1 : t[0] == 'u' ? 2 : atoi(t); }

static void fill(struct klock *l, const char *t, const char *w, const char *s, const char *n) {
  memset(l, 0x5a, sizeof *l);
  l->type = (int16_t)type_of(t);
  l->whence = (int16_t)atoi(w);
  l->start = atoll(s);
  l->len = atoll(n);
}

static void sleep_ms(int ms) {
  struct timespec ts = {ms / 1000, (ms % 1000) * 1000000L};
  nanosleep(&ts, NULL);
}

static void await_file(const char *path) {
  struct stat st;
  while (stat(path, &st) != 0) sleep_ms(20);
}

static void touch(const char *path) { close(open(path, O_CREAT | O_WRONLY, 0644)); }

static void report_get(struct klock *l, const struct klock *before) {
  if (l->type == 2) {
    struct klock want = *before;
    want.type = 2;
    printf("get unlck%s\n", memcmp(l, &want, sizeof want) ? " touched" : " untouched");
    return;
  }
  printf("get %s %d %lld %lld pid=%d pad=%s\n", l->type ? "w" : "r", l->whence, (long long)l->start,
         (long long)l->len, (int)l->pid, l->pad == 0x5a5a5a5a && l->tail == 0x5a5a5a5a ? "kept" : "touched");
}

static void on_signal(int sig) { (void)sig; }

int main(int argc, char **argv) {
  setvbuf(stdout, NULL, _IONBF, 0);
  for (int i = 1; i < argc; i++) {
    const char *op = argv[i];
    if (!strcmp(op, "open")) {
      int slot = atoi(argv[++i]);
      const char *m = argv[++i];
      int flags = !strcmp(m, "r") ? O_RDONLY : !strcmp(m, "w") ? O_WRONLY | O_CREAT : O_RDWR | O_CREAT;
      fds[slot] = open(argv[++i], flags, 0644);
      if (fds[slot] < 0) { perror("open"); return 1; }
    } else if (!strcmp(op, "set") || !strcmp(op, "setw") || !strcmp(op, "get")) {
      int slot = atoi(argv[++i]);
      struct klock l;
      fill(&l, argv[i + 1], argv[i + 2], argv[i + 3], argv[i + 4]);
      i += 4;
      struct klock before = l;
      int cmd = !strcmp(op, "get") ? 12 : !strcmp(op, "set") ? 13 : 14;
      int e = k_lock(fds[slot], cmd, &l);
      if (e || cmd != 12) printf("%s %s\n", op, name(e));
      else report_get(&l, &before);
    } else if (!strcmp(op, "cmd")) {
      int slot = atoi(argv[++i]);
      struct klock l;
      fill(&l, "w", "0", "0", "1");
      printf("cmd %s\n", name(k_lock(fds[slot], atoi(argv[++i]), &l)));
    } else if (!strcmp(op, "badfd")) {
      struct klock l;
      fill(&l, "w", "0", "0", "1");
      printf("badfd %s\n", name(k_lock(999, 13, &l)));
    } else if (!strcmp(op, "seek")) {
      int slot = atoi(argv[++i]);
      lseek(fds[slot], atoll(argv[++i]), SEEK_SET);
    } else if (!strcmp(op, "close")) {
      close(fds[atoi(argv[++i])]);
    } else if (!strcmp(op, "touch")) {
      touch(argv[++i]);
    } else if (!strcmp(op, "await")) {
      await_file(argv[++i]);
    } else if (!strcmp(op, "sleep")) {
      sleep_ms(atoi(argv[++i]));
    } else if (!strcmp(op, "pid")) {
      printf("pid %d\n", (int)getpid());
    } else if (!strcmp(op, "trap")) {
      struct sigaction sa;
      memset(&sa, 0, sizeof sa);
      sa.sa_handler = on_signal;
      sigaction(SIGUSR1, &sa, NULL);
    } else if (!strcmp(op, "fork")) {
      int slot = atoi(argv[++i]);
      pid_t parent = getpid();
      pid_t child = fork();
      if (child == 0) {
        struct klock l;
        fill(&l, "w", "0", "0", "0");
        int e = k_lock(fds[slot], 12, &l);
        if (e) printf("child get %s\n", name(e));
        else printf("child get %s parent=%d\n", l.type == 1 ? "w" : "other", l.pid == parent);
        fill(&l, "w", "0", "0", "0");
        printf("child set %s\n", name(k_lock(fds[slot], 13, &l)));
        _exit(0);
      }
      int status = 0;
      waitpid(child, &status, 0);
    } else {
      fprintf(stderr, "unknown op %s\n", op);
      return 2;
    }
  }
  return 0;
}
