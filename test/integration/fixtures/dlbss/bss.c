static char big[1 << 20];
__attribute__((visibility("default"))) int bss_sum(void) { int s = 0; for (int i = 0; i < (int)sizeof big; i++) s += big[i]; big[7] = 9; return s; }
