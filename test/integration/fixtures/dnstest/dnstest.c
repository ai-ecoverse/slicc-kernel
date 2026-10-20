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

static int type_of(const char *t) {
  if (!strcmp(t, "A")) return 1;
  if (!strcmp(t, "NS")) return 2;
  if (!strcmp(t, "PTR")) return 12;
  if (!strcmp(t, "MX")) return 15;
  if (!strcmp(t, "TXT")) return 16;
  if (!strcmp(t, "AAAA")) return 28;
  return atoi(t);
}

static size_t query(unsigned char *q, const char *name, int type, int edns, int id) {
  size_t n = 0;
  q[n++] = id >> 8;
  q[n++] = id & 255;
  q[n++] = 1;
  q[n++] = 0;
  q[n++] = 0;
  q[n++] = 1;
  memset(q + n, 0, 6);
  q[11] = edns ? 1 : 0;
  n += 6;
  const char *p = name;
  while (*p) {
    const char *dot = strchr(p, '.');
    size_t len = dot ? (size_t)(dot - p) : strlen(p);
    q[n++] = (unsigned char)len;
    memcpy(q + n, p, len);
    n += len;
    p += len;
    if (*p == '.') p++;
  }
  q[n++] = 0;
  q[n++] = type >> 8;
  q[n++] = type & 255;
  q[n++] = 0;
  q[n++] = 1;
  if (edns) {
    unsigned char opt[11] = {0, 0, 41, 4, 208, 0, 0, 0, 0, 0, 0};
    memcpy(q + n, opt, sizeof opt);
    n += sizeof opt;
  }
  return n;
}

static size_t name_at(const unsigned char *m, size_t len, size_t at, char *out, size_t *end) {
  size_t o = 0;
  int jumped = 0;
  for (int hops = 0; hops < 64 && at < len; hops++) {
    unsigned c = m[at];
    if (c == 0) {
      if (!jumped) *end = at + 1;
      break;
    }
    if ((c & 0xc0) == 0xc0) {
      if (!jumped) *end = at + 2;
      jumped = 1;
      at = ((c & 0x3f) << 8) | m[at + 1];
      continue;
    }
    if (o) out[o++] = '.';
    memcpy(out + o, m + at + 1, c);
    o += c;
    at += c + 1;
  }
  out[o] = 0;
  return o;
}

static int show(const unsigned char *m, size_t len, int id) {
  if (len < 12) {
    printf("short %zu\n", len);
    return 1;
  }
  int flags = (m[2] << 8) | m[3];
  printf("id %s rcode %d aa %d tc %d ra %d", ((m[0] << 8) | m[1]) == id ? "ok" : "bad", flags & 15,
         (flags >> 10) & 1, (flags >> 9) & 1, (flags >> 7) & 1);
  int qd = (m[4] << 8) | m[5], an = (m[6] << 8) | m[7], ar = (m[10] << 8) | m[11];
  printf(" an %d ar %d\n", an, ar);
  size_t at = 12;
  char name[300];
  for (int i = 0; i < qd; i++) {
    name_at(m, len, at, name, &at);
    at += 4;
  }
  for (int i = 0; i < an && at < len; i++) {
    name_at(m, len, at, name, &at);
    int type = (m[at] << 8) | m[at + 1];
    unsigned ttl = ((unsigned)m[at + 4] << 24) | (m[at + 5] << 16) | (m[at + 6] << 8) | m[at + 7];
    int rdlen = (m[at + 8] << 8) | m[at + 9];
    at += 10;
    char data[300];
    if (type == 1 && rdlen == 4) {
      snprintf(data, sizeof data, "%d.%d.%d.%d", m[at], m[at + 1], m[at + 2], m[at + 3]);
    } else if (type == 28 && rdlen == 16) {
      inet_ntop(AF_INET6, m + at, data, sizeof data);
    } else if (type == 12 || type == 2) {
      size_t e;
      name_at(m, len, at, data, &e);
    } else if (type == 15) {
      size_t e;
      char host[300];
      name_at(m, len, at + 2, host, &e);
      snprintf(data, sizeof data, "%d %s", (m[at] << 8) | m[at + 1], host);
    } else {
      snprintf(data, sizeof data, "%d bytes", rdlen);
    }
    printf("%s %u %d %s\n", name, ttl, type, data);
    at += rdlen;
  }
  return 0;
}

static int over_udp(const char *server, const unsigned char *q, size_t n, unsigned char *r) {
  int s = socket(AF_INET, SOCK_DGRAM, 0);
  struct sockaddr_in to = {0};
  to.sin_family = AF_INET;
  to.sin_port = htons(53);
  inet_pton(AF_INET, server, &to.sin_addr);
  if (connect(s, (struct sockaddr *)&to, sizeof to) < 0 || send(s, q, n, 0) < 0) {
    printf("send %s\n", strerror(errno));
    return -1;
  }
  fcntl(s, F_SETFL, fcntl(s, F_GETFL) | O_NONBLOCK);
  for (int i = 0; i < 150; i++) {
    ssize_t got = recv(s, r, 65535, 0);
    if (got >= 0) return (int)got;
    if (errno != EAGAIN) {
      printf("recv %s\n", strerror(errno));
      return -1;
    }
    struct timespec t = {0, 20000000L};
    nanosleep(&t, NULL);
  }
  printf("timeout\n");
  return -1;
}

