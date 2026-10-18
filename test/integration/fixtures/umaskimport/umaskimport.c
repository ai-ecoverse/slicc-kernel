#include <fcntl.h>
#include <stdio.h>
#include <sys/stat.h>
#include <unistd.h>

__attribute__((import_module("umask_host"), import_name("restrict"))) void host_restrict(void);

static unsigned mode_of(const char *path) {
  struct stat st;
  return stat(path, &st) == 0 ? (unsigned)(st.st_mode & 0777) : 01000;
}

int main(int argc, char **argv) {
  if (argc < 2 || chdir(argv[1]) != 0) return 2;
  umask(002);
  close(open("before", O_WRONLY | O_CREAT | O_EXCL, 0666));
  host_restrict();
  close(open("after", O_WRONLY | O_CREAT | O_EXCL, 0666));
  mkdir("dir", 0777);
  mode_t now = umask(022);
  printf("%03o %03o %03o %03o\n", mode_of("before"), mode_of("after"), mode_of("dir"), (unsigned)now);
  return 0;
}
