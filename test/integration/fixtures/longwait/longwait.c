#define _GNU_SOURCE
#include <errno.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <sys/select.h>
#include <sys/time.h>
#include <time.h>
#include <unistd.h>

static volatile sig_atomic_t alarms;
static void on_alarm(int sig) {
  (void)sig;
  alarms++;
}

static long long now_ms(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (long long)ts.tv_sec * 1000LL + ts.tv_nsec / 1000000LL;
}

static int wait_long(const char *mode, int fd) {
  if (!strcmp(mode, "select")) {
    fd_set r;
    FD_ZERO(&r);
    FD_SET(fd, &r);
    struct timeval tv = {.tv_sec = 3000000};
    return select(fd + 1, &r, NULL, NULL, &tv);
  }
  if (!strcmp(mode, "ppoll")) {
    struct pollfd p = {.fd = fd, .events = POLLIN};
    struct timespec t = {.tv_sec = 3000000};
    return ppoll(&p, 1, &t, NULL);
  }
  struct timespec t = {.tv_sec = 3000000};
  return nanosleep(&t, NULL);
}

int main(int argc, char **argv) {
  setvbuf(stdout, NULL, _IONBF, 0);
  const char *mode = argc > 1 ? argv[1] : "alarm";
  struct sigaction sa = {0};
  sa.sa_handler = on_alarm;
  sigaction(SIGALRM, &sa, NULL);
  if (!strcmp(mode, "alarm")) {
    alarm(3000000);
    usleep(500000);
    printf("alarm(3000000): %d alarms after 0.5 s, %u s left\n", (int)alarms, alarm(0));
    return 0;
  }
  int fds[2];
  pipe(fds);
  struct itimerval it = {.it_value = {.tv_usec = 300000}};
  setitimer(ITIMER_REAL, &it, NULL);
  long long start = now_ms();
  errno = 0;
  int r = wait_long(mode, fds[0]);
  int e = errno;
  long long took = now_ms() - start;
  printf("%s: %d %s after the 300 ms alarm, %s\n", mode, r, r < 0 ? strerror(e) : "ok",
         took >= 300 && took < 2000 ? "on time" : "off");
  return 0;
}
