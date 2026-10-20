#include <pthread.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>

static volatile sig_atomic_t dh, maxd;
static char order[64];
static volatile sig_atomic_t at;

static void note(char c) {
  if (at < (int)sizeof order - 1) order[at++] = c;
}

static void hh(int s) {
  (void)s;
  dh++;
  if (dh > maxd) maxd = dh;
  note('<');
  if (dh == 1) {
    sigset_t u;
    sigemptyset(&u);
    sigaddset(&u, SIGUSR1);
    pthread_sigmask(SIG_UNBLOCK, &u, 0);
    raise(SIGUSR1);
  }
  note('>');
  dh--;
}

int main(void) {
  struct sigaction sa;
  memset(&sa, 0, sizeof sa);
  sa.sa_handler = hh;
  sigaction(SIGUSR1, &sa, NULL);
  raise(SIGUSR1);
  order[at] = 0;
  printf("order=%s maxdepth=%d\n", order, (int)maxd);
  return 0;
}
