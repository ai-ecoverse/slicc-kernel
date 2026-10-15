#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <poll.h>
#include <pthread.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/epoll.h>
#include <sys/eventfd.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <time.h>
#include <unistd.h>

#undef EPOLL_CTL_ADD
#undef EPOLL_CTL_MOD
#undef EPOLL_CTL_DEL
#define EPOLL_CTL_ADD 0
#define EPOLL_CTL_MOD 1
#define EPOLL_CTL_DEL 2

static int ctl(int ep, int op, int fd, struct epoll_event *ev) {
  int r = epoll_ctl(ep, op, fd, ev);
  if (r > 0) {
    errno = r;
    return -1;
  }
  return r;
}

static int add(int ep, int fd, uint32_t events, uint64_t tag) {
  struct epoll_event ev = {.events = events, .data.u64 = tag};
  return ctl(ep, EPOLL_CTL_ADD, fd, &ev);
}

static int mod(int ep, int fd, uint32_t events, uint64_t tag) {
  struct epoll_event ev = {.events = events, .data.u64 = tag};
  return ctl(ep, EPOLL_CTL_MOD, fd, &ev);
}

static const char *bits(uint32_t e) {
  static char buf[64];
  buf[0] = 0;
  if (e & EPOLLIN) strcat(buf, "IN|");
  if (e & EPOLLOUT) strcat(buf, "OUT|");
  if (e & EPOLLRDHUP) strcat(buf, "RDHUP|");
  if (e & EPOLLERR) strcat(buf, "ERR|");
  if (e & EPOLLHUP) strcat(buf, "HUP|");
  size_t n = strlen(buf);
  if (n) buf[n - 1] = 0;
  else strcpy(buf, "-");
  return buf;
}

static void wait_print(const char *label, int ep, int timeout) {
  struct epoll_event evs[8];
  int n = epoll_wait(ep, evs, 8, timeout);
  if (n < 0) {
    printf("%s: %s\n", label, strerror(errno));
    return;
  }
  printf("%s: %d", label, n);
  for (int i = 0; i < n; i++) printf(" %llu=%s", (unsigned long long)evs[i].data.u64, bits(evs[i].events));
  printf("\n");
}

static double now_ms(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return ts.tv_sec * 1e3 + ts.tv_nsec / 1e6;
}

static void tcp_pair(int *client, int *server) {
  int l = socket(AF_INET, SOCK_STREAM, 0);
  struct sockaddr_in a = {.sin_family = AF_INET, .sin_port = 0};
  a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  bind(l, (struct sockaddr *)&a, sizeof a);
  listen(l, 4);
  socklen_t len = sizeof a;
  getsockname(l, (struct sockaddr *)&a, &len);
  *client = socket(AF_INET, SOCK_STREAM, 0);
  connect(*client, (struct sockaddr *)&a, sizeof a);
  *server = accept(l, NULL, NULL);
  close(l);
}

static int level_edge(void) {
  int p[2];
  pipe(p);
  int lt = epoll_create1(0), et = epoll_create1(0);
  add(lt, p[0], EPOLLIN, 1);
  add(et, p[0], EPOLLIN | EPOLLET, 2);
  write(p[1], "a", 1);
  wait_print("lt first", lt, 0);
  wait_print("lt again", lt, 0);
  wait_print("et first", et, 0);
  wait_print("et again", et, 0);
  write(p[1], "b", 1);
  wait_print("et new data", et, 0);
  wait_print("et after", et, 0);
  return 0;
}

static int et_on_add(void) {
  int e = eventfd(1, EFD_NONBLOCK);
  int ep = epoll_create1(0);
  add(ep, e, EPOLLIN | EPOLLET, 7);
  wait_print("add ready", ep, 0);
  wait_print("add again", ep, 0);
  mod(ep, e, EPOLLIN | EPOLLET, 8);
  wait_print("mod ready", ep, 0);
  wait_print("mod again", ep, 0);
  return 0;
}

