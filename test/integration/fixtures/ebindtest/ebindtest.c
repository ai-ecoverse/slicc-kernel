#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static int fail(const char *what) {
  perror(what);
  return 1;
}

int main(int argc, char **argv) {
  if (argc != 4) {
    fprintf(stderr, "usage: ebindtest <held> <other> <link>\n");
    return 2;
  }
  const char *held = argv[1], *other = argv[2], *link_name = argv[3];
  int fd = open(held, O_RDWR);
  if (fd < 0) return fail("open");
  struct stat before, after;
  if (fstat(fd, &before) != 0) return fail("fstat");
  if (link(held, link_name) != 0) {
    if (rename(other, held) != 0) return fail("rename");
  } else {
    if (rename(link_name, held) != 0) return fail("rename link");
    if (rename(other, held) != 0) return fail("rename");
  }
  char buf[64] = {0};
  ssize_t n = pread(fd, buf, sizeof buf - 1, 0);
  if (n < 0) return fail("pread");
  if (pwrite(fd, "+w", 2, n) != 2) return fail("pwrite");
  if (fsync(fd) != 0) return fail("fsync");
  if (fstat(fd, &after) != 0) return fail("fstat after");
  char again[64] = {0};
  if (pread(fd, again, sizeof again - 1, 0) < 0) return fail("pread again");
  printf("%s %s %s\n", buf, again, before.st_ino == after.st_ino ? "same" : "other");
  close(fd);
  return 0;
}
