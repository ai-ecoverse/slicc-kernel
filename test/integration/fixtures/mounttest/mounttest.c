#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

__attribute__((import_module("slicc"), import_name("mount"))) uint16_t
slicc_mount(const char *src, size_t src_len, const char *target, size_t target_len,
            const char *type, size_t type_len, uint32_t flags, const char *data, size_t data_len);

__attribute__((import_module("slicc"), import_name("umount2"))) uint16_t
slicc_umount2(const char *target, size_t target_len, uint32_t flags);

static int report(const char *what, const char *target, uint16_t err) {
  if (!err) return 0;
  errno = err;
  fprintf(stderr, "%s %s: %s (%u)\n", what, target, strerror(errno), err);
  return 1;
}

int main(int argc, char **argv) {
  if (argc >= 7 && !strcmp(argv[1], "mount")) {
    const char *src = argv[2], *target = argv[3], *type = argv[4], *data = argv[6];
    uint32_t flags = (uint32_t)strtoul(argv[5], NULL, 0);
    return report("mount", target,
                  slicc_mount(src, strlen(src), target, strlen(target), type, strlen(type), flags,
                              data, strlen(data)));
  }
  if (argc >= 4 && !strcmp(argv[1], "umount")) {
    const char *target = argv[2];
    uint32_t flags = (uint32_t)strtoul(argv[3], NULL, 0);
    return report("umount", target, slicc_umount2(target, strlen(target), flags));
  }
  fprintf(stderr, "usage: mounttest mount SOURCE TARGET TYPE FLAGS DATA | umount TARGET FLAGS\n");
  return 2;
}
