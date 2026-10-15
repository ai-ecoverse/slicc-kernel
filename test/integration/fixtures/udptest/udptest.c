#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>

static struct sockaddr_in at(const char *host, int port) {
  struct sockaddr_in a;
  memset(&a, 0, sizeof a);
  a.sin_family = AF_INET;
  a.sin_port = htons((unsigned short)port);
  inet_pton(AF_INET, host, &a.sin_addr);
  return a;
}

static const char *name(int err) {
  switch (err) {
    case 0: return "ok";
    case EMSGSIZE: return "EMSGSIZE";
    case EDESTADDRREQ: return "EDESTADDRREQ";
    case ECONNREFUSED: return "ECONNREFUSED";
    case ENETUNREACH: return "ENETUNREACH";
    case EAGAIN: return "EAGAIN";
    case EACCES: return "EACCES";
    case EOPNOTSUPP: return "EOPNOTSUPP";
    case EADDRINUSE: return "EADDRINUSE";
    case EADDRNOTAVAIL: return "EADDRNOTAVAIL";
    case EPROTONOSUPPORT: return "EPROTONOSUPPORT";
    default: return strerror(err);
  }
}

static void pause_ms(int ms) {
  struct timespec t = {ms / 1000, (ms % 1000) * 1000000L};
  nanosleep(&t, NULL);
}

static int dgram(void) {
  int s = socket(AF_INET, SOCK_DGRAM, 0);
  if (s < 0) {
    printf("socket %s\n", name(errno));
    exit(1);
  }
  return s;
}

static ssize_t wait_recv(int s, char *buf, size_t len, struct sockaddr_in *from, int tries) {
  fcntl(s, F_SETFL, fcntl(s, F_GETFL) | O_NONBLOCK);
  socklen_t fl = sizeof *from;
  for (int i = 0; i < tries; i++) {
    ssize_t n = recvfrom(s, buf, len, 0, (struct sockaddr *)from, &fl);
    if (n >= 0 || errno != EAGAIN) return n;
    pause_ms(20);
  }
  errno = EAGAIN;
  return -1;
}

static int serve(int port, int count) {
  int s = dgram();
  struct sockaddr_in me = at("127.0.0.1", port);
  if (bind(s, (struct sockaddr *)&me, sizeof me) < 0) {
    printf("bind %s\n", name(errno));
    return 1;
  }
  for (int i = 0; i < count; i++) {
    char buf[512];
    struct sockaddr_in from;
    socklen_t fl = sizeof from;
    ssize_t n = recvfrom(s, buf, sizeof buf, 0, (struct sockaddr *)&from, &fl);
    if (n < 0) {
      printf("recvfrom %s\n", name(errno));
      return 1;
    }
    for (ssize_t j = 0; j < n; j++) buf[j] = (char)(buf[j] >= 'a' && buf[j] <= 'z' ? buf[j] - 32 : buf[j]);
    sendto(s, buf, (size_t)n, 0, (struct sockaddr *)&from, fl);
  }
  printf("served %d\n", count);
  return 0;
}

static int client(const char *host, int port, const char *text) {
  int s = dgram();
  struct sockaddr_in to = at(host, port);
  char buf[512];
  struct sockaddr_in from;
  for (int i = 0; i < 50; i++) {
    if (sendto(s, text, strlen(text), 0, (struct sockaddr *)&to, sizeof to) < 0) {
      printf("sendto %s\n", name(errno));
      return 1;
    }
    ssize_t n = wait_recv(s, buf, sizeof buf - 1, &from, 10);
    if (n >= 0) {
      buf[n] = 0;
      char ip[INET_ADDRSTRLEN];
      inet_ntop(AF_INET, &from.sin_addr, ip, sizeof ip);
      printf("reply %s from %s:%d\n", buf, ip, ntohs(from.sin_port));
      return 0;
    }
    if (errno != EAGAIN) {
      printf("recvfrom %s\n", name(errno));
      return 1;
    }
  }
  printf("no reply\n");
  return 1;
}

