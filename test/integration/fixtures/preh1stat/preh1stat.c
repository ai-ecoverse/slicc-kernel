#include <stdio.h>
#include <sys/stat.h>
#include <unistd.h>

int main(int argc, char **argv) {
  printf("ids %u %u %u %u\n", (unsigned)getuid(), (unsigned)geteuid(), (unsigned)getgid(),
         (unsigned)getegid());
  for (int i = 1; i < argc; i++) {
    struct stat st;
    if (stat(argv[i], &st) != 0) {
      perror(argv[i]);
      return 1;
    }
    printf("%u %u %s\n", (unsigned)st.st_uid, (unsigned)st.st_gid, argv[i]);
  }
  return 0;
}
