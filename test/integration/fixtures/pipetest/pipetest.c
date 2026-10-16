#include <errno.h>
#include <pthread.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

static volatile sig_atomic_t handled;
static pthread_t handled_on;
static void on_pipe(int sig) {
  (void)sig;
  handled++;
  handled_on = pthread_self();
}

static void *writer(void *arg) {
  int w = *(int *)arg;
  ssize_t n = write(w, "x", 1);
  printf("thread: %zd %s, handled %d, %s\n", n, n < 0 ? strerror(errno) : "written", (int)handled,
         handled && pthread_equal(handled_on, pthread_self()) ? "on the writing thread" : "elsewhere");
  return NULL;
}

static int broken(void) {
  int p[2];
  if (pipe(p) != 0) return -1;
  close(p[0]);
  return p[1];
}

static void report(const char *mode, int w) {
  errno = 0;
  ssize_t n = write(w, "x", 1);
  int e = errno;
  sigset_t pending;
  sigpending(&pending);
  printf("%s: %zd %s, handled %d, %s\n", mode, n, n < 0 ? strerror(e) : "written", (int)handled,
         sigismember(&pending, SIGPIPE) ? "pending" : "not pending");
}

int main(int argc, char **argv) {
  setvbuf(stdout, NULL, _IONBF, 0);
  const char *mode = argc > 1 ? argv[1] : "default";
  int w = broken();
  if (!strcmp(mode, "thread")) {
    signal(SIGPIPE, on_pipe);
    pthread_t t;
    pthread_create(&t, NULL, writer, &w);
    pthread_join(t, NULL);
    return 0;
  }
  if (!strcmp(mode, "ignore")) {
    signal(SIGPIPE, SIG_IGN);
    struct sigaction sa;
    sigaction(SIGPIPE, NULL, &sa);
    printf("reads back %s\n", sa.sa_handler == SIG_IGN ? "SIG_IGN" : "something else");
  } else if (!strcmp(mode, "handler")) {
    signal(SIGPIPE, on_pipe);
  } else if (!strcmp(mode, "blocked")) {
    sigset_t set;
    sigemptyset(&set);
    sigaddset(&set, SIGPIPE);
    sigprocmask(SIG_BLOCK, &set, NULL);
  } else if (!strcmp(mode, "dfl")) {
    signal(SIGPIPE, SIG_DFL);
  }
  report(mode, w);
  if (!strcmp(mode, "blocked")) _exit(0);
  return 0;
}
