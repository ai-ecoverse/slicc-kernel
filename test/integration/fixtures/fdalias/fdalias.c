#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static const char *kind(mode_t m) {
  if (S_ISFIFO(m)) return "fifo";
  if (S_ISCHR(m)) return "chr";
  if (S_ISREG(m)) return "reg";
  if (S_ISLNK(m)) return "lnk";
  if (S_ISDIR(m)) return "dir";
  if (S_ISSOCK(m)) return "sock";
  return "other";
}

static void describe(const char *path) {
  struct stat st;
  printf("%s: stat ", path);
  if (stat(path, &st) == 0) printf("%s", kind(st.st_mode)); else printf("%s", strerror(errno));
  printf(", lstat ");
  if (lstat(path, &st) == 0) printf("%s", kind(st.st_mode)); else printf("%s", strerror(errno));
  char buf[256];
  ssize_t n = readlink(path, buf, sizeof buf - 1);
  if (n >= 0) {
    buf[n] = 0;
    char *bracket = strchr(buf, '[');
    if (bracket) bracket[1] = 0;
    printf(", link %s\n", buf);
  } else {
    printf(", link %s\n", strerror(errno));
  }
}

static int cat(const char *path) {
  int fd = open(path, O_RDONLY);
  if (fd < 0) return printf("open %s: %s\n", path, strerror(errno)), 1;
  char buf[256];
  ssize_t n = read(fd, buf, sizeof buf);
  printf("read %s: %.*s", path, (int)(n > 0 ? n : 0), buf);
  return 0;
}

int main(int argc, char **argv) {
  if (argc > 2 && !strcmp(argv[1], "cat")) return cat(argv[2]);
  for (int i = 1; i < argc; i++) describe(argv[i]);
  return 0;
}
