#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <termios.h>
#include <unistd.h>

__attribute__((import_module("slicc_tty"), import_name("ioctl"))) int32_t
slicc_ioctl(int32_t fd, int32_t request, int32_t arg);

struct termios2 {
  uint32_t c_iflag, c_oflag, c_cflag, c_lflag;
  uint8_t c_line;
  uint8_t c_cc[19];
  uint32_t c_ispeed, c_ospeed;
};

#define TCGETS2 0x802c542a
#define TCSETS2 0x402c542b
#define TIOCMGET 0x5415
#define TIOCMBIS 0x5416
#define TIOCMBIC 0x5417
#define TCSBRK 0x5409
#define TCFLSH 0x540b
#define FIONREAD 0x541b
#define TIOCSCTTY 0x540e
#define TIOCGSERIAL 0x541e
#define CBAUD 0010017
#define BOTHER 0010000

static int call(int fd, uint32_t request, int32_t arg, const char *what) {
  int32_t e = slicc_ioctl(fd, (int32_t)request, arg);
  if (e != 0) printf("%s errno=%d\n", what, e);
  return e;
}

static int look(int argc, char **argv) {
  const char *op = argv[1];
  const char *path = argv[2];
  if (strcmp(op, "stat") == 0 || strcmp(op, "lstat") == 0) {
    struct stat st;
    int r = op[0] == 's' ? stat(path, &st) : lstat(path, &st);
    if (r != 0) printf("%s errno=%d\n", op, errno);
    else printf("%s mode=%o uid=%u gid=%u\n", op, (unsigned)st.st_mode, (unsigned)st.st_uid, (unsigned)st.st_gid);
  } else if (strcmp(op, "ls") == 0) {
    DIR *d = opendir(path);
    if (!d) {
      printf("ls errno=%d\n", errno);
      return 0;
    }
    struct dirent *e;
    while ((e = readdir(d)) != 0)
      if (e->d_name[0] != '.') printf("%s\n", e->d_name);
    closedir(d);
  } else if (strcmp(op, "link") == 0) {
    char buf[256];
    ssize_t n = readlink(path, buf, sizeof buf - 1);
    if (n < 0) printf("link errno=%d\n", errno);
    else {
      buf[n] = 0;
      printf("link %s\n", buf);
    }
  } else if (strcmp(op, "nofollow") == 0) {
    int fd = open(path, O_RDONLY | O_NOFOLLOW);
    printf("nofollow %s\n", fd < 0 ? strerror(errno) : "opened");
  } else if (strcmp(op, "access") == 0) {
    printf("access %d\n", access(path, F_OK));
  } else if (strcmp(op, "tcsetw") == 0) {
    int fd = open(path, O_RDWR | O_NOCTTY);
    struct termios t;
    if (fd < 0 || tcgetattr(fd, &t) != 0) {
      printf("tcsetw errno=%d\n", errno);
      return 0;
    }
    cfsetispeed(&t, B57600);
    cfsetospeed(&t, B57600);
    printf("tcsetw %d speed=%o\n", tcsetattr(fd, TCSADRAIN, &t), (unsigned)cfgetospeed(&t));
    close(fd);
  } else {
    return 2;
  }
  (void)argc;
  return 0;
}

int main(int argc, char **argv) {
  if (argc < 3) return 2;
  if (argv[1][0] != '/') return look(argc, argv);
  int fd = open(argv[1], O_RDWR | O_NOCTTY);
  if (fd < 0) {
    perror("open");
    return 1;
  }
  for (int i = 2; i < argc; i++) {
    const char *op = argv[i];
    if (strcmp(op, "get2") == 0) {
      struct termios2 t;
      memset(&t, 0, sizeof t);
      if (call(fd, TCGETS2, (int32_t)(intptr_t)&t, op) == 0)
        printf("ispeed=%u ospeed=%u cbaud=%o\n", t.c_ispeed, t.c_ospeed, t.c_cflag & CBAUD);
    } else if (strcmp(op, "baud") == 0 && i + 1 < argc) {
      struct termios2 t;
      memset(&t, 0, sizeof t);
      if (call(fd, TCGETS2, (int32_t)(intptr_t)&t, "get2") != 0) return 1;
      t.c_cflag = (t.c_cflag & ~CBAUD) | BOTHER;
      t.c_ispeed = t.c_ospeed = (uint32_t)strtoul(argv[++i], 0, 10);
      if (call(fd, TCSETS2, (int32_t)(intptr_t)&t, op) == 0) printf("baud set\n");
    } else if (strcmp(op, "mget") == 0) {
      int32_t bits = 0;
      if (call(fd, TIOCMGET, (int32_t)(intptr_t)&bits, op) == 0) printf("modem=0x%x\n", bits);
    } else if ((strcmp(op, "mbis") == 0 || strcmp(op, "mbic") == 0) && i + 1 < argc) {
      int32_t bits = (int32_t)strtol(argv[++i], 0, 0);
      uint32_t request = op[3] == 's' ? TIOCMBIS : TIOCMBIC;
      if (call(fd, request, (int32_t)(intptr_t)&bits, op) == 0) printf("%s done\n", op);
    } else if (strcmp(op, "drain") == 0) {
      if (call(fd, TCSBRK, 1, op) == 0) printf("drained\n");
    } else if (strcmp(op, "break") == 0) {
      if (call(fd, TCSBRK, 0, op) == 0) printf("break sent\n");
    } else if (strcmp(op, "flush") == 0 && i + 1 < argc) {
      if (call(fd, TCFLSH, (int32_t)strtol(argv[++i], 0, 0), op) == 0) printf("flushed\n");
    } else if (strcmp(op, "fionread") == 0) {
      int32_t n = -1;
      if (call(fd, FIONREAD, (int32_t)(intptr_t)&n, op) == 0) printf("fionread=%d\n", n);
    } else if (strcmp(op, "ctty") == 0) {
      call(fd, TIOCSCTTY, 0, op);
    } else if (strcmp(op, "serial") == 0) {
      int32_t buf[32];
      call(fd, TIOCGSERIAL, (int32_t)(intptr_t)buf, op);
    } else if (strcmp(op, "write") == 0 && i + 1 < argc) {
      const char *s = argv[++i];
      printf("wrote %d\n", (int)write(fd, s, strlen(s)));
    } else if (strcmp(op, "read") == 0 && i + 1 < argc) {
      char buf[256];
      int want = atoi(argv[++i]);
      int got = (int)read(fd, buf, want < 255 ? want : 255);
      if (got >= 0) buf[got] = 0;
      printf("read %d %s\n", got, got > 0 ? buf : "");
    } else {
      fprintf(stderr, "unknown op %s\n", op);
      return 2;
    }
    fflush(stdout);
  }
  close(fd);
  return 0;
}
