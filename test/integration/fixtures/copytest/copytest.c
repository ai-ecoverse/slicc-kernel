#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef HOST
__attribute__((import_module("copy_host"), import_name("copy")))
int32_t host_copy(const char *src, uint32_t src_len, const char *dst, uint32_t dst_len, uint32_t mode,
                  uint32_t excl);
static int32_t k_path_copy_file(int32_t src_dirfd, const char *src, uint32_t src_len, int32_t dst_dirfd,
                                const char *dst, uint32_t dst_len, uint32_t mode, uint32_t flags) {
  (void)src_dirfd;
  (void)dst_dirfd;
  return host_copy(src, src_len, dst, dst_len, mode, flags & 1);
}
#else
__attribute__((import_module("slicc_fs"), import_name("path_copy_file")))
int32_t k_path_copy_file(int32_t src_dirfd, const char *src, uint32_t src_len, int32_t dst_dirfd,
                         const char *dst, uint32_t dst_len, uint32_t mode, uint32_t flags);
#endif

static long counter(const char *name) {
  char path[128];
  snprintf(path, sizeof path, "/proc/sys/kernel/%s", name);
  FILE *f = fopen(path, "r");
  if (!f) return 0;
  long v = 0;
  if (fscanf(f, "%ld", &v) != 1) v = 0;
  fclose(f);
  return v;
}

static int copy(const char *src, const char *dst, const char *mode, const char *flags) {
  int e = k_path_copy_file(-2, src, strlen(src), -2, dst, strlen(dst), (uint32_t)strtol(mode, NULL, 8),
                           (uint32_t)strtol(flags, NULL, 10));
  printf("copy %s: %s\n", dst, e ? strerror(e) : "ok");
  return 0;
}

static int many(const char *src, const char *dst, int n) {
  char from[512], to[512];
  const char *names[] = {"slicc_fs_calls", "slicc_opfs_calls", "slicc_opfs_ops"};
  long before[3], after[3];
  for (int k = 0; k < 3; k++) before[k] = counter(names[k]);
  for (int i = 0; i < n; i++) {
    snprintf(from, sizeof from, "%s/f%d", src, i);
    snprintf(to, sizeof to, "%s/f%d", dst, i);
    int e = k_path_copy_file(-2, from, strlen(from), -2, to, strlen(to), 0644, 1);
    if (e) return printf("copy %s: %s\n", to, strerror(e)), 1;
  }
  for (int k = 0; k < 3; k++) after[k] = counter(names[k]);
  printf("%ld %ld %ld\n", after[0] - before[0], after[1] - before[1], after[2] - before[2]);
  return 0;
}

int main(int argc, char **argv) {
  if (argc == 6 && strcmp(argv[1], "copy") == 0) return copy(argv[2], argv[3], argv[4], argv[5]);
  if (argc == 5 && strcmp(argv[1], "many") == 0) return many(argv[2], argv[3], atoi(argv[4]));
  fprintf(stderr, "usage: copytest copy SRC DST MODE FLAGS | many SRCDIR DSTDIR N\n");
  return 2;
}
