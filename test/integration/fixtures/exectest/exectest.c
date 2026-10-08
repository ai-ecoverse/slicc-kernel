#include <stdio.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

int main(int argc, char **argv) {
  if (argc > 1 && !strcmp(argv[1], "show")) {
    printf("image %d %d\n", (int)getpid(), (int)getppid());
    return 0;
  }
  if (argc > 1 && !strcmp(argv[1], "exec")) {
    printf("before %d\n", (int)getpid());
    fflush(stdout);
    char *args[] = {"exectest", "show", NULL};
    execvp("exectest", args);
    perror("execvp");
    return 127;
  }
  if (argc > 1 && !strcmp(argv[1], "fork")) {
    printf("parent %d\n", (int)getpid());
    fflush(stdout);
    pid_t child = fork();
    if (child == 0) {
      char *args[] = {"exectest", "show", NULL};
      execvp("exectest", args);
      _exit(127);
    }
    int status = 0;
    waitpid(child, &status, 0);
    printf("child %d %d\n", (int)child, WEXITSTATUS(status));
    return 0;
  }
  fprintf(stderr, "usage: exectest show | exec | fork\n");
  return 2;
}
