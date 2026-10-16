#include <pthread.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

static volatile int handled_on;
static pthread_t worker_thread;
static volatile int ready;

static void on_usr1(int sig) {
  (void)sig;
  handled_on = pthread_equal(pthread_self(), worker_thread) ? 2 : 1;
}

static void *worker(void *arg) {
  (void)arg;
  sigset_t set;
  sigemptyset(&set);
  sigaddset(&set, SIGUSR1);
  sigaddset(&set, SIGTERM);
  pthread_sigmask(SIG_UNBLOCK, &set, NULL);
  ready = 1;
  for (int i = 0; i < 200 && !handled_on; i++) usleep(10000);
  return NULL;
}

int main(int argc, char **argv) {
  setvbuf(stdout, NULL, _IONBF, 0);
  const char *mode = argc > 1 ? argv[1] : "handler";
  struct sigaction sa = {0};
  sa.sa_handler = on_usr1;
  sigaction(SIGUSR1, &sa, NULL);
  sigset_t set;
  sigemptyset(&set);
  sigaddset(&set, SIGUSR1);
  sigaddset(&set, SIGTERM);
  pthread_sigmask(SIG_BLOCK, &set, NULL);
  pthread_create(&worker_thread, NULL, worker, NULL);
  while (!ready) usleep(1000);
  if (!strcmp(mode, "default")) {
    kill(getpid(), SIGTERM);
    pthread_join(worker_thread, NULL);
    printf("still running after SIGTERM\n");
    return 0;
  }
  kill(getpid(), SIGUSR1);
  pthread_join(worker_thread, NULL);
  printf("SIGUSR1 %s\n", handled_on == 2 ? "handled on the thread that doesn't block it" : handled_on == 1 ? "handled on main" : "not delivered while main blocks it");
  return 0;
}
