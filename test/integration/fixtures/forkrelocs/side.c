static int sa = 1, sb = 2;
int *sp = &sa;

void side_move(void) { sp = &sb; }

int side_moved(void) { return sp == &sb; }
