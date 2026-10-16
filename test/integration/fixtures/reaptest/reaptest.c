#include <errno.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

__attribute__((import_module("slicc"), import_name("sigaction_inherited")))
int32_t k_sigaction_inherited(uint64_t *out);

static long long now_ms(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (long long)ts.tv_sec * 1000LL + ts.tv_nsec / 1000000LL;
}

static void nap(long ms) {
  struct timespec ts = {ms / 1000, (ms % 1000) * 1000000L};
  nanosleep(&ts, NULL);
}

static pid_t child(long ms, int code) {
  pid_t pid = fork();
  if (pid == 0) {
    if (ms) nap(ms);
    _exit(code);
  }
  return pid;
}

static void reaping(const char *mode) {
  pid_t pid = child(0, 3);
  nap(300);
  int st = 0;
  pid_t got = waitpid(pid, &st, WNOHANG);
  if (got == pid)
    printf("%s: exited child waitable, status %d\n", mode, WEXITSTATUS(st));
  else
    printf("%s: exited child %s\n", mode, got < 0 && errno == ECHILD ? "already reaped (ECHILD)" : "still running");
  child(100, 0);
  child(250, 0);
  long long start = now_ms();
  got = wait(&st);
  long long took = now_ms() - start;
  if (got > 0)
    printf("%s: wait returned a child\n", mode);
  else
    printf("%s: wait %s after all children, %s\n", mode, errno == ECHILD ? "ECHILD" : strerror(errno),
           took >= 200 ? "once both had exited" : "too early");
  while (wait(NULL) > 0) {
  }
}

int main(int argc, char **argv) {
  setvbuf(stdout, NULL, _IONBF, 0);
  const char *mode = argc > 1 ? argv[1] : "dfl";
  if (!strcmp(mode, "inherited")) {
    uint64_t mask = 0;
    int e = k_sigaction_inherited(&mask);
    printf("inherited: %s, SIGPIPE %s, SIGCHLD %s, SIGTERM %s\n", e ? strerror(e) : "ok",
           mask & (1ULL << (SIGPIPE - 1)) ? "ignored" : "default", mask & (1ULL << (SIGCHLD - 1)) ? "ignored" : "default",
           mask & (1ULL << (SIGTERM - 1)) ? "ignored" : "default");
    reaping(mode);
    return 0;
  }
  if (!strcmp(mode, "ign")) signal(SIGCHLD, SIG_IGN);
  if (!strcmp(mode, "nocldwait")) {
    struct sigaction sa = {0};
    sa.sa_handler = SIG_DFL;
    sa.sa_flags = SA_NOCLDWAIT;
    sigaction(SIGCHLD, &sa, NULL);
  }
  if (!strcmp(mode, "reset")) {
    signal(SIGCHLD, SIG_IGN);
    signal(SIGCHLD, SIG_DFL);
  }
  reaping(mode);
  return 0;
}
