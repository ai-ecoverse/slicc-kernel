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

fn main() {
    let args: Vec<String> = std::env::args().collect();
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