static int oneshot(void) {
  int p[2];
  pipe(p);
  int ep = epoll_create1(0);
  add(ep, p[0], EPOLLIN | EPOLLONESHOT, 3);
  write(p[1], "a", 1);
  wait_print("oneshot first", ep, 0);
  write(p[1], "b", 1);
  wait_print("oneshot disarmed", ep, 0);
  close(p[1]);
  wait_print("oneshot hangup disarmed", ep, 0);
  mod(ep, p[0], EPOLLIN | EPOLLONESHOT, 4);
  wait_print("oneshot rearmed", ep, 0);
  wait_print("oneshot after", ep, 0);
  return 0;
}

static int counter(void) {
  uint64_t v = 0;
  int e = eventfd(3, EFD_NONBLOCK);
  write(e, &(uint64_t){4}, 8);
  read(e, &v, 8);
  printf("counter read %llu\n", (unsigned long long)v);
  printf("counter empty %s\n", read(e, &v, 8) < 0 ? strerror(errno) : "read");
  int s = eventfd(2, EFD_NONBLOCK | EFD_SEMAPHORE);
  read(s, &v, 8);
  printf("semaphore %llu", (unsigned long long)v);
  read(s, &v, 8);
  printf(" %llu", (unsigned long long)v);
  printf(" %s\n", read(s, &v, 8) < 0 ? strerror(errno) : "read");
  uint32_t small = 0;
  printf("short read %s\n", read(e, &small, 4) < 0 ? strerror(errno) : "read");
  printf("max write %s\n", write(e, &(uint64_t){UINT64_MAX}, 8) < 0 ? strerror(errno) : "wrote");
  write(e, &(uint64_t){UINT64_MAX - 1}, 8);
  printf("full write %s\n", write(e, &(uint64_t){1}, 8) < 0 ? strerror(errno) : "wrote");
  read(e, &v, 8);
  int ep = epoll_create1(0);
  add(ep, s, EPOLLIN, 5);
  struct pollfd pf[3] = {{.fd = e, .events = POLLIN | POLLOUT}, {.fd = ep, .events = POLLIN}, {.fd = s, .events = POLLIN}};
  poll(pf, 3, 0);
  printf("poll eventfd %s, epoll %s\n", pf[0].revents & POLLIN ? "in" : pf[0].revents & POLLOUT ? "out" : "-",
         pf[1].revents & POLLIN ? "in" : "-");
  write(s, &(uint64_t){1}, 8);
  poll(pf, 3, 0);
  printf("poll epoll after write %s\n", pf[1].revents & POLLIN ? "in" : "-");
  return 0;
}

static volatile sig_atomic_t alarms;
static void on_alarm(int sig) {
  (void)sig;
  alarms++;
}

static int interrupted(void) {
  struct sigaction sa = {0};
  sa.sa_handler = on_alarm;
  sigaction(SIGALRM, &sa, NULL);
  struct itimerval it = {.it_value = {.tv_usec = 100000}};
  setitimer(ITIMER_REAL, &it, NULL);
  int ep = epoll_create1(0);
  struct epoll_event ev;
  int n = epoll_wait(ep, &ev, 1, -1);
  printf("wait %d %s alarms %d\n", n, n < 0 ? strerror(errno) : "-", (int)alarms);
  return 0;
}

static int timeouts(void) {
  int ep = epoll_create1(0);
  struct epoll_event ev;
  double t0 = now_ms();
  int n = epoll_wait(ep, &ev, 1, 0);
  double t1 = now_ms();
  int m = epoll_wait(ep, &ev, 1, 120);
  double t2 = now_ms();
  printf("zero %d %s, timed %d %s\n", n, t1 - t0 < 50 ? "prompt" : "slow", m, t2 - t1 >= 120 ? "not early" : "early");
  printf("maxevents %s\n", epoll_wait(ep, &ev, 0, 0) < 0 ? strerror(errno) : "accepted");
  return 0;
}

