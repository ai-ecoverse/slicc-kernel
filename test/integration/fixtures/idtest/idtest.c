#include <fcntl.h>
#include <stdio.h>
#include <sys/stat.h>
#include <unistd.h>

int main(int argc, char **argv) {
  const char *p = argc > 1 ? argv[1] : "f";
  struct stat a, b, c, d;
  int fd = open(p, argc > 2 ? O_RDWR | O_CREAT : O_RDONLY, 0600);
  if (argc > 2) write(fd, "data\n", 5);
  if (fd < 0) return perror("open"), 1;
  stat(p, &a);
  lstat(p, &b);
  fstat(fd, &c);
  fstatat(AT_FDCWD, p, &d, 0);
  printf("stat %llu:%llu lstat %llu:%llu fstat %llu:%llu fstatat %llu:%llu\n", (unsigned long long)a.st_dev, (unsigned long long)a.st_ino, (unsigned long long)b.st_dev, (unsigned long long)b.st_ino, (unsigned long long)c.st_dev, (unsigned long long)c.st_ino, (unsigned long long)d.st_dev, (unsigned long long)d.st_ino);
  return 0;
}
