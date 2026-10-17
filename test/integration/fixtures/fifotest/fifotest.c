#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

__attribute__((import_module("slicc_fs"), import_name("path_mkfifo")))
int32_t k_path_mkfifo(int32_t dirfd, const char *path, uint32_t len, uint32_t mode);

static int make(const char *path, const char *mode, const char *dir) {
  int dirfd = -2;
  if (dir && (dirfd = open(dir, O_RDONLY | O_DIRECTORY)) < 0) return printf("open %s: %s\n", dir, strerror(errno)), 1;
  int e = k_path_mkfifo(dirfd, path, strlen(path), (uint32_t)strtol(mode, NULL, 8));
  printf("mkfifo %s: %s\n", path, e ? strerror(e) : "ok");
  return 0;
}

static const char *mark;

static void on_alarm(int sig) {
  (void)sig;
  if (mark) close(open(mark, O_CREAT | O_WRONLY, 0644));
}

static int flags_of(const char *how) {
  int flags = !strncmp(how, "rw", 2) ? O_RDWR : how[0] == 'w' ? O_WRONLY : O_RDONLY;
  return strstr(how, "nb") ? flags | O_NONBLOCK : flags;
}

static void drain(int fd) {
  char buf[256];
  ssize_t n;
  while ((n = read(fd, buf, sizeof buf)) > 0) printf("read: %.*s", (int)n, buf);
  printf("read end: %zd %s\n", n, n < 0 ? strerror(errno) : "eof");
}

int main(int argc, char **argv) {
  if (argc < 3) return fprintf(stderr, "usage: fifotest stat|read|write|nbwrite|nbread|alarm|mkfifo PATH [restart|MODE [DIR]]\n"), 2;
  const char *mode = argv[1], *path = argv[2];
  if (!strcmp(mode, "mkfifo")) return make(path, argc > 3 ? argv[3] : "666", argc > 4 ? argv[4] : NULL);
  if (!strcmp(mode, "stat")) {
    struct stat st;
    if (stat(path, &st) != 0) return printf("stat: %s\n", strerror(errno)), 1;
    printf("%s\n", S_ISFIFO(st.st_mode) ? "fifo" : "not a fifo");
    return 0;
  }
  if (!strcmp(mode, "alarm")) {
    struct sigaction sa;
    memset(&sa, 0, sizeof sa);
    sa.sa_handler = on_alarm;
    sa.sa_flags = argc > 3 && !strcmp(argv[3], "restart") ? SA_RESTART : 0;
    mark = getenv("FIFOTEST_MARK");
    sigaction(SIGALRM, &sa, NULL);
    alarm(1);
    int fd = open(path, O_RDONLY);
    if (fd < 0) return printf("open: %s\n", strerror(errno)), 0;
    printf("opened\n");
    drain(fd);
    return 0;
  }
  int writing = !strcmp(mode, "write") || !strcmp(mode, "nbwrite");
  int fd = open(path, flags_of(writing ? (mode[0] == 'n' ? "wnb" : "w") : (mode[0] == 'n' ? "rnb" : "r")));
  if (fd < 0) return printf("open: %s\n", strerror(errno)), 0;
  if (writing) {
    const char *msg = argc > 3 ? argv[3] : "from wasix\n";
    ssize_t n = write(fd, msg, strlen(msg));
    if (n < 0) printf("write: %s\n", strerror(errno));
    else printf("wrote %zd\n", n);
    return 0;
  }
  drain(fd);
  return 0;
}
