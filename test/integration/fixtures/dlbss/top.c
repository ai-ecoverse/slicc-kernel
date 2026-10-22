int bss_sum(void);
__attribute__((visibility("default"))) int top_check(void) { return bss_sum() == 0 ? 42 : -1; }
