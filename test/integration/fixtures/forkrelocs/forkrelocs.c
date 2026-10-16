#include <dlfcn.h>
#include <stdio.h>
#include <sys/wait.h>
#include <unistd.h>

static int a = 1, b = 2;
int *p = &a;

int main(int argc, char **argv) {
  setvbuf(stdout, NULL, _IONBF, 0);
  int (*side_moved)(void) = NULL;
  if (argc > 1) {
    void *h = dlopen(argv[1], RTLD_NOW);
    if (!h) {
      printf("dlopen: %s\n", dlerror());
      return 1;
    }
    void (*side_move)(void) = (void (*)(void))dlsym(h, "side_move");
    side_moved = (int (*)(void))dlsym(h, "side_moved");
    side_move();
  }
  p = &b;
  pid_t pid = fork();
  if (pid == 0) {
    printf("child: p %s", p == &b ? "&b (kept)" : "&a (reset)");
    if (side_moved) printf(", side pointer %s", side_moved() ? "kept" : "reset");
    printf("\n");
    _exit(0);
  }
  int st = 0;
  waitpid(pid, &st, 0);
  return 0;
}
