use std::fs;
use std::io::{self, BufRead};

fn names(path: &str) -> String {
    match fs::read_dir(path) {
        Ok(entries) => {
            let mut all: Vec<String> = entries
                .filter_map(|e| e.ok())
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect();
            all.sort();
            format!("[{}]", all.join(","))
        }
        Err(e) => format!("error {}", e.kind()),
    }
}

#[link(wasm_import_module = "slicc_fs")]
extern "C" {
    fn path_mkfifo(dirfd: i32, path: *const u8, len: usize, mode: u32) -> u16;
    fn path_copy_file(
        src_dirfd: i32,
        src: *const u8,
        src_len: usize,
        dst_dirfd: i32,
        dst: *const u8,
        dst_len: usize,
        mode: u32,
        flags: u32,
    ) -> u16;
}

const AT_FDCWD: i32 = -2;

fn at_cwd() {
    let fifo = "pipe";
    let src = "old";
    let dst = "copied";
    let made = unsafe { path_mkfifo(AT_FDCWD, fifo.as_ptr(), fifo.len(), 0o644) };
    let copied = unsafe {
        path_copy_file(AT_FDCWD, src.as_ptr(), src.len(), AT_FDCWD, dst.as_ptr(), dst.len(), 0o644, 0)
    };
    println!("mkfifo {} copy {}", made, copied);
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() > 1 && args[1] == "at" {
        println!("ready");
        let mut line = String::new();
        io::stdin().lock().read_line(&mut line).ok();
        at_cwd();
        return;
    }
    if args.len() > 2 && args[1] == "loop" {
        let n: usize = args[2].parse().unwrap_or(0);
        for _ in 0..n {
            fs::metadata("old").ok();
        }
        let mut line = String::new();
        io::stdin().lock().read_line(&mut line).ok();
        for _ in 0..n {
            fs::metadata("old").ok();
        }
        println!("looped {}", n);
        return;
    }
    println!("before {}", names("."));
    let mut line = String::new();
    io::stdin().lock().read_line(&mut line).ok();
    println!("after {}", names("."));
    match fs::File::create("made") {
        Ok(_) => println!("create ok"),
        Err(e) => println!("create {:?}", e.kind()),
    }
    match fs::metadata("x") {
        Ok(_) => println!("stat ok"),
        Err(e) => println!("stat {:?}", e.kind()),
    }
    println!("parent {}", names(".."));
}
