int side_count = 40;
int side_inits;

__attribute__((constructor)) static void side_init(void) { side_inits++; }

int side_add(int a, int b) { return a + b + side_count; }

int side_bump(void) { return ++side_count; }
