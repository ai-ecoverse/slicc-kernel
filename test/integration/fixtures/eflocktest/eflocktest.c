#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/file.h>
#include <unistd.h>

int main(int argc, char **argv) {
  if (argc < 3) return fprintf(stderr, "usage: eflocktest hold|try|shared PATH\n"), 2;
  setvbuf(stdout, NULL, _IONBF, 0);
  int fd = open(argv[2], O_RDWR | O_CREAT, 0644);
  if (fd < 0) return printf("open: %s\n", strerror(errno)), 1;
  if (!strcmp(argv[1], "hold")) {
    if (flock(fd, LOCK_EX) != 0) return printf("LOCK_EX: %s\n", strerror(errno)), 1;
    printf("held\n");
    char c;
    while (read(0, &c, 1) > 0) {
    }
    printf("LOCK_UN: %s\n", flock(fd, LOCK_UN) == 0 ? "ok" : strerror(errno));
    return 0;
  }
  int op = !strcmp(argv[1], "shared") ? LOCK_SH : LOCK_EX;
  printf("%s|LOCK_NB: %s\n", op == LOCK_SH ? "LOCK_SH" : "LOCK_EX", flock(fd, op | LOCK_NB) == 0 ? "ok" : strerror(errno));
  return 0;
}
