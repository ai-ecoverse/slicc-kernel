#define _GNU_SOURCE
#include <errno.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <sys/epoll.h>
#include <sys/select.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

static long long now_ms(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (long long)ts.tv_sec * 1000LL + ts.tv_nsec / 1000000LL;
}

static int wait_in(const char *mode, int fd) {
  struct timespec t300 = {.tv_sec = 0, .tv_nsec = 300000000L};
  if (!strcmp(mode, "epoll")) {
    int ep = epoll_create1(0);
    struct epoll_event ev = {.events = EPOLLIN, .data.fd = fd};
    epoll_ctl(ep, EPOLL_CTL_ADD, fd, &ev);
    return epoll_wait(ep, &ev, 1, 300);
  }
  if (!strcmp(mode, "poll")) {
    struct pollfd p = {.fd = fd, .events = POLLIN};
    return poll(&p, 1, 300);
  }
  if (!strcmp(mode, "ppoll")) {
    struct pollfd p = {.fd = fd, .events = POLLIN};
    return ppoll(&p, 1, &t300, NULL);
  }
  if (!strcmp(mode, "select") || !strcmp(mode, "pselect")) {
    fd_set r;
    FD_ZERO(&r);
    FD_SET(fd, &r);
    if (mode[0] == 'p') return pselect(fd + 1, &r, NULL, NULL, &t300, NULL);
    struct timeval tv = {.tv_sec = 0, .tv_usec = 300000};
    return select(fd + 1, &r, NULL, NULL, &tv);
  }
  if (!strcmp(mode, "nanosleep")) return nanosleep(&t300, NULL);
  if (!strcmp(mode, "clock_nanosleep")) {
    int e = clock_nanosleep(CLOCK_MONOTONIC, 0, &t300, NULL);
    if (e) errno = e;
    return e ? -1 : 0;
  }
  errno = EINVAL;
  return -2;
}

int main(int argc, char **argv) {
  setvbuf(stdout, NULL, _IONBF, 0);
  const char *mode = argc > 1 ? argv[1] : "";
  int fds[2], ready[2];
  pipe(fds);
  pipe(ready);
  pid_t p = fork();
  if (p == 0) {
    write(ready[1], "", 1);
    long long start = now_ms();
    errno = 0;
    int r = wait_in(mode, fds[0]);
    int e = errno;
    long long took = now_ms() - start;
    const char *when = took < 290 ? "before the deadline" : took < 450 ? "at the deadline" : "late";
    printf("%s %d %s, %s\n", mode, r, r < 0 ? strerror(e) : "ok", when);
    _exit(0);
  }
  char c, pid[16], path[64], buf[256];
  read(ready[0], &c, 1);
  snprintf(pid, sizeof pid, "%d", (int)p);
  snprintf(path, sizeof path, "/proc/%s/task/1/stat", pid);
  char state = '?';
  long long until = now_ms() + 100;
  while (state != 'S' && now_ms() < until) {
    FILE *f = fopen(path, "r");
    size_t n = f ? fread(buf, 1, sizeof buf - 1, f) : 0;
    if (f) fclose(f);
    buf[n] = 0;
    char *close = strrchr(buf, ')');
    state = close && close[1] == ' ' ? close[2] : '?';
  }
  kill(p, SIGSTOP);
  usleep(200000);
  kill(p, SIGCONT);
  int st;
  waitpid(p, &st, 0);
  printf("stopped while blocked: %s\n", state == 'S' ? "yes" : "no");
  return 0;
}
