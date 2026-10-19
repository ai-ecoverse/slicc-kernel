#include <fcntl.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define THREADS 4
#define RECORDS 1000
#define LEN 16

static int fd;

static void *writer(void *arg) {
  int t = (int)(long)arg;
  char rec[LEN + 1];
  for (int i = 0; i < RECORDS; i++) {
    snprintf(rec, sizeof rec, "T%d:%012d\n", t, i);
    if (write(fd, rec, LEN) != LEN) {
      perror("write");
      exit(3);
    }
  }
  return NULL;
}

int main(int argc, char **argv) {
  if (argc != 3) return fprintf(stderr, "usage: fdrace FILE append|shared\n"), 2;
  int flags = O_WRONLY | O_CREAT | O_TRUNC | (strcmp(argv[2], "append") == 0 ? O_APPEND : 0);
  fd = open(argv[1], flags, 0644);
  if (fd < 0) return perror("open"), 1;
  pthread_t th[THREADS];
  for (long t = 0; t < THREADS; t++) pthread_create(&th[t], NULL, writer, (void *)t);
  for (int t = 0; t < THREADS; t++) pthread_join(th[t], NULL);
  close(fd);
  int in = open(argv[1], O_RDONLY);
  static int seen[THREADS][RECORDS];
  char rec[LEN];
  long count = 0, torn = 0, dup = 0;
  ssize_t n;
  while ((n = read(in, rec, LEN)) == LEN) {
    int t, i;
    if (rec[0] != 'T' || rec[2] != ':' || rec[LEN - 1] != '\n' || sscanf(rec, "T%d:%d", &t, &i) != 2 ||
        t < 0 || t >= THREADS || i < 0 || i >= RECORDS) {
      torn++;
      continue;
    }
    if (seen[t][i]++) dup++;
    count++;
  }
  if (n > 0) torn++;
  long missing = 0;
  for (int t = 0; t < THREADS; t++)
    for (int i = 0; i < RECORDS; i++)
      if (!seen[t][i]) missing++;
  off_t size = lseek(in, 0, SEEK_END);
  close(in);
  printf("records %ld torn %ld dup %ld missing %ld size %lld\n", count, torn, dup, missing, (long long)size);
  return 0;
}