static int read_all(int s, unsigned char *b, size_t n) {
  size_t at = 0;
  while (at < n) {
    ssize_t got = read(s, b + at, n - at);
    if (got <= 0) return -1;
    at += (size_t)got;
  }
  return 0;
}

static int over_tcp(const char *server, const unsigned char *q, size_t n, unsigned char *r, int twice) {
  int s = socket(AF_INET, SOCK_STREAM, 0);
  struct sockaddr_in to = {0};
  to.sin_family = AF_INET;
  to.sin_port = htons(53);
  inet_pton(AF_INET, server, &to.sin_addr);
  if (connect(s, (struct sockaddr *)&to, sizeof to) < 0) {
    printf("connect %s\n", strerror(errno));
    return -1;
  }
  unsigned char framed[1024];
  framed[0] = n >> 8;
  framed[1] = n & 255;
  memcpy(framed + 2, q, n);
  int len = -1;
  for (int round = 0; round <= twice; round++) {
    if (write(s, framed, n + 2) != (ssize_t)(n + 2)) return -1;
    unsigned char head[2];
    if (read_all(s, head, 2) < 0) {
      printf("eof\n");
      return -1;
    }
    len = (head[0] << 8) | head[1];
    if (read_all(s, r, (size_t)len) < 0) return -1;
  }
  close(s);
  return len;
}

static int flood(const char *server, const char *name, int type, int count) {
  int s = socket(AF_INET, SOCK_DGRAM, 0);
  struct sockaddr_in to = {0};
  to.sin_family = AF_INET;
  to.sin_port = htons(53);
  inet_pton(AF_INET, server, &to.sin_addr);
  if (connect(s, (struct sockaddr *)&to, sizeof to) < 0) return 1;
  unsigned char q[1024];
  for (int i = 0; i < count; i++) {
    size_t n = query(q, name, type, 0, i + 1);
    if (send(s, q, n, 0) < 0) {
      printf("send %s\n", strerror(errno));
      return 1;
    }
  }
  printf("sent %d\n", count);
  return 0;
}

static int stall(const char *server, const char *name, int type, int seconds) {
  int s = socket(AF_INET, SOCK_STREAM, 0);
  struct sockaddr_in to = {0};
  to.sin_family = AF_INET;
  to.sin_port = htons(53);
  inet_pton(AF_INET, server, &to.sin_addr);
  if (connect(s, (struct sockaddr *)&to, sizeof to) < 0) {
    printf("connect %s\n", strerror(errno));
    return 1;
  }
  unsigned char q[1024], framed[1026];
  size_t n = query(q, name, type, 0, 7);
  framed[0] = n >> 8;
  framed[1] = n & 255;
  memcpy(framed + 2, q, n);
  fcntl(s, F_SETFL, fcntl(s, F_GETFL) | O_NONBLOCK);
  int wrote = 0;
  for (int i = 0; i < 20000; i++) {
    ssize_t w = write(s, framed, n + 2);
    if (w == (ssize_t)(n + 2)) {
      wrote++;
      continue;
    }
    if (w < 0 && errno == EAGAIN) {
      struct timespec t = {0, 50000000L};
      nanosleep(&t, NULL);
      if (write(s, framed, n + 2) == (ssize_t)(n + 2)) {
        wrote++;
        continue;
      }
    }
    break;
  }
  struct timespec wait = {seconds, 0};
  nanosleep(&wait, NULL);
  fcntl(s, F_SETFL, fcntl(s, F_GETFL) & ~O_NONBLOCK);
  int got = 0;
  unsigned char head[2], r[65536];
  while (read_all(s, head, 2) == 0 && read_all(s, r, (size_t)((head[0] << 8) | head[1])) == 0) got++;
  printf("wrote %d got %d %s\n", wrote, got, got < wrote ? "closed" : "all");
  return 0;
}

int main(int argc, char **argv) {
  if (argc == 6 && !strcmp(argv[1], "flood")) return flood(argv[2], argv[3], type_of(argv[4]), atoi(argv[5]));
  if (argc == 6 && !strcmp(argv[1], "stall")) return stall(argv[2], argv[3], type_of(argv[4]), atoi(argv[5]));
  if (argc < 5) {
    fprintf(stderr, "usage: dnstest udp|tcp|tcp2 <server> <name> <type> [edns]\n");
    return 2;
  }
  unsigned char q[1024], r[65536];
  int id = 0x2a5b;
  size_t n = query(q, argv[3], type_of(argv[4]), argc > 5 && !strcmp(argv[5], "edns"), id);
  int len = !strcmp(argv[1], "udp") ? over_udp(argv[2], q, n, r)
                                    : over_tcp(argv[2], q, n, r, !strcmp(argv[1], "tcp2"));
  if (len < 0) return 1;
  return show(r, (size_t)len, id);
}