static int errors(void) {
  int ep = epoll_create1(0);
  int p[2];
  pipe(p);
  struct epoll_event ev = {.events = EPOLLIN};
#define TRY(label, call) printf("%s %s\n", label, (call) < 0 ? strerror(errno) : "ok")
  TRY("add", ctl(ep, EPOLL_CTL_ADD, p[0], &ev));
  TRY("add twice", ctl(ep, EPOLL_CTL_ADD, p[0], &ev));
  TRY("mod missing", ctl(ep, EPOLL_CTL_MOD, p[1], &ev));
  TRY("del missing", ctl(ep, EPOLL_CTL_DEL, p[1], &ev));
  TRY("del", ctl(ep, EPOLL_CTL_DEL, p[0], &ev));
  TRY("self", ctl(ep, EPOLL_CTL_ADD, ep, &ev));
  TRY("not epoll", ctl(p[0], EPOLL_CTL_ADD, p[1], &ev));
  TRY("bad fd", ctl(ep, EPOLL_CTL_ADD, 999, &ev));
  int f = open("/tmp/epolltest.file", O_CREAT | O_RDWR, 0644);
  TRY("file", ctl(ep, EPOLL_CTL_ADD, f, &ev));
  int d = open("/tmp", O_RDONLY | O_DIRECTORY);
  TRY("dir", ctl(ep, EPOLL_CTL_ADD, d, &ev));
  return 0;
}

static int closed(void) {
  int ep = epoll_create1(0);
  int p[2];
  pipe(p);
  write(p[1], "a", 1);
  add(ep, p[0], EPOLLIN, 9);
  int was = p[0];
  close(p[0]);
  close(p[1]);
  wait_print("closed", ep, 0);
  int q[2];
  pipe(q);
  write(q[1], "b", 1);
  printf("reused %s\n", q[0] == was ? "same fd" : "other fd");
  wait_print("reused not registered", ep, 0);
  printf("add reused %s\n", add(ep, q[0], EPOLLIN, 10) < 0 ? strerror(errno) : "ok");
  wait_print("reused registered", ep, 0);
  return 0;
}

struct drain {
  int fd;
  int delay_ms;
};

static void *drainer(void *arg) {
  struct drain *d = arg;
  usleep(d->delay_ms * 1000);
  char buf[4096];
  int flags = fcntl(d->fd, F_GETFL);
  fcntl(d->fd, F_SETFL, flags | O_NONBLOCK);
  while (read(d->fd, buf, sizeof buf) > 0) {
  }
  return NULL;
}

static void writable_edge(const char *label, int w, int r) {
  fcntl(w, F_SETFL, fcntl(w, F_GETFL) | O_NONBLOCK);
  int ep = epoll_create1(0);
  add(ep, w, EPOLLOUT | EPOLLET, 11);
  char l[64];
  snprintf(l, sizeof l, "%s ready", label);
  wait_print(l, ep, 0);
  static char chunk[4096];
  long total = 0;
  for (;;) {
    ssize_t n = write(w, chunk, sizeof chunk);
    if (n < 0) break;
    total += n;
  }
  printf("%s filled %s\n", label, errno == EAGAIN ? "EAGAIN" : strerror(errno));
  snprintf(l, sizeof l, "%s full", label);
  wait_print(l, ep, 0);
  struct drain d = {.fd = r, .delay_ms = 100};
  pthread_t t;
  pthread_create(&t, NULL, drainer, &d);
  snprintf(l, sizeof l, "%s drained", label);
  wait_print(l, ep, 5000);
  pthread_join(t, NULL);
  (void)total;
}

static int writable(void) {
  int p[2];
  pipe(p);
  writable_edge("pipe", p[1], p[0]);
  int c, s;
  tcp_pair(&c, &s);
  writable_edge("tcp", c, s);
  return 0;
}

struct adder {
  int ep;
  int fd;
};

static void *late_add(void *arg) {
  struct adder *a = arg;
  usleep(100000);
  add(a->ep, a->fd, EPOLLIN, 12);
  return NULL;
}

static int ctl_wakes(void) {
  int ep = epoll_create1(0);
  int e = eventfd(1, EFD_NONBLOCK);
  struct adder a = {.ep = ep, .fd = e};
  pthread_t t;
  pthread_create(&t, NULL, late_add, &a);
  wait_print("added while waiting", ep, 5000);
  pthread_join(t, NULL);
  return 0;
}

