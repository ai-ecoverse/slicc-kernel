#include <pthread.h>
#include <setjmp.h>
#include <stdio.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

static volatile int stop;
static volatile int damaged;

static void deep(int d) {
  volatile unsigned char pad[256];
  memset((void *)pad, d & 0xff, sizeof pad);
  if (d > 0) deep(d - 1);
  else
    for (int i = 0; i < 2000 && !stop; i++) usleep(100);
  for (int i = 0; i < (int)sizeof pad; i++)
    if (pad[i] != (unsigned char)(d & 0xff)) damaged++;
}

#ifndef FORK_ONLY
static jmp_buf jb;

static int bounce(int depth) {
  volatile char pad[128];
  pad[depth % 128] = (char)depth;
  if (depth == 0) longjmp(jb, 1);
  return bounce(depth - 1) + pad[depth % 128];
}
#endif

static void *worker(void *unused) {
  (void)unused;
  volatile int jumps = 0;
#ifndef FORK_ONLY
  while (setjmp(jb) != 0 || jumps == 0) {
    if (++jumps > 50) break;
    bounce(40);
  }
  printf("thread jumps=%d\n", jumps - 1);
#else
  jumps = 1;
#endif
  pid_t p = fork();
  if (p < 0) {
    perror("thread fork");
    stop = 1;
    return NULL;
  }
  if (p == 0) {
    printf("child of the thread jumps=%d\n", jumps - 1);
    pid_t q = fork();
    if (q == 0) _exit(4);
    int cst = 0;
    waitpid(q, &cst, 0);
    printf("its child exit=%d\n", q > 0 ? WEXITSTATUS(cst) : -1);
    _exit(3);
  }
  int st = 0;
  waitpid(p, &st, 0);
  printf("thread child exit=%d\n", WEXITSTATUS(st));
  stop = 1;
  return NULL;
}

int main(void) {
  setvbuf(stdout, NULL, _IONBF, 0);
  pthread_t w;
  pthread_create(&w, NULL, worker, NULL);
  while (!stop) deep(200);
  pthread_join(w, NULL);
  printf("main damaged=%d\n", damaged);
  return 0;
}
