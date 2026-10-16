#include <errno.h>
#include <pthread.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/time.h>
#include <time.h>
#include <unistd.h>

__attribute__((import_module("slicc"), import_name("sigwait")))
int32_t k_sigwait(uint32_t lo, uint32_t hi, int64_t timeout_ns, uint32_t *sig);

static volatile sig_atomic_t handled;
static void on_signal(int sig) {
  (void)sig;
  handled++;
}

static uint32_t bit(int sig) { return 1u << (sig - 1); }

static long long now_ms(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (long long)ts.tv_sec * 1000LL + ts.tv_nsec / 1000000LL;
}

static void block(int sig) {
  sigset_t set;
  sigemptyset(&set);
  sigaddset(&set, sig);
  pthread_sigmask(SIG_BLOCK, &set, NULL);
}

static uint32_t thread_got;
static int thread_err;
static volatile int waiting;

static void *waiter(void *arg) {
  (void)arg;
  waiting = 1;
  thread_err = k_sigwait(bit(SIGTERM), 0, -1, &thread_got);
  return NULL;
}

int main(void) {
  setvbuf(stdout, NULL, _IONBF, 0);
  struct sigaction sa = {0};
  sa.sa_handler = on_signal;
  sigaction(SIGUSR1, &sa, NULL);
  sigaction(SIGALRM, &sa, NULL);
  block(SIGUSR1);
  block(SIGUSR2);
  block(SIGTERM);

  uint32_t got = 0;
  kill(getpid(), SIGUSR1);
  int e = k_sigwait(bit(SIGUSR1) | bit(SIGUSR2), 0, -1, &got);
  printf("pending SIGUSR1: %s, took %u, handler ran %d times\n", e ? strerror(e) : "ok", got, (int)handled);

  long long start = now_ms();
  got = 99;
  e = k_sigwait(bit(SIGUSR2), 0, 200000000LL, &got);
  long long took = now_ms() - start;
  printf("nothing pending, 200 ms: %s, took %u, %s\n", e ? strerror(e) : "ok", got,
         took >= 200 && took < 1000 ? "on time" : "off");

  struct itimerval it = {.it_value = {.tv_usec = 100000}};
  setitimer(ITIMER_REAL, &it, NULL);
  got = 99;
  e = k_sigwait(bit(SIGUSR2), 0, -1, &got);
  printf("SIGALRM with a handler during the wait: %s, took %u, alarm handled %d\n", e ? strerror(e) : "ok", got,
         (int)handled);

  pthread_t t;
  pthread_create(&t, NULL, waiter, NULL);
  while (!waiting) usleep(1000);
  usleep(50000);
  kill(getpid(), SIGTERM);
  pthread_join(t, NULL);
  printf("SIGTERM blocked everywhere, sigwaited by a thread: %s, took %u, the process runs on\n",
         thread_err ? strerror(thread_err) : "ok", thread_got);
  return 0;
}
