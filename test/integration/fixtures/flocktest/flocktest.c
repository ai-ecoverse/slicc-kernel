#include <fcntl.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

__attribute__((import_module("slicc"), import_name("flock"))) int k_flock(int fd, int op);
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

static int fds[8];
static const char *who = "";

static const char *name(int e) {
  switch (e) {
  case 0: return "ok";
  case 6: return "EAGAIN";
  case 8: return "EBADF";
  case 27: return "EINTR";
  case 28: return "EINVAL";
  case 52: return "ENOSYS";
  default: return "other";
  }
}

static int op_of(const char *t) {
  int op = 0;
  if (strstr(t, "sh")) op |= 1;
  if (strstr(t, "ex")) op |= 2;
  if (strstr(t, "nb")) op |= 4;
  if (strstr(t, "un")) op |= 8;
  return op ? op : atoi(t);
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

static void on_signal(int sig) { (void)sig; }

static int skip_block(int argc, char **argv, int i) {
  int depth = 1;
  for (i++; i < argc; i++) {
    if (!strcmp(argv[i], "fork")) depth++;
    else if (!strcmp(argv[i], "end") && --depth == 0) return i;
  }
  return i;
}

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
    } else if (!strcmp(op, "pipe") || !strcmp(op, "pair")) {
      int a = atoi(argv[++i]), b = atoi(argv[++i]), p[2];
      int rc = !strcmp(op, "pipe") ? pipe(p) : socketpair(AF_UNIX, SOCK_STREAM, 0, p);
      if (rc != 0) { perror(op); return 1; }
      fds[a] = p[0];
      fds[b] = p[1];
    } else if (!strcmp(op, "dup")) {
      int from = atoi(argv[++i]);
      fds[atoi(argv[++i])] = dup(fds[from]);
    } else if (!strcmp(op, "fd")) {
      int slot = atoi(argv[++i]);
      fds[slot] = atoi(argv[++i]);
    } else if (!strcmp(op, "flock")) {
      int slot = atoi(argv[++i]);
      printf("%sflock %s\n", who, name(k_flock(fds[slot], op_of(argv[++i]))));
    } else if (!strcmp(op, "badfd")) {
      printf("%sbadfd %s\n", who, name(k_flock(999, 2)));
    } else if (!strcmp(op, "fcntl")) {
      int slot = atoi(argv[++i]);
      const char *t = argv[++i];
      struct klock l;
      memset(&l, 0, sizeof l);
      l.type = t[0] == 'r' ? 0 : t[0] == 'w' ? 1 : 2;
      printf("%sfcntl %s\n", who, name(k_lock(fds[slot], 13, &l)));
    } else if (!strcmp(op, "fork")) {
      int end = skip_block(argc, argv, i);
      pid_t child = fork();
      if (child == 0) {
        who = "child ";
        continue;
      }
      int status = 0;
      waitpid(child, &status, 0);
      i = end;
    } else if (!strcmp(op, "end")) {
      _exit(0);
    } else if (!strcmp(op, "close")) {
      close(fds[atoi(argv[++i])]);
    } else if (!strcmp(op, "touch")) {
      touch(argv[++i]);
    } else if (!strcmp(op, "await")) {
      await_file(argv[++i]);
    } else if (!strcmp(op, "sleep")) {
      sleep_ms(atoi(argv[++i]));
    } else if (!strcmp(op, "say")) {
      printf("%s%s\n", who, argv[++i]);
    } else if (!strcmp(op, "trap")) {
      struct sigaction sa;
      memset(&sa, 0, sizeof sa);
      sa.sa_handler = on_signal;
      sigaction(SIGUSR1, &sa, NULL);
    } else {
      fprintf(stderr, "unknown op %s\n", op);
      return 2;
    }
  }
  return 0;
}
