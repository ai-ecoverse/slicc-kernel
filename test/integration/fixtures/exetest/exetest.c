#include <stdio.h>
#include <string.h>
#include <unistd.h>

int main(int argc, char **argv) {
  char buf[512];
  ssize_t n = readlink("/proc/self/exe", buf, sizeof buf - 1);
  if (n < 0) return perror("readlink"), 1;
  buf[n] = 0;
  printf("exe=%s argv0=%s\n", buf, argc > 0 ? argv[0] : "");
  return 0;
}
