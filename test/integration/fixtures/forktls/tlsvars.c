__thread int local_exec __attribute__((tls_model("local-exec"))) = 5;
__thread int global_dynamic __attribute__((tls_model("global-dynamic"))) = 5;