static void *late_write(void *arg) {
  usleep(100000);
  write(*(int *)arg, &(uint64_t){1}, 8);
  return NULL;
}

static int cross_thread(void) {
  int ep = epoll_create1(0);
  int e = eventfd(0, EFD_NONBLOCK);
  add(ep, e, EPOLLIN | EPOLLET, 13);
  pthread_t t;
  pthread_create(&t, NULL, late_write, &e);
  wait_print("woken by thread", ep, 5000);
  pthread_join(t, NULL);
  return 0;
}

static int rdhup(void) {
  int c, s;
  tcp_pair(&c, &s);
  int ep = epoll_create1(0);
  add(ep, s, EPOLLIN | EPOLLRDHUP, 14);
  wait_print("open", ep, 0);
  write(c, "x", 1);
  shutdown(c, SHUT_WR);
  wait_print("peer shut", ep, 1000);
  return 0;
}

static int fairness(void) {
  int ep = epoll_create1(0);
  for (int i = 0; i < 4; i++) add(ep, eventfd(1, EFD_NONBLOCK), EPOLLIN, 20 + i);
  int seen = 0;
  for (int round = 0; round < 2; round++) {
    struct epoll_event evs[2];
    int n = epoll_wait(ep, evs, 2, 0);
    for (int i = 0; i < n; i++) seen |= 1 << (evs[i].data.u64 - 20);
  }
  printf("fair %s\n", seen == 0xf ? "all four in two waits" : "starved");
  return 0;
}

static int connecting(void) {
  int l = socket(AF_INET, SOCK_STREAM, 0);
  struct sockaddr_in a = {.sin_family = AF_INET};
  a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  bind(l, (struct sockaddr *)&a, sizeof a);
  listen(l, 4);
  socklen_t len = sizeof a;
  getsockname(l, (struct sockaddr *)&a, &len);
  int c = socket(AF_INET, SOCK_STREAM, 0);
  fcntl(c, F_SETFL, O_NONBLOCK);
  int ep = epoll_create1(0);
  add(ep, l, EPOLLIN | EPOLLET, 15);
  int r = connect(c, (struct sockaddr *)&a, sizeof a);
  printf("connect %s\n", r < 0 ? strerror(errno) : "done");
  add(ep, c, EPOLLOUT | EPOLLET, 16);
  wait_print("connected", ep, 2000);
  wait_print("connected more", ep, 200);
  return 0;
}

static int from_stdin(void) {
  int ep = epoll_create1(0);
  add(ep, 0, EPOLLIN, 17);
  wait_print("stdin", ep, 5000);
  char buf[64] = {0};
  read(0, buf, sizeof buf - 1);
  printf("read %s", buf);
  return 0;
}

int main(int argc, char **argv) {
  setvbuf(stdout, NULL, _IONBF, 0);
  const char *mode = argc > 1 ? argv[1] : "";
  if (!strcmp(mode, "level-edge")) return level_edge();
  if (!strcmp(mode, "et-add")) return et_on_add();
  if (!strcmp(mode, "oneshot")) return oneshot();
  if (!strcmp(mode, "counter")) return counter();
  if (!strcmp(mode, "eintr")) return interrupted();
  if (!strcmp(mode, "timeout")) return timeouts();
  if (!strcmp(mode, "errors")) return errors();
  if (!strcmp(mode, "closed")) return closed();
  if (!strcmp(mode, "writable")) return writable();
  if (!strcmp(mode, "ctl-wake")) return ctl_wakes();
  if (!strcmp(mode, "cross-thread")) return cross_thread();
  if (!strcmp(mode, "rdhup")) return rdhup();
  if (!strcmp(mode, "fairness")) return fairness();
  if (!strcmp(mode, "connect")) return connecting();
  if (!strcmp(mode, "stdin")) return from_stdin();
  fprintf(stderr, "usage: epolltest MODE\n");
  return 2;
}
