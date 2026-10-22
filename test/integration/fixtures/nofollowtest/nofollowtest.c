#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
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

static int swap(int over) {
  for (int i = 0; access("racy.stop", F_OK) != 0; i++) {
    unlink("racy.l");
    symlink("secret", "racy.l");
    if (over || i % 2) rename("racy.l", "racy");
    else {
      rename("racy", "racy.gone");
      symlink("secret", "racy");
    }
    int fd = open("racy.f", O_WRONLY | O_CREAT | O_TRUNC, 0644);
    write(fd, "plain", 5);
    close(fd);
    if (over || i % 2) rename("racy.f", "racy");
    else {
      rename("racy", "racy.gone");
      rename("racy.f", "racy");
    }
  }
  return 0;
}

/* race N: N no-follow opens of "racy"; prints whether some opened and some were
   refused, and how many read the symlink's target; then stops the swapper. */
static int race(int n) {
  int opened = 0, refused = 0, leaked = 0;
  for (int i = 0; i < n; i++) {
    int fd = open("racy", O_RDONLY | O_NOFOLLOW);
    if (fd < 0) {
      refused++;
      continue;
    }
    char buf[16] = {0};
    read(fd, buf, sizeof buf - 1);
    close(fd);
    if (strcmp(buf, "SECRET") == 0) leaked++;
    else opened++;
  }
  printf("opened %d refused %d leaked %d\n", opened > 0, refused > 0, leaked);
  close(open("racy.stop", O_WRONLY | O_CREAT, 0644));
  return 0;
}

static void *idle(void *arg) {
  return arg;
}

int main(int argc, char **argv) {
  if (argc > 1 && strcmp(argv[1], "threaded") == 0) {
    pthread_t t;
    pthread_create(&t, NULL, idle, NULL);
    pthread_join(t, NULL);
    argc--;
    argv++;
  }
  if (argc >= 2 && strcmp(argv[1], "swap") == 0) return swap(argc == 3 && strcmp(argv[2], "over") == 0);
  if (argc == 3 && strcmp(argv[1], "race") == 0) return race(atoi(argv[2]));
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
