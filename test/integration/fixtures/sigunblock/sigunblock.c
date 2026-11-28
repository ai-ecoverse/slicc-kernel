#include <errno.h>
#include <pthread.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <sys/select.h>
#include <unistd.h>

static pthread_t workers[2];
static volatile int ran[3];
static volatile int go[2];
static int waits[2];
static int suspends;
static volatile int interrupted;

static void on_usr1(int sig) {
  (void)sig;
  int at = 0;
  for (int i = 0; i < 2; i++) {
    if (pthread_equal(pthread_self(), workers[i])) at = i + 1;
  }
  ran[at]++;
}

static void usr1(sigset_t *set) {
  sigemptyset(set);
  sigaddset(set, SIGUSR1);
}

static void *worker(void *arg) {
  int i = (int)(long)arg;
  sigset_t set;
  usr1(&set);
  while (!go[i]) usleep(1000);
  if (suspends) {
    sigset_t none;
    sigemptyset(&none);
    struct timespec limit = {1, 0};
    int r = pselect(0, NULL, NULL, NULL, &limit, &none);
    interrupted = r == -1 && errno == EINTR;
    return NULL;
  }
  pthread_sigmask(SIG_UNBLOCK, &set, NULL);
  for (int n = 0; n < waits[i] && ran[1] + ran[2] == 0; n++) usleep(10000);
  return NULL;
}

static void start(int i, int patience) {
  waits[i] = patience;
  pthread_create(&workers[i], NULL, worker, (void *)(long)i);
}

int main(int argc, char **argv) {
  setvbuf(stdout, NULL, _IONBF, 0);
  const char *mode = argc > 1 ? argv[1] : "late";
  struct sigaction sa = {0};
  sa.sa_handler = on_usr1;
  sigaction(SIGUSR1, &sa, NULL);
  sigset_t set;
  usr1(&set);
  pthread_sigmask(SIG_BLOCK, &set, NULL);
  int directed = !strcmp(mode, "directed");
  int two = directed || !strcmp(mode, "race");
  suspends = !strcmp(mode, "pselect");
  start(0, 200);
  if (two) start(1, directed ? 20 : 200);
  if (directed) pthread_kill(workers[0], SIGUSR1);
  else kill(getpid(), SIGUSR1);
  sigset_t pending;
  sigpending(&pending);
  int held = sigismember(&pending, SIGUSR1);
  if (directed) {
    go[1] = 1;
    pthread_join(workers[1], NULL);
    go[0] = 1;
  } else {
    go[0] = go[1] = 1;
    if (two) pthread_join(workers[1], NULL);
  }
  pthread_join(workers[0], NULL);
  pthread_sigmask(SIG_UNBLOCK, &set, NULL);
  if (directed) {
    printf("directed: pending %d, signalled worker %d, other worker %d", held, ran[1], ran[2]);
  } else {
    printf("%s: pending %d, workers %d", mode, held, ran[1] + ran[2]);
  }
  if (suspends) printf(", interrupted %d", interrupted);
  printf(", main %d\n", ran[0]);
  return 0;
}
