#include <dlfcn.h>
#include <stdio.h>
#include <sys/wait.h>
#include <unistd.h>

int main(int argc, char **argv) {
  setvbuf(stdout, NULL, _IONBF, 0);
  void *h = dlopen(argc > 1 ? argv[1] : "/usr/lib/libdlside.so", RTLD_NOW);
  if (!h) {
    printf("dlopen: %s\n", dlerror());
    return 1;
  }
  int (*add)(int, int) = (int (*)(int, int))dlsym(h, "side_add");
  int (*bump)(void) = (int (*)(void))dlsym(h, "side_bump");
  int *count = (int *)dlsym(h, "side_count");
  int *inits = (int *)dlsym(h, "side_inits");
  bump();
  bump();
  printf("parent: add=%d count=%d inits=%d\n", add(2, 3), *count, *inits);
  pid_t p = fork();
  if (p < 0) {
    printf("fork failed\n");
    return 1;
  }
  if (p == 0) {
    int seen = *count;
    int after = bump();
    printf("child: add=%d count=%d bump=%d inits=%d\n", add(2, 3), seen, after, *inits);
    _exit(7);
  }
  int st = 0;
  waitpid(p, &st, 0);
  printf("parent: child %s=%d count=%d\n", WIFEXITED(st) ? "exit" : "signal", WIFEXITED(st) ? WEXITSTATUS(st) : WTERMSIG(st), *count);
  return 0;
}
