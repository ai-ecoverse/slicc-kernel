#include <stdio.h>

int main(int argc, char **argv) {
  printf("hello from an -O0 emcc build, %d args\n", argc - 1);
  return 0;
}
