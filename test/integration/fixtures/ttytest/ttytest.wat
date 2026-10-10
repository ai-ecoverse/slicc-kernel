(module
  (import "wasi_snapshot_preview1" "fd_write" (func $fd_write (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_read" (func $fd_read (param i32 i32 i32 i32) (result i32)))
  (import "slicc_tty" "tcgetattr" (func $tcgetattr (param i32 i32) (result i32)))
  (import "slicc_tty" "tcsetattr" (func $tcsetattr (param i32 i32 i32) (result i32)))
  (import "slicc_tty" "winsize" (func $winsize (param i32 i32) (result i32)))
  (import "wasix_32v1" "tty_get" (func $tty_get (param i32) (result i32)))
  (memory (export "memory") 1)
  (data (i32.const 100) "RAW\n")
  (data (i32.const 120) "0123456789abcdef")

  ;; saved 1024, raw 1100, readback 1200, winsize 1300, tty_get 1400, scratch 1500,
  ;; restored 1600, byte 1700, record 1800 (13 bytes), hex line 1900, iov 2000, count 2010

  (func $out (param $ptr i32) (param $len i32)
    (i32.store (i32.const 2000) (local.get $ptr))
    (i32.store (i32.const 2004) (local.get $len))
    (drop (call $fd_write (i32.const 1) (i32.const 2000) (i32.const 1) (i32.const 2010))))

  (func $rec (param $at i32) (param $value i32)
    (i32.store8 (i32.add (i32.const 1800) (local.get $at)) (local.get $value)))

  (func $raw
    (memory.copy (i32.const 1100) (i32.const 1024) (i32.const 60))
    ;; cfmakeraw, as musl does it
    (i32.store (i32.const 1100) (i32.and (i32.load (i32.const 1100)) (i32.const -1516)))
    (i32.store (i32.const 1104) (i32.and (i32.load (i32.const 1104)) (i32.const -2)))
    (i32.store (i32.const 1112) (i32.and (i32.load (i32.const 1112)) (i32.const -32844)))
    (i32.store (i32.const 1108)
      (i32.or (i32.and (i32.load (i32.const 1108)) (i32.const -305)) (i32.const 48)))
    (i32.store8 (i32.const 1123) (i32.const 1))
    (i32.store8 (i32.const 1122) (i32.const 0)))

  (func $terminal
    (call $raw)
    (call $rec (i32.const 1) (call $tcsetattr (i32.const 0) (i32.const 0) (i32.const 1100)))
    (call $rec (i32.const 2) (call $tcgetattr (i32.const 0) (i32.const 1200)))
    ;; 1 when ISIG, ICANON, ECHO and OPOST all read back cleared and VMIN is 1
    (call $rec (i32.const 3)
      (i32.and
        (i32.eqz (i32.and (i32.load (i32.const 1212)) (i32.const 11)))
        (i32.and
          (i32.eqz (i32.and (i32.load (i32.const 1204)) (i32.const 1)))
          (i32.eq (i32.load8_u (i32.const 1223)) (i32.const 1)))))
    (call $out (i32.const 100) (i32.const 4))
    (i32.store (i32.const 2000) (i32.const 1700))
    (i32.store (i32.const 2004) (i32.const 1))
    (drop (call $fd_read (i32.const 0) (i32.const 2000) (i32.const 1) (i32.const 2010)))
    (call $rec (i32.const 4) (i32.load8_u (i32.const 1700)))
    (call $rec (i32.const 5) (call $tcsetattr (i32.const 0) (i32.const 2) (i32.const 1024)))
    (drop (call $tcgetattr (i32.const 0) (i32.const 1600)))
    ;; 1 when the restored termios has ISIG back
    (call $rec (i32.const 6) (i32.and (i32.load (i32.const 1612)) (i32.const 1)))
    (call $rec (i32.const 7) (call $tcsetattr (i32.const 0) (i32.const 9) (i32.const 1024))))

  (func (export "_start")
    (local $i i32)
    (local $b i32)
    (memory.fill (i32.const 1800) (i32.const 255) (i32.const 13))
    (call $rec (i32.const 0) (call $tcgetattr (i32.const 0) (i32.const 1024)))
    (if (i32.eqz (i32.load8_u (i32.const 1800))) (then (call $terminal)))
    (call $rec (i32.const 8) (call $winsize (i32.const 1) (i32.const 1300)))
    (call $rec (i32.const 9) (i32.load16_u (i32.const 1300)))
    (call $rec (i32.const 10) (i32.load16_u (i32.const 1302)))
    (call $rec (i32.const 11) (call $tty_get (i32.const 1400)))
    (call $rec (i32.const 12) (call $tcgetattr (i32.const 99) (i32.const 1500)))
    (i32.store8 (i32.const 1900) (i32.const 61))
    (block $done
      (loop $hex
        (br_if $done (i32.ge_u (local.get $i) (i32.const 13)))
        (local.set $b (i32.load8_u (i32.add (i32.const 1800) (local.get $i))))
        (i32.store8 (i32.add (i32.const 1901) (i32.shl (local.get $i) (i32.const 1)))
          (i32.load8_u (i32.add (i32.const 120) (i32.shr_u (local.get $b) (i32.const 4)))))
        (i32.store8 (i32.add (i32.const 1902) (i32.shl (local.get $i) (i32.const 1)))
          (i32.load8_u (i32.add (i32.const 120) (i32.and (local.get $b) (i32.const 15)))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $hex)))
    (i32.store8 (i32.const 1927) (i32.const 10))
    (call $out (i32.const 1900) (i32.const 28))))
