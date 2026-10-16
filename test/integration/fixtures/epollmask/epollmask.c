#include <errno.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/epoll.h>
#include <sys/time.h>
#include <time.h>
#include <unistd.h>

__attribute__((import_module("slicc"), import_name("sigmask_epoll_wait")))
int32_t k_epoll_wait(uint32_t lo, uint32_t hi, int32_t epfd, void *events, int32_t max, int64_t timeout_ns, uint32_t *nevents);

static volatile sig_atomic_t handled;
static void on_usr1(int sig) {
  (void)sig;
  handled++;
}

static long long now_ms(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (long long)ts.tv_sec * 1000LL + ts.tv_nsec / 1000000LL;
}

int main(void) {
  setvbuf(stdout, NULL, _IONBF, 0);
  struct sigaction sa = {0};
  sa.sa_handler = on_usr1;
  sigaction(SIGUSR1, &sa, NULL);
  sigaction(SIGALRM, &sa, NULL);
  sigset_t usr1;
  sigemptyset(&usr1);
  sigaddset(&usr1, SIGUSR1);
  sigaddset(&usr1, SIGALRM);
  sigprocmask(SIG_BLOCK, &usr1, NULL);
  int fds[2];
  pipe(fds);
  int ep = epoll_create1(0);
  struct epoll_event ev = {.events = EPOLLIN, .data.fd = fds[0]};
  epoll_ctl(ep, EPOLL_CTL_ADD, fds[0], &ev);
  uint8_t events[4 * 32];
  uint32_t n = 99;
  const uint32_t usr1_lo = 1u << (SIGUSR1 - 1);

  kill(getpid(), SIGUSR1);
  long long start = now_ms();
  int e = k_epoll_wait(0, 0, ep, events, 4, -1, &n);
  printf("pending SIGUSR1, unblocked by the call: %s, handled %d, events %u, %s\n", e ? strerror(e) : "ok",
         (int)handled, n, now_ms() - start < 1000 ? "at once" : "late");

  start = now_ms();
  n = 99;
  e = k_epoll_wait(usr1_lo, 0, ep, events, 4, 200000000LL, &n);
  long long took = now_ms() - start;
  printf("nothing ready, 200 ms: %s, events %u, %s\n", e ? strerror(e) : "ok", n,
         took >= 200 && took < 1000 ? "on time" : "off");

  int before = handled;
  struct itimerval it = {.it_value = {.tv_usec = 100000}};
  setitimer(ITIMER_REAL, &it, NULL);
  start = now_ms();
  n = 99;
  e = k_epoll_wait(0, 0, ep, events, 4, -1, &n);
  took = now_ms() - start;
  printf("SIGALRM during the wait, unblocked by the call: %s, handled %d, events %u, %s\n", e ? strerror(e) : "ok",
         (int)handled - before, n, took >= 90 && took < 1000 ? "on time" : "off");

  write(fds[1], "x", 1);
  n = 0;
  e = k_epoll_wait(usr1_lo, 0, ep, events, 4, 0, &n);
  printf("one ready: %s, events %u\n", e ? strerror(e) : "ok", n);

  kill(getpid(), SIGUSR1);
  sigset_t pending;
  sigpending(&pending);
  printf("after the call SIGUSR1 is blocked again: %s, handled %d\n",
         sigismember(&pending, SIGUSR1) ? "pending" : "not pending", (int)handled);
  return 0;
}
