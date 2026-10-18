#include <fcntl.h>
#include <poll.h>
#include <setjmp.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/time.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

static sigjmp_buf sjb;
static jmp_buf jb;
static volatile int plain;
static volatile int count;
static volatile int usr1;

static void jump(int sig) {
  (void)sig;
  count++;
  if (plain) longjmp(jb, 1);
  siglongjmp(sjb, 1);
}

static void stay(int sig) {
  (void)sig;
  count++;
}

static void on_usr1(int sig) {
  (void)sig;
  usr1++;
  printf(" usr1");
}

static void on_term(int sig) {
  (void)sig;
  raise(SIGUSR1);
  printf("term-done");
}

static void catch_with(int sig, void (*fn)(int), int masked) {
  struct sigaction sa;
  memset(&sa, 0, sizeof sa);
  sa.sa_handler = fn;
  sigemptyset(&sa.sa_mask);
  if (masked) sigaddset(&sa.sa_mask, masked);
  sigaction(sig, &sa, NULL);
}

static void mask(void) {
  sigset_t m;
  sigprocmask(SIG_BLOCK, NULL, &m);
  printf("usr1=%d usr2=%d alrm=%d\n", sigismember(&m, SIGUSR1), sigismember(&m, SIGUSR2),
         sigismember(&m, SIGALRM));
}

static void after(int sig) {
  catch_with(sig, stay, 0);
  raise(sig);
  printf("again=%d\n", count);
}

static void arm(void) {
  struct itimerval it;
  memset(&it, 0, sizeof it);
  it.it_value.tv_usec = 200000;
  setitimer(ITIMER_REAL, &it, NULL);
}

static int blocking(const char *how) {
  int p[2];
  if (!strcmp(how, "sleep")) return sleep(5);
  if (!strcmp(how, "nanosleep")) {
    struct timespec ts = {5, 0};
    return nanosleep(&ts, NULL);
  }
  if (pipe(p) != 0) return -1;
  if (!strcmp(how, "read")) {
    char c;
    return (int)read(p[0], &c, 1);
  }
  if (!strcmp(how, "poll")) {
    struct pollfd pf = {p[0], POLLIN, 0};
    return poll(&pf, 1, 5000);
  }
  if (!strcmp(how, "flock")) {
    int fd = open("sigjmp.lock", O_RDWR | O_CREAT, 0644);
    return flock(fd, LOCK_EX);
  }
  return -1;
}

__attribute__((noinline)) static void term_mode(void) {
  catch_with(SIGUSR1, on_usr1, 0);
  catch_with(SIGTERM, on_term, SIGUSR1);
  raise(SIGTERM);
  printf("\n");
}

__attribute__((noinline)) static void raise_mode(int longjmp_out, const char *who) {
  plain = longjmp_out;
  catch_with(SIGUSR1, jump, SIGUSR2);
  if ((plain ? setjmp(jb) : sigsetjmp(sjb, 1)) == 0) {
    raise(SIGUSR1);
    printf("returned\n");
  } else {
    printf("%sjumped\n", who);
  }
  mask();
  if (plain) {
    sigset_t none;
    sigemptyset(&none);
    sigprocmask(SIG_SETMASK, &none, NULL);
  }
  after(SIGUSR1);
}

__attribute__((noinline)) static void blocking_mode(const char *mode) {
  catch_with(SIGALRM, jump, SIGUSR2);
  plain = mode[0] == 'l';
  if (plain) mode++;
  if ((plain ? setjmp(jb) : sigsetjmp(sjb, 1)) == 0) {
    arm();
    int r = blocking(mode);
    printf("returned %d\n", r);
  } else {
    printf("jumped %s\n", mode);
  }
  mask();
  if (plain) {
    sigset_t none;
    sigemptyset(&none);
    sigprocmask(SIG_SETMASK, &none, NULL);
  }
  arm();
  catch_with(SIGALRM, stay, 0);
  sleep(5);
  printf("again=%d\n", count);
}

__attribute__((noinline)) static void direct_mode(int save) {
  if (sigsetjmp(sjb, save) == 0) siglongjmp(sjb, 1);
  printf("direct jumped\n");
}

__attribute__((noinline)) static pid_t forked(void) { return fork(); }

static void hold(void) {
  int fd = open("sigjmp.lock", O_RDWR | O_CREAT, 0644);
  flock(fd, LOCK_EX);
  close(open("sigjmp.held", O_WRONLY | O_CREAT, 0644));
  printf("held\n");
  sleep(3);
}

int main(int argc, char **argv) {
  const char *mode = argc > 1 ? argv[1] : "raise";
  setvbuf(stdout, NULL, _IONBF, 0);
  if (!strcmp(mode, "term")) term_mode();
  else if (!strcmp(mode, "hold")) hold();
  else if (!strcmp(mode, "raise")) raise_mode(0, "");
  else if (!strcmp(mode, "longjmp")) raise_mode(1, "");
  else if (!strcmp(mode, "direct")) direct_mode(0);
  else if (!strcmp(mode, "directmask")) direct_mode(1);
  else if (!strcmp(mode, "fork")) {
    pid_t child = forked();
    if (child == 0) {
      raise_mode(0, "child ");
      _exit(0);
    }
    int status;
    waitpid(child, &status, 0);
    printf("child status %d\n", WEXITSTATUS(status));
  } else blocking_mode(mode);
  return 0;
}
