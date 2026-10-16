#include <errno.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/epoll.h>
#include <sys/time.h>
#include <time.h>
#include <unistd.h>

__attribute__((import_module("slicc"), import_name("sigmask_poll")))
int32_t k_sigmask_poll(uint32_t lo, uint32_t hi, const void *in, void *out, uint32_t n, uint32_t *nevents);

__attribute__((import_module("slicc"), import_name("sigmask_epoll_wait")))
int32_t k_epoll_wait(uint32_t lo, uint32_t hi, int32_t epfd, void *events, int32_t max, int64_t timeout_ns,
                     uint32_t *nevents);

static volatile sig_atomic_t handled;
static void on_alarm(int sig) {
  (void)sig;
  handled++;
}

static long long now_ms(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (long long)ts.tv_sec * 1000LL + ts.tv_nsec / 1000000LL;
}

static void alarm_while_computing(void) {
  struct itimerval it = {.it_value = {.tv_usec = 50000}};
  setitimer(ITIMER_REAL, &it, NULL);
  long long until = now_ms() + 150;
  while (now_ms() < until) {
  }
}

static const char *took(long long ms) {
  if (ms < 200) return "before the timeout";
  return ms >= 200 && ms < 1000 ? "after the timeout" : "off";
}

static void poll_case(const char *label, uint32_t lo) {
  uint8_t sub[48] = {0};
  sub[8] = 0;
  *(uint32_t *)(sub + 16) = 1;
  *(uint64_t *)(sub + 24) = 200000000ULL;
  uint8_t ev[32];
  uint32_t n = 99;
  int before = handled;
  alarm_while_computing();
  long long start = now_ms();
  int e = k_sigmask_poll(lo, 0, sub, ev, 1, &n);
  printf("%s: %s, events %u, handled %d, %s\n", label, e ? strerror(e) : "ok", n, (int)handled - before,
         took(now_ms() - start));
}

static void epoll_case(const char *label, uint32_t lo, int ep) {
  uint8_t events[4 * 32];
  uint32_t n = 99;
  int before = handled;
  alarm_while_computing();
  long long start = now_ms();
  int e = k_epoll_wait(lo, 0, ep, events, 4, 200000000LL, &n);
  printf("%s: %s, events %u, handled %d, %s\n", label, e ? strerror(e) : "ok", n, (int)handled - before,
         took(now_ms() - start));
}

int main(void) {
  setvbuf(stdout, NULL, _IONBF, 0);
  struct sigaction sa = {0};
  sa.sa_handler = on_alarm;
  sigaction(SIGALRM, &sa, NULL);
  sigset_t none;
  sigemptyset(&none);
  sigprocmask(SIG_SETMASK, &none, NULL);
  const uint32_t alrm = 1u << (SIGALRM - 1);
  int fds[2];
  pipe(fds);
  int ep = epoll_create1(0);
  struct epoll_event ev = {.events = EPOLLIN, .data.fd = fds[0]};
  epoll_ctl(ep, EPOLL_CTL_ADD, fds[0], &ev);
  poll_case("sigmask_poll, the mask blocks SIGALRM", alrm);
  poll_case("sigmask_poll, the mask leaves SIGALRM", 0);
  epoll_case("sigmask_epoll_wait, the mask blocks SIGALRM", alrm, ep);
  epoll_case("sigmask_epoll_wait, the mask leaves SIGALRM", 0, ep);
  return 0;
}
