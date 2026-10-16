#if __has_include(<dlfcn.h>)
#include <dlfcn.h>
#endif
#include <errno.h>
#include <stdio.h>
#include <sys/wait.h>
#include <unistd.h>

extern __thread int local_exec __attribute__((tls_model("local-exec")));
extern __thread int global_dynamic __attribute__((tls_model("global-dynamic")));

static int (*side_bump)(void);

__attribute__((noinline)) static int *where(void) { return &errno; }

static void probe(const char *who) {
  errno = 0;
  int r = close(4321);
  int e = errno;
  local_exec++;
  global_dynamic++;
  printf("%s close=%d errno=%d errno-via-pointer=%d local-exec=%d global-dynamic=%d", who, r, e,
         *where(), local_exec, global_dynamic);
  if (side_bump) printf(" side=%d", side_bump());
  printf("\n");
}

int main(int argc, char **argv) {
  setvbuf(stdout, NULL, _IONBF, 0);
#if __has_include(<dlfcn.h>)
  if (argc > 1) {
    void *h = dlopen(argv[1], RTLD_NOW);
    if (!h) {
      printf("dlopen: %s\n", dlerror());
      return 1;
    }
    side_bump = (int (*)(void))dlsym(h, "side_tls_bump");
  }
#endif
  local_exec = 10;
  global_dynamic = 20;
  probe("parent");
  pid_t p = fork();
  if (p == 0) {
    probe("child");
    _exit(0);
  }
  int st;
  waitpid(p, &st, 0);
  probe("parent");
  return 0;
}