static int datagrams(void) {
  int a = dgram();
  int b = dgram();
  struct sockaddr_in any = at("127.0.0.1", 0);
  bind(a, (struct sockaddr *)&any, sizeof any);
  struct sockaddr_in where;
  socklen_t wl = sizeof where;
  getsockname(a, (struct sockaddr *)&where, &wl);
  sendto(b, "0123456789", 10, 0, (struct sockaddr *)&where, wl);
  char buf[16];
  struct iovec iov = {buf, 4};
  struct msghdr msg;
  memset(&msg, 0, sizeof msg);
  msg.msg_iov = &iov;
  msg.msg_iovlen = 1;
  ssize_t n = recvmsg(a, &msg, 0);
  printf("trunc %zd %.4s\n", n, buf);
  sendto(b, "second", 6, 0, (struct sockaddr *)&where, wl);
  n = recv(a, buf, sizeof buf, MSG_PEEK);
  printf("peek %zd %.*s\n", n, (int)n, buf);
  n = recv(a, buf, sizeof buf, 0);
  printf("then %zd %.*s\n", n, (int)n, buf);
  fcntl(a, F_SETFL, fcntl(a, F_GETFL) | O_NONBLOCK);
  n = recv(a, buf, sizeof buf, 0);
  printf("empty %s\n", n < 0 ? name(errno) : "data");
  static char big[65508];
  printf("big %s\n", sendto(b, big, sizeof big, 0, (struct sockaddr *)&where, wl) < 0 ? name(errno) : "ok");
  printf("max %s\n", sendto(b, big, 65507, 0, (struct sockaddr *)&where, wl) < 0 ? name(errno) : "ok");
  int c = dgram();
  printf("nodest %s\n", send(c, "x", 1, 0) < 0 ? name(errno) : "ok");
  struct sockaddr_in again = where;
  printf("inuse %s\n", bind(c, (struct sockaddr *)&again, sizeof again) < 0 ? name(errno) : "ok");
  struct sockaddr_in far = at("192.0.2.1", 0);
  printf("farbind %s\n", bind(c, (struct sockaddr *)&far, sizeof far) < 0 ? name(errno) : "ok");
  int one = 1;
  printf("broadcast %s\n", setsockopt(c, SOL_SOCKET, SO_BROADCAST, &one, sizeof one) < 0 ? name(errno) : "ok");
  int type = 0;
  socklen_t tl = sizeof type;
  getsockopt(c, SOL_SOCKET, SO_TYPE, &type, &tl);
  printf("type %s\n", type == SOCK_DGRAM ? "SOCK_DGRAM" : "other");
  return 0;
}

static int refused(void) {
  int probe = dgram();
  struct sockaddr_in any = at("127.0.0.1", 0);
  bind(probe, (struct sockaddr *)&any, sizeof any);
  struct sockaddr_in gone;
  socklen_t gl = sizeof gone;
  getsockname(probe, (struct sockaddr *)&gone, &gl);
  close(probe);
  int s = dgram();
  connect(s, (struct sockaddr *)&gone, gl);
  printf("first %s\n", send(s, "x", 1, 0) < 0 ? name(errno) : "ok");
  char buf[4];
  printf("next %s\n", recv(s, buf, sizeof buf, 0) < 0 ? name(errno) : "data");
  printf("after %s\n", send(s, "x", 1, 0) < 0 ? name(errno) : "ok");
  int t = dgram();
  printf("unconnected %s\n", sendto(t, "x", 1, 0, (struct sockaddr *)&gone, gl) < 0 ? name(errno) : "ok");
  return 0;
}

static int unreachable(void) {
  int s = dgram();
  const char *hosts[] = {"169.254.169.254", "10.0.2.2", "192.0.2.1", "224.0.0.1", "255.255.255.255"};
  for (size_t i = 0; i < sizeof hosts / sizeof *hosts; i++) {
    struct sockaddr_in to = at(hosts[i], 53);
    printf("%s %s\n", hosts[i], sendto(s, "x", 1, 0, (struct sockaddr *)&to, sizeof to) < 0 ? name(errno) : "ok");
  }
  struct sockaddr_in to = at("169.254.169.254", 53);
  printf("connect %s\n", connect(s, (struct sockaddr *)&to, sizeof to) < 0 ? name(errno) : "ok");
  printf("unix %s\n", socket(AF_UNIX, SOCK_DGRAM, 0) < 0 ? name(errno) : "ok");
  return 0;
}

static int unreached(const char *host, int port) {
  struct sockaddr_in to = at(host, port);
  char buf[16];
  struct sockaddr_in from;
  int s = dgram();
  connect(s, (struct sockaddr *)&to, sizeof to);
  printf("connected send %s\n", send(s, "x", 1, 0) < 0 ? name(errno) : "ok");
  ssize_t n = wait_recv(s, buf, sizeof buf, &from, 50);
  printf("connected next %s\n", n < 0 ? name(errno) : "data");
  printf("connected after %s\n", send(s, "x", 1, 0) < 0 ? name(errno) : "ok");
  int t = dgram();
  printf("unconnected send %s\n", sendto(t, "x", 1, 0, (struct sockaddr *)&to, sizeof to) < 0 ? name(errno) : "ok");
  n = wait_recv(t, buf, sizeof buf, &from, 10);
  printf("unconnected next %s\n", n < 0 ? name(errno) : "data");
  return 0;
}

int main(int argc, char **argv) {
  setvbuf(stdout, NULL, _IONBF, 0);
  const char *mode = argc > 1 ? argv[1] : "";
  if (!strcmp(mode, "serve") && argc > 3) return serve(atoi(argv[2]), atoi(argv[3]));
  if (!strcmp(mode, "client") && argc > 4) return client(argv[2], atoi(argv[3]), argv[4]);
  if (!strcmp(mode, "datagrams")) return datagrams();
  if (!strcmp(mode, "refused")) return refused();
  if (!strcmp(mode, "unreachable")) return unreachable();
  if (!strcmp(mode, "unreached") && argc > 3) return unreached(argv[2], atoi(argv[3]));
  fprintf(stderr, "usage: udptest serve|client|datagrams|refused|unreachable\n");
  return 2;
}
