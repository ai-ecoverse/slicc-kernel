#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

static volatile sig_atomic_t depth, deepest, runs;

static void on_term(int sig) {
  depth++;
  runs++;
  if (depth > deepest) deepest = depth;
  if (runs == 1) {
    kill(getpid(), sig);
    static const char msg[] = "the handler wrote\n";
    write(2, msg, sizeof msg - 1);
  }
  depth--;
}

int main(int argc, char **argv) {
  struct sigaction sa;
  memset(&sa, 0, sizeof sa);
  sa.sa_handler = on_term;
  sa.sa_flags = argc > 1 && !strcmp(argv[1], "nodefer") ? SA_NODEFER : 0;
  sigaction(SIGTERM, &sa, NULL);
  kill(getpid(), SIGTERM);
  for (int i = 0; i < 20 && runs < 2; i++) {
    struct timespec ts = {0, 10000000};
    nanosleep(&ts, NULL);
  }
  printf("the handler ran %d times, at most %d deep\n", (int)runs, (int)deepest);
  return 0;
}
