(module
  (import "wasi_snapshot_preview1" "fd_write" (func $fd_write (param i32 i32 i32 i32) (result i32)))
  (memory (export "memory") 1)
  (data (i32.const 16) "spinning\n")
  (func (export "_start")
    (i32.store (i32.const 0) (i32.const 16))
    (i32.store (i32.const 4) (i32.const 9))
    (try
      (do (drop (call $fd_write (i32.const 1) (i32.const 0) (i32.const 1) (i32.const 32))))
      (catch_all))
    (i32.store (i32.const 4) (i32.const 0))
    (loop $again
      (try
        (do (drop (call $fd_write (i32.const 2) (i32.const 0) (i32.const 1) (i32.const 32))))
        (catch_all))
      (br $again))))
