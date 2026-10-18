#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static int count;
static char **args;
static int status;

static const char *name(int e) {
  switch (e) {
    case EEXIST: return "EEXIST";
    case EROFS: return "EROFS";
    case ENOENT: return "ENOENT";
    case EACCES: return "EACCES";
    case EISDIR: return "EISDIR";
    case ENOTDIR: return "ENOTDIR";
    case ELOOP: return "ELOOP";
    default: return "EOTHER";
  }
}

static void create(const char *dir, int n, const char *how) {
  char path[512];
  int flags = O_CREAT | O_WRONLY | (!strcmp(how, "trunc") ? O_TRUNC : O_EXCL);
  for (int i = 0; i < n; i++) {
    snprintf(path, sizeof path, "%s/f%d", dir, i);
    int fd = open(path, flags, 0644);
    if (fd < 0) {
      printf("%s %s\n", path, name(errno));
      status = 1;
      return;
    }
    if (write(fd, "x", 1) != 1) status = 1;
    close(fd);
  }
  printf("created %d\n", n);
}

static void exclusive(int from) {
  for (int i = from; i < count; i++) {
    int fd = open(args[i], O_CREAT | O_EXCL | O_WRONLY, 0644);
    if (fd >= 0) {
      printf("%s ok\n", args[i]);
      close(fd);
    } else {
      printf("%s %s\n", args[i], name(errno));
    }
  }
}

static void watch(const char *file, const char *ready, const char *done) {
  struct stat st;
  if (stat(file, &st) != 0) {
    printf("stat %s\n", name(errno));
    status = 1;
    return;
  }
  off_t was = st.st_size;
  int fd = open(ready, O_CREAT | O_WRONLY, 0644);
  if (fd >= 0) close(fd);
  while (stat(done, &st) != 0) {
  }
  if (stat(file, &st) != 0) {
    printf("stat %s\n", name(errno));
    status = 1;
    return;
  }
  printf(st.st_size != was ? "fresh\n" : "stale\n");
}

static void *work(void *unused) {
  (void)unused;
  const char *cmd = args[1];
  if (!strcmp(cmd, "create") && count == 5) create(args[2], atoi(args[3]), args[4]);
  else if (!strcmp(cmd, "excl") && count >= 3) exclusive(2);
  else if (!strcmp(cmd, "watch") && count == 5) watch(args[2], args[3], args[4]);
  else {
    printf("usage: excltest create DIR N excl|trunc | excl PATH... | watch FILE READY DONE\n");
    status = 2;
  }
  return NULL;
}

int main(int argc, char **argv) {
  count = argc;
  args = argv;
  if (argc < 2) {
    printf("usage: excltest create DIR N excl|trunc | excl PATH... | watch FILE READY DONE\n");
    return 2;
  }
  pthread_t thread;
  if (pthread_create(&thread, NULL, work, NULL) != 0) {
    printf("pthread_create failed\n");
    return 1;
  }
  pthread_join(thread, NULL);
  fflush(stdout);
  return status;
}
