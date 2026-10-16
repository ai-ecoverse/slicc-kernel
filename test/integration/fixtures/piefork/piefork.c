#include <stdio.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

static unsigned char pattern[8192] = {1};
static unsigned char snap[65536];
static int broken;

static int bad(void) {
  int n = 0;
  for (int i = 0; i < 8192; i++)
    if (pattern[i] != (unsigned char)(i * 7 + 3)) n++;
  return n;
}

static int lowdiff(void) {
  volatile unsigned char *m = (volatile unsigned char *)16;
  int n = 0;
  for (int i = 0; i < 65536 - 16; i++)
    if (m[i] != snap[i]) n++;
  return n;
}

static void takesnap(void) {
  volatile unsigned char *m = (volatile unsigned char *)16;
  for (int i = 0; i < 65536 - 16; i++) snap[i] = m[i];
}

static const char *who = "parent";
static volatile int sink;

static void scribble(void) {
  volatile char block[65536];
  for (int i = 0; i < (int)sizeof block; i++) block[i] = (char)0xa5;
  sink += block[sink & 0xffff];
}
static int low;

static int deep(int d) {
  volatile char pad[64];
  pad[d % 64] = (char)d;
  if (d == 0) {
    takesnap();
    pid_t p = fork();
    low = lowdiff();
    scribble();
    if (p == 0) who = "child";
    else {
      int st;
      waitpid(p, &st, 0);
      printf("child exit=%d\n", WEXITSTATUS(st));
    }
    return 0;
  }
  int r = deep(d - 1);
  volatile char frames[256];
  for (int i = 0; i < 256; i++) frames[i] = (char)d;
  if (pad[d % 64] != (char)d) broken++;
  if (frames[d % 256] != (char)d) broken++;
  return r;
}

int main(void) {
  setvbuf(stdout, NULL, _IONBF, 0);
  for (int i = 0; i < 8192; i++) pattern[i] = (unsigned char)(i * 7 + 3);
  deep(300);
  printf("%s pattern=%d low=%d frames=%d\n", who, bad(), low, broken);
  return *who == 'c' ? 7 : 0;
}
