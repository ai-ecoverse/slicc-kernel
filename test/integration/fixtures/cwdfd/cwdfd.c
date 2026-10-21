#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static void names(const char *label, const char *path) {
  DIR *dir = opendir(path);
  if (!dir) {
    printf("%s error %s\n", label, strerror(errno));
    return;
  }
  char *all[64];
  int n = 0;
  struct dirent *e;
  while ((e = readdir(dir)) && n < 64) {
    if (strcmp(e->d_name, ".") && strcmp(e->d_name, "..")) all[n++] = strdup(e->d_name);
  }
  closedir(dir);
  for (int i = 0; i < n; i++)
    for (int j = i + 1; j < n; j++)
      if (strcmp(all[j], all[i]) < 0) {
        char *t = all[i];
        all[i] = all[j];
        all[j] = t;
      }
  printf("%s [", label);
  for (int i = 0; i < n; i++) printf(i ? ",%s" : "%s", all[i]);
  printf("]\n");
}

static void cwd(const char *label) {
  char buf[PATH_MAX];
  if (getcwd(buf, sizeof buf)) printf("%s %s\n", label, buf);
  else printf("%s %s\n", label, errno == ENOENT ? "ENOENT" : strerror(errno));
}

int main(void) {
  names("before", ".");
  cwd("getcwd");
  fflush(stdout);
  char line[16];
  if (!fgets(line, sizeof line, stdin)) return 1;
  names("after", ".");
  int fd = open("made", O_WRONLY | O_CREAT, 0644);
  printf("create %s\n", fd >= 0 ? "ok" : errno == ENOENT ? "ENOENT" : strerror(errno));
  struct stat st;
  printf("stat %s\n", stat("x", &st) == 0 ? "ok" : errno == ENOENT ? "ENOENT" : strerror(errno));
  cwd("getcwd");
  printf("chdir %s\n", chdir("..") == 0 ? "ok" : strerror(errno));
  cwd("then");
  names("parent", ".");
  return 0;
}
