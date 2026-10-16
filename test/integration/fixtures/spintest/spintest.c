#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#define MIB (1024 * 1024)

static unsigned char at(long i) { return (unsigned char)(i * 7 + 1); }

static int rounds(int n) {
  int p[2];
  if (pipe(p) != 0) return perror("pipe"), 1;
  for (int i = 0; i < n; i++) {
    unsigned char out = at(i), in = 0;
    if (write(p[1], &out, 1) != 1) return perror("write"), 1;
    if (read(p[0], &in, 1) != 1) return perror("read"), 1;
    if (in != out) return printf("round %d: got %u, sent %u\n", i, in, out), 1;
  }
  printf("%d rounds in order\n", n);
  return 0;
}

static int waiting(void) {
  printf("waiting\n");
  fflush(stdout);
  char c = 0;
  ssize_t r = read(0, &c, 1);
  printf("read %zd byte: %c\n", r, c);
  return r == 1 ? 0 : 1;
}

static int big(int mib) {
  static unsigned char buf[MIB];
  mkdir("/tmp", 0777);
  int fd = open("/tmp/spintest.big", O_CREAT | O_TRUNC | O_WRONLY, 0644);
  if (fd < 0) return perror("open"), 1;
  for (long i = 0; i < (long)mib * MIB; i += MIB) {
    for (long j = 0; j < MIB; j++) buf[j] = at(i + j);
    if (write(fd, buf, MIB) != MIB) return perror("write"), 1;
  }
  close(fd);
  fd = open("/tmp/spintest.big", O_RDONLY);
  long whole = 0;
  for (long i = 0; i < (long)mib * MIB; i += MIB) {
    memset(buf, 0, MIB);
    ssize_t r = read(fd, buf, MIB);
    if (r != MIB) return printf("read at %ld: %zd bytes\n", i, r), 1;
    for (long j = 0; j < MIB; j++)
      if (buf[j] != at(i + j)) return printf("byte %ld: got %u\n", i + j, buf[j]), 1;
    whole++;
  }
  close(fd);
  unlink("/tmp/spintest.big");
  printf("%ld reads of 1 MiB, each whole\n", whole);
  return 0;
}

int main(int argc, char **argv) {
  const char *mode = argc > 1 ? argv[1] : "";
  int n = argc > 2 ? atoi(argv[2]) : 0;
  if (!strcmp(mode, "rounds")) return rounds(n);
  if (!strcmp(mode, "wait")) return waiting();
  if (!strcmp(mode, "big")) return big(n);
  fprintf(stderr, "usage: spintest rounds N | wait | big MIB\n");
  return 2;
}
