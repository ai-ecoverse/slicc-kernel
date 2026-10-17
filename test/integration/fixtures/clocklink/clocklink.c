#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

static void look(const char *name, char *out, size_t size) {
  char target[256];
  ssize_t n = readlink(name, target, sizeof target - 1);
  if (n < 0) {
    snprintf(out, size, "%s", errno == EINVAL ? "EINVAL" : strerror(errno));
    return;
  }
  target[n] = 0;
  snprintf(out, size, "%s", target);
}

static long long now_ms(void) {
  struct timespec ts;
  clock_gettime(CLOCK_REALTIME, &ts);
  return (long long)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

int main(int argc, char **argv) {
  if (argc != 4) {
    fprintf(stderr, "usage: clocklink NAME READY DEADLINE_MS\n");
    return 2;
  }
  int fd = open(argv[2], O_CREAT | O_WRONLY, 0644);
  if (fd < 0) return 1;
  close(fd);
  char first[300];
  char second[300];
  look(argv[1], first, sizeof first);
  long long end = atoll(argv[3]);
  while (now_ms() < end) {
  }
  look(argv[1], second, sizeof second);
  printf("first=%s second=%s\n", first, second);
  return 0;
}
