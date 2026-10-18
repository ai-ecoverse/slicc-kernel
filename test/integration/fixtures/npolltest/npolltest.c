#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <unistd.h>
#include <wasi/api_wasi.h>

static void report(const char *what, int fd) {
  __wasi_subscription_t sub;
  memset(&sub, 0, sizeof sub);
  sub.userdata = 7;
  sub.u.tag = __WASI_EVENTTYPE_FD_READ;
  sub.u.u.fd_read.file_descriptor = fd;
  unsigned char ev[32];
  memset(ev, 0, sizeof ev);
  __wasi_size_t n = 0;
  __wasi_errno_t err = __wasi_poll_oneoff(&sub, (__wasi_event_t *)ev, 1, &n);
  uint64_t nbytes;
  uint16_t flags;
  memcpy(&nbytes, ev + 16, 8);
  memcpy(&flags, ev + 24, 2);
  printf("%s err=%d n=%u nbytes=%llu hangup=%d\n", what, err, n, (unsigned long long)nbytes,
         (flags & __WASI_EVENTRWFLAGS_FD_READWRITE_HANGUP) != 0);
}

static void pipes(void) {
  int p[2];
  pipe(p);
  close(p[1]);
  report("pipe-empty", p[0]);
  close(p[0]);
  pipe(p);
  write(p[1], "abc", 3);
  close(p[1]);
  report("pipe-3", p[0]);
  close(p[0]);
  pipe(p);
  write(p[1], "abcde", 5);
  report("pipe-open-5", p[0]);
  close(p[0]);
  close(p[1]);
}

static void fifo(void) {
  unlink("/tmp/npoll.fifo");
  if (mkfifo("/tmp/npoll.fifo", 0600) != 0) {
    printf("mkfifo errno=%d\n", errno);
    return;
  }
  int r = open("/tmp/npoll.fifo", O_RDONLY | O_NONBLOCK);
  int w = open("/tmp/npoll.fifo", O_WRONLY);
  close(w);
  report("fifo-empty", r);
  w = open("/tmp/npoll.fifo", O_WRONLY);
  write(w, "abc", 3);
  close(w);
  report("fifo-3", r);
  close(r);
  unlink("/tmp/npoll.fifo");
}

static void unixstream(void) {
  int s[2];
  if (socketpair(AF_UNIX, SOCK_STREAM, 0, s) != 0) {
    printf("socketpair errno=%d\n", errno);
    return;
  }
  close(s[1]);
  report("unix-empty", s[0]);
  close(s[0]);
  socketpair(AF_UNIX, SOCK_STREAM, 0, s);
  write(s[1], "abc", 3);
  close(s[1]);
  report("unix-3", s[0]);
  close(s[0]);
}

int main(void) {
  pipes();
  fifo();
  unixstream();
  return 0;
}
