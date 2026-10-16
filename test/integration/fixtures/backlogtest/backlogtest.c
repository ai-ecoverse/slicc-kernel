#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>

#define MAX 64

static struct sockaddr_in at(int port) {
  struct sockaddr_in a;
  memset(&a, 0, sizeof a);
  a.sin_family = AF_INET;
  a.sin_port = htons((unsigned short)port);
  inet_pton(AF_INET, "127.0.0.1", &a.sin_addr);
  return a;
}

static void pause_ms(int ms) {
  struct timespec t = {ms / 1000, (ms % 1000) * 1000000L};
  nanosleep(&t, NULL);
}

static int listener(int port, int backlog) {
  int s = socket(AF_INET, SOCK_STREAM, 0);
  int one = 1;
  setsockopt(s, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
  struct sockaddr_in a = at(port);
  if (bind(s, (struct sockaddr *)&a, sizeof a) < 0 || listen(s, backlog) < 0) {
    printf("listen %s\n", strerror(errno));
    exit(1);
  }
  return s;
}

static int echo_one(int l) {
  int c = accept(l, NULL, NULL);
  if (c < 0) return -1;
  char buf[16];
  ssize_t n = read(c, buf, sizeof buf);
  if (n > 0) write(c, buf, (size_t)n);
  close(c);
  return 0;
}

static int nonblocking(int count) {
  int l = listener(0, 1);
  struct sockaddr_in a;
  socklen_t al = sizeof a;
  getsockname(l, (struct sockaddr *)&a, &al);
  int fds[MAX];
  int progress = 0, refused = 0;
  for (int i = 0; i < count; i++) {
    fds[i] = socket(AF_INET, SOCK_STREAM, 0);
    fcntl(fds[i], F_SETFL, fcntl(fds[i], F_GETFL) | O_NONBLOCK);
    if (connect(fds[i], (struct sockaddr *)&a, al) < 0) {
      if (errno == EINPROGRESS) progress++;
      else refused++;
    }
  }
  printf("connects: %d in progress, %d refused\n", progress, refused);
  int served = 0;
  for (int i = 0; i < count; i++) {
    struct pollfd p = {fds[i], POLLOUT, 0};
    while (poll(&p, 1, 0) == 0) echo_one(l);
    int err = 0;
    socklen_t el = sizeof err;
    getsockopt(fds[i], SOL_SOCKET, SO_ERROR, &err, &el);
    if (err != 0) {
      printf("client %d: %s\n", i, strerror(err));
      continue;
    }
    fcntl(fds[i], F_SETFL, fcntl(fds[i], F_GETFL) & ~O_NONBLOCK);
    write(fds[i], "hi", 2);
    while (1) {
      struct pollfd r = {fds[i], POLLIN, 0};
      if (poll(&r, 1, 0) > 0) break;
      echo_one(l);
    }
    char buf[4] = {0};
    if (read(fds[i], buf, sizeof buf) == 2 && !memcmp(buf, "hi", 2)) served++;
    close(fds[i]);
  }
  printf("served %d of %d\n", served, count);
  return served == count ? 0 : 1;
}

static int serve(int port, int count) {
  int l = listener(port, 1);
  printf("listening\n");
  for (int i = 0; i < count; i++) {
    pause_ms(30);
    echo_one(l);
  }
  return 0;
}

static int clients(int port, int count) {
  struct sockaddr_in a = at(port);
  int fds[MAX];
  int ok = 0;
  for (int tries = 0; tries < 100; tries++) {
    int s = socket(AF_INET, SOCK_STREAM, 0);
    if (connect(s, (struct sockaddr *)&a, sizeof a) == 0) {
      fds[0] = s;
      write(s, "ok", 2);
      break;
    }
    close(s);
    pause_ms(20);
  }
  for (int i = 1; i < count; i++) {
    fds[i] = socket(AF_INET, SOCK_STREAM, 0);
    if (connect(fds[i], (struct sockaddr *)&a, sizeof a) < 0) {
      printf("connect %d: %s\n", i, strerror(errno));
      return 1;
    }
    write(fds[i], "ok", 2);
  }
  for (int i = 0; i < count; i++) {
    char buf[4] = {0};
    if (read(fds[i], buf, sizeof buf) == 2 && !memcmp(buf, "ok", 2)) ok++;
    close(fds[i]);
  }
  printf("blocking connects %d of %d echoed\n", ok, count);
  return ok == count ? 0 : 1;
}

int main(int argc, char **argv) {
  setvbuf(stdout, NULL, _IONBF, 0);
  const char *mode = argc > 1 ? argv[1] : "";
  int count = argc > 2 ? atoi(argv[argc - 1]) : 20;
  if (count > MAX) count = MAX;
  if (!strcmp(mode, "nonblocking")) return nonblocking(count);
  if (!strcmp(mode, "serve") && argc > 3) return serve(atoi(argv[2]), count);
  if (!strcmp(mode, "clients") && argc > 3) return clients(atoi(argv[2]), count);
  fprintf(stderr, "usage: backlogtest nonblocking N | serve PORT N | clients PORT N\n");
  return 2;
}
