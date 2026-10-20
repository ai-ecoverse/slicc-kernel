#include <stdio.h>

static volatile int sink;

static int deep(int n) {
  volatile char pad[256];
  pad[0] = (char)n;
  sink += pad[0];
  return deep(n + 1) + pad[0];
}

int main(void) {
  printf("going deep\n");
  fflush(stdout);
  return deep(0);
}
