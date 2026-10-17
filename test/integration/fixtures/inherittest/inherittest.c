#include <signal.h>
#include <stdio.h>

static const char *disposition(int sig) {
  struct sigaction sa;
  if (sigaction(sig, NULL, &sa) != 0) return "error";
  return sa.sa_handler == SIG_IGN ? "ignored" : sa.sa_handler == SIG_DFL ? "default" : "caught";
}

int main(void) {
  printf("SIGPIPE %s, SIGHUP %s, SIGINT %s\n", disposition(SIGPIPE), disposition(SIGHUP), disposition(SIGINT));
  signal(SIGPIPE, SIG_DFL);
  printf("after SIG_DFL: SIGPIPE %s\n", disposition(SIGPIPE));
  return 0;
}
