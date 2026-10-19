#include <pthread.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#define PAIRS 4
static _Atomic(unsigned char *) slot[PAIRS];
static _Atomic int done;
static _Atomic long handed, touched;
static void *producer(void *arg) {
  long i = (long)arg;
  size_t size = (1 + (i % 3)) << 20;
  for (int n = 0; n < 60; n++) {
    unsigned char *p = malloc(size);
    if (!p) break;
    p[0] = 1;
    while (atomic_load(&slot[i])) ;
    atomic_store(&slot[i], p + size - 1);
    atomic_fetch_add(&handed, 1);
  }
  atomic_fetch_add(&done, 1);
  return 0;
}
static void *consumer(void *arg) {
  long i = (long)arg;
  for (;;) {
    unsigned char *p = atomic_exchange(&slot[i], 0);
    if (p) { *p = 2; atomic_fetch_add(&touched, 1); continue; }
    if (atomic_load(&done) == PAIRS && !atomic_load(&slot[i])) break;
  }
  return 0;
}
int main(void) {
  pthread_t t[2 * PAIRS];
  for (long i = 0; i < PAIRS; i++) {
    pthread_create(&t[2 * i], 0, consumer, (void *)i);
    pthread_create(&t[2 * i + 1], 0, producer, (void *)i);
  }
  for (int i = 0; i < 2 * PAIRS; i++) pthread_join(t[i], 0);
  printf("handed %ld touched %ld heap-end %zu MiB\n", atomic_load(&handed), atomic_load(&touched), (size_t)__builtin_wasm_memory_size(0) * 65536 >> 20);
  return 0;
}
