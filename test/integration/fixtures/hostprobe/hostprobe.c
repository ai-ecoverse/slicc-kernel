#include <stdio.h>
#include <stdlib.h>
#include <sys/utsname.h>
#include <unistd.h>

int main(void) {
  const char *env = getenv("HOSTNAME");
  char name[256];
  struct utsname u;
  printf("env %s\n", env ? env : "(none)");
  printf("gethostname %s\n", gethostname(name, sizeof name) == 0 ? name : "(error)");
  printf("uname %s\n", uname(&u) == 0 ? u.nodename : "(error)");
  return 0;
}
