#include <arpa/inet.h>
#include <netinet/in.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/socket.h>
#include <unistd.h>

static int send_all(int fd, const char *buf, size_t len) {
  while (len > 0) {
    ssize_t n = write(fd, buf, len);
    if (n <= 0) return -1;
    buf += n;
    len -= (size_t)n;
  }
  return 0;
}

static int send_text(int fd, const char *text) { return send_all(fd, text, strlen(text)); }

static void serve(int fd) {
  char head[8192];
  size_t got = 0;
  char *end = NULL;
  while (got < sizeof head - 1) {
    ssize_t n = read(fd, head + got, sizeof head - 1 - got);
    if (n <= 0) return;
    got += (size_t)n;
    head[got] = 0;
    if ((end = strstr(head, "\r\n\r\n"))) break;
  }
  if (!end) return;
  char method[16] = {0}, path[1024] = {0};
  sscanf(head, "%15s %1023s", method, path);
  long length = 0;
  for (char *line = strstr(head, "\r\n"); line && line < end; line = strstr(line + 2, "\r\n")) {
    if (!strncasecmp(line + 2, "content-length:", 15)) length = strtol(line + 17, NULL, 10);
  }
  char *body = end + 4;
  size_t have = got - (size_t)(body - head);
  char reply[512];
  if (!strcmp(path, "/file")) {
    const char *text = "hello from the kernel\n";
    snprintf(reply, sizeof reply,
             "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: %zu\r\nConnection: close\r\n\r\n%s",
             strlen(text), text);
    send_text(fd, reply);
  } else if (!strcmp(path, "/x.js")) {
    const char *script = "globalThis.fromKernel = 'hello from the kernel';\n";
    snprintf(reply, sizeof reply,
             "HTTP/1.1 200 OK\r\nContent-Type: text/javascript\r\nCross-Origin-Resource-Policy: cross-origin\r\nContent-Length: %zu\r\nConnection: close\r\n\r\n%s",
             strlen(script), script);
    send_text(fd, reply);
  } else if (!strcmp(path, "/events")) {
    send_text(fd, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n");
    for (int i = 1; i <= 3; i++) {
      char event[64], chunk[96];
      int n = snprintf(event, sizeof event, "data: event %d\n\n", i);
      snprintf(chunk, sizeof chunk, "%x\r\n%s\r\n", n, event);
      if (send_text(fd, chunk)) return;
      usleep(100000);
    }
    send_text(fd, "0\r\n\r\n");
  } else if (!strcmp(method, "POST") && !strcmp(path, "/echo")) {
    char *data = malloc((size_t)length + 1);
    size_t at = have < (size_t)length ? have : (size_t)length;
    memcpy(data, body, at);
    while (at < (size_t)length) {
      ssize_t n = read(fd, data + at, (size_t)length - at);
      if (n <= 0) break;
      at += (size_t)n;
    }
    snprintf(reply, sizeof reply,
             "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: %zu\r\nConnection: close\r\n\r\n",
             at);
    send_text(fd, reply);
    send_all(fd, data, at);
    free(data);
  } else {
    send_text(fd, "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
  }
}

int main(int argc, char **argv) {
  int port = argc > 1 ? atoi(argv[1]) : 8400;
  int s = socket(AF_INET, SOCK_STREAM, 0);
  struct sockaddr_in addr = {0};
  addr.sin_family = AF_INET;
  addr.sin_port = htons((unsigned short)port);
  addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  if (s < 0 || bind(s, (struct sockaddr *)&addr, sizeof addr) || listen(s, 16)) {
    perror("httptest");
    return 1;
  }
  printf("listening %d\n", port);
  fflush(stdout);
  for (;;) {
    int c = accept(s, NULL, NULL);
    if (c < 0) continue;
    serve(c);
    close(c);
  }
}
