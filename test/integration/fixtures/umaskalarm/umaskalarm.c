#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <unistd.h>

static volatile sig_atomic_t hits;
static volatile sig_atomic_t bad;
static const char *dir;

static void on_alarm(int sig) {
  (void)sig;
  mode_t was = umask(077);
  if (was != 022) bad = 1;
  char path[256];
  snprintf(path, sizeof path, "%s/h%d", dir, (int)hits);
  int fd = open(path, O_WRONLY | O_CREAT | O_EXCL, 0666);
  if (fd < 0) bad = 2;
  else close(fd);
  umask(was);
  hits++;
  struct itimerval again = {{0, 0}, {0, 2000}};
  if (hits < 20) setitimer(ITIMER_REAL, &again, NULL);
}

static void *idle(void *arg) { return arg; }

int main(int argc, char **argv) {
  if (argc < 2) return 2;
  dir = argv[1];
  pthread_t t;
  if (pthread_create(&t, NULL, idle, NULL) != 0 || pthread_join(t, NULL) != 0) return 3;
  umask(022);
  struct sigaction sa;
  memset(&sa, 0, sizeof sa);
  sa.sa_handler = on_alarm;
  sigaction(SIGALRM, &sa, NULL);
  struct itimerval it = {{0, 0}, {0, 2000}};
  setitimer(ITIMER_REAL, &it, NULL);
  long calls = 0;
  while (hits < 20 && calls < 5000000) {
    umask(022);
    calls++;
  }
  struct itimerval off = {{0, 0}, {0, 0}};
  setitimer(ITIMER_REAL, &off, NULL);
  int wrong = 0;
  for (int i = 0; i < hits; i++) {
    char path[256];
    struct stat st;
    snprintf(path, sizeof path, "%s/h%d", dir, i);
    if (stat(path, &st) != 0 || (st.st_mode & 0777) != 0600) wrong++;
  }
  printf("hits %s bad %d wrong %d umask %03o\n", hits >= 20 ? "enough" : "few", (int)bad, wrong,
         (unsigned)umask(0));
  return 0;
}
