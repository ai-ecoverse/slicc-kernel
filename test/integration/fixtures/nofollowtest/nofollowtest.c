#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static void try_open(const char *label, const char *path, int flags) {
  int fd = open(path, flags, 0644);
  if (fd >= 0) {
    printf("%s ok\n", label);
    close(fd);
  } else {
    int e = errno;
    printf("%s %s (fd %d errno %d)\n", label, e == ELOOP ? "ELOOP" : e == EEXIST ? "EEXIST" : strerror(e), fd, e);
  }
}

int main(void) {
  int fd = open("file", O_WRONLY | O_CREAT | O_TRUNC, 0644);
  write(fd, "x", 1);
  close(fd);
  mkdir("d", 0755);
  fd = open("d/file", O_WRONLY | O_CREAT | O_TRUNC, 0644);
  close(fd);
  unlink("link");
  unlink("dirlink");
  unlink("dangling");
  if (symlink("file", "link") || symlink("d", "dirlink") || symlink("nowhere", "dangling")) {
    printf("setup failed %s\n", strerror(errno));
    return 2;
  }
  try_open("link nofollow", "link", O_RDONLY | O_NOFOLLOW);
  try_open("link follow", "link", O_RDONLY);
  try_open("file nofollow", "file", O_RDONLY | O_NOFOLLOW);
  try_open("dirlink/file nofollow", "dirlink/file", O_RDONLY | O_NOFOLLOW);
  try_open("link excl", "link", O_WRONLY | O_CREAT | O_EXCL);
  try_open("dangling excl", "dangling", O_WRONLY | O_CREAT | O_EXCL);
  try_open("dangling nofollow creat", "dangling", O_WRONLY | O_CREAT | O_NOFOLLOW);
  return 0;
}
