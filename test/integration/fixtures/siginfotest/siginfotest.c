#include <errno.h>
#include <pthread.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

struct slicc_siginfo {
  uint32_t size;
  int32_t signo;
  int32_t code;
  int32_t pid;
  uint32_t uid;
  int32_t status;
};

__attribute__((import_module("slicc"), import_name("sigwait_info")))
int32_t k_sigwait_info(uint32_t lo, uint32_t hi, int64_t timeout_ns, struct slicc_siginfo *info);

__attribute__((import_module("slicc"), import_name("siginfo_take")))
int32_t k_siginfo_take(int32_t sig, struct slicc_siginfo *info);

static uint32_t bit(int sig) { return 1u << (sig - 1); }

static void block(int sig) {
  sigset_t set;
  sigemptyset(&set);
  sigaddset(&set, sig);
  pthread_sigmask(SIG_BLOCK, &set, NULL);
}

static void unblock(int sig) {
  sigset_t set;
  sigemptyset(&set);
  sigaddset(&set, sig);
  pthread_sigmask(SIG_UNBLOCK, &set, NULL);
}

static struct slicc_siginfo wait_for(int sig) {
  struct slicc_siginfo info = {.size = sizeof info, .pid = -1};
  int e = k_sigwait_info(bit(sig), 0, -1, &info);
  if (e) printf("sigwait_info(%d): %s\n", sig, strerror(e));
  return info;
}

static void report_as(const char *what, struct slicc_siginfo info, pid_t pid, uid_t uid) {
  printf("%s: signo %d code %d pid %s uid %s status %d size %u\n", what, info.signo, info.code,
         info.pid == pid ? "matches" : "differs", info.uid == uid ? "matches" : "differs",
         info.status, info.size);
}

static struct slicc_siginfo from_thread;
static volatile int ready;
static void *thread_waits(void *arg) {
  (void)arg;
  ready = 1;
  from_thread = wait_for(SIGUSR2);
  return NULL;
}

static void report(const char *what, struct slicc_siginfo info, pid_t pid) {
  report_as(what, info, pid, getuid());
}

static volatile struct slicc_siginfo handled;
static void on_usr1(int sig) {
  struct slicc_siginfo info = {.size = sizeof info};
  k_siginfo_take(sig, &info);
  handled = info;
}

static int as_user(uid_t uid) {
  block(SIGCHLD);
  pid_t child = fork();
  if (child == 0) {
    if (setuid(uid) != 0) _exit(99);
    _exit(3);
  }
  report_as("a child that became a user exited", wait_for(SIGCHLD), child, uid);
  waitpid(child, NULL, 0);
  return 0;
}

int main(int argc, char **argv) {
  setvbuf(stdout, NULL, _IONBF, 0);
  if (argc > 2 && !strcmp(argv[1], "setuid")) return as_user((uid_t)atoi(argv[2]));
  signal(SIGUSR1, on_usr1);
  block(SIGUSR1);
  block(SIGUSR2);
  block(SIGCHLD);
  block(SIGALRM);

  pid_t child = fork();
  if (child == 0) {
    kill(getppid(), SIGUSR1);
    _exit(7);
  }
  report("kill from a child", wait_for(SIGUSR1), child);
  report("child exited", wait_for(SIGCHLD), child);
  waitpid(child, NULL, 0);

  pthread_t thread;
  pthread_create(&thread, NULL, thread_waits, NULL);
  while (!ready) usleep(1000);
  pthread_kill(thread, SIGUSR2);
  pthread_join(thread, NULL);
  report("pthread_kill to a thread", from_thread, getpid());

  kill(getpid(), SIGUSR2);
  report("kill of itself", wait_for(SIGUSR2), getpid());

  child = fork();
  if (child == 0) {
    for (;;) sleep(1);
    _exit(0);
  }
  kill(child, SIGTERM);
  report("child killed", wait_for(SIGCHLD), child);
  waitpid(child, NULL, 0);

  alarm(1);
  report_as("alarm", wait_for(SIGALRM), 0, 0);

  kill(getpid(), SIGUSR2);
  struct slicc_siginfo small = {.size = 12, .pid = -1};
  k_sigwait_info(bit(SIGUSR2), 0, -1, &small);
  printf("a 12-byte struct: size %u signo %d code %d pid left %d\n", small.size, small.signo, small.code, small.pid);

  child = fork();
  if (child == 0) {
    kill(getppid(), SIGUSR1);
    _exit(0);
  }
  waitpid(child, NULL, 0);
  unblock(SIGUSR1);
  report("siginfo_take in a handler", handled, child);
  struct slicc_siginfo none = {.size = sizeof none};
  int e = k_siginfo_take(SIGUSR2, &none);
  printf("siginfo_take with nothing recorded: %s, size %u\n", e ? strerror(e) : "ok", none.size);
  return 0;
}
