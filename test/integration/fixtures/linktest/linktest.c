#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

int main(int argc, char **argv) {
  if (argc != 3) return 2;
  if (linkat(AT_FDCWD, argv[1], AT_FDCWD, argv[2], AT_SYMLINK_FOLLOW)) {
    printf("linkat: %s\n", strerror(errno));
    return 1;
  }
  struct stat from, to, link;
  if (stat(argv[1], &from) || lstat(argv[2], &link) || stat(argv[2], &to)) {
    printf("stat: %s\n", strerror(errno));
    return 1;
  }
  printf("%s same=%d nlink=%lu\n", S_ISREG(link.st_mode) ? "file" : "other", from.st_ino == to.st_ino,
         (unsigned long)to.st_nlink);
  return 0;
}
