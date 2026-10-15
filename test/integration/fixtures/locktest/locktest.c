#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

static int fd = -1;

static const char *err(int e) {
  switch (e) {
    case EAGAIN: return "EAGAIN";
    case EACCES: return "EACCES";
    case EBADF: return "EBADF";
    case EINTR: return "EINTR";
    case EDEADLK: return "EDEADLK";
    case EINVAL: return "EINVAL";
    case ENOLCK: return "ENOLCK";
    default: return strerror(e);
  }
}

static short type_of(const char *t) {
  return t[0] == 'r' ? F_RDLCK : t[0] == 'w' ? F_WRLCK : F_UNLCK;
}

static void pause_ms(long ms) {
  struct timespec ts = { ms / 1000, (ms % 1000) * 1000000L };
  nanosleep(&ts, NULL);
}

static void on_alarm(int sig) { (void)sig; }

static int lock(int cmd, char **argv) {
  struct flock fl;
  memset(&fl, 0, sizeof fl);
  fl.l_type = type_of(argv[0]);
  fl.l_whence = SEEK_SET;
  fl.l_start = atoll(argv[1]);
  fl.l_len = atoll(argv[2]);
  int rc = fcntl(fd, cmd, &fl);
  const char *name = cmd == F_GETLK ? "getlk" : cmd == F_SETLKW ? "lockw" : "lock";
  if (rc != 0) printf("%s %s\n", name, err(errno));
  else if (cmd != F_GETLK) printf("%s ok\n", name);
  else if (fl.l_type == F_UNLCK) printf("getlk none\n");
  else
    printf("getlk %c pid=%d start=%lld len=%lld\n", fl.l_type == F_RDLCK ? 'r' : 'w', (int)fl.l_pid,
           (long long)fl.l_start, (long long)fl.l_len);
  fflush(stdout);
  return 3;
}

int main(int argc, char **argv) {
  for (int i = 1; i < argc; i++) {
    const char *op = argv[i];
    if (!strcmp(op, "open") && i + 2 < argc) {
      const char *m = argv[i + 2];
      int flags = !strcmp(m, "r") ? O_RDONLY : !strcmp(m, "w") ? O_WRONLY : O_RDWR;
      fd = open(argv[i + 1], flags | O_CREAT, 0644);
      if (fd < 0) printf("open %s\n", err(errno));
      i += 2;
    } else if (!strcmp(op, "reopen") && i + 1 < argc) {
      int other = open(argv[i + 1], O_RDONLY);
      if (other >= 0) close(other);
      i += 1;
    } else if (!strcmp(op, "close")) {
      close(fd);
    } else if (!strcmp(op, "lock") && i + 3 < argc) {
      i += lock(F_SETLK, argv + i + 1);
    } else if (!strcmp(op, "lockw") && i + 3 < argc) {
      i += lock(F_SETLKW, argv + i + 1);
    } else if (!strcmp(op, "getlk") && i + 3 < argc) {
      i += lock(F_GETLK, argv + i + 1);
    } else if (!strcmp(op, "pid")) {
      printf("pid %d\n", (int)getpid());
    } else if (!strcmp(op, "touch") && i + 1 < argc) {
      close(open(argv[++i], O_WRONLY | O_CREAT, 0644));
    } else if (!strcmp(op, "until") && i + 1 < argc) {
      struct stat st;
      while (stat(argv[i + 1], &st) != 0) pause_ms(20);
      i += 1;
    } else if (!strcmp(op, "sleep") && i + 1 < argc) {
      pause_ms(atol(argv[++i]));
    } else if (!strcmp(op, "alarm") && i + 1 < argc) {
      struct sigaction sa;
      memset(&sa, 0, sizeof sa);
      sa.sa_handler = on_alarm;
      sigaction(SIGALRM, &sa, NULL);
      alarm((unsigned)atoi(argv[++i]));
    } else if (!strcmp(op, "fork")) {
      int end = i + 1;
      while (end < argc && strcmp(argv[end], "end")) end++;
      fflush(stdout);
      pid_t child = fork();
      if (child == 0) {
        argc = end;
        continue;
      }
      int status = 0;
      waitpid(child, &status, 0);
      i = end;
    } else if (!strcmp(op, "exec")) {
      fflush(stdout);
      char **rest = argv + i;
      rest[0] = "locktest";
      char fdarg[16];
      snprintf(fdarg, sizeof fdarg, "%d", fd);
      setenv("LOCKTEST_FD", fdarg, 1);
      execvp("locktest", rest);
      printf("exec %s\n", err(errno));
      return 1;
    } else if (!strcmp(op, "inherit")) {
      const char *v = getenv("LOCKTEST_FD");
      fd = v ? atoi(v) : -1;
    } else {
      printf("unknown %s\n", op);
      return 2;
    }
    fflush(stdout);
  }
  return 0;
}
