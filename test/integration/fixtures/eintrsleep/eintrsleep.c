#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

static volatile sig_atomic_t hits;

static void on_usr1(int sig) {
  (void)sig;
  hits++;
}

int main(void) {
  struct sigaction sa;
  memset(&sa, 0, sizeof sa);
  sa.sa_handler = on_usr1;
  sigaction(SIGUSR1, &sa, NULL);
  FILE *f = fopen("/tmp/eintrsleep.ready", "w");
  fprintf(f, "%d", getpid());
  fclose(f);
  struct timespec ts = {5, 0}, left = {0, 0};
  int rc = nanosleep(&ts, &left);
  printf("nanosleep rc=%d %s hits=%d early=%d\n", rc, rc ? strerror(errno) : "-", (int)hits, left.tv_sec > 0);
  return 0;
}
