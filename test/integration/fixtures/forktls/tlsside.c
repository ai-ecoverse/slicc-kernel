__thread int side_tls = 30;

int side_tls_bump(void) { return ++side_tls; }
