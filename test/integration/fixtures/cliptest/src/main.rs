use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::os::fd::IntoRawFd;
use std::process::exit;

const DEVICE: &str = "/dev/clipboard";

extern "C" {
    fn close(fd: i32) -> i32;
}

fn fail(what: &str, err: io::Error) -> ! {
    eprintln!("cliptest: {what}: {err}");
    exit(1);
}

fn closed(file: File) -> io::Result<()> {
    let fd = file.into_raw_fd();
    if unsafe { close(fd) } == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let text = args.get(2).cloned().unwrap_or_default();
    match args.get(1).map(String::as_str) {
        Some("paste") => match fs::read_to_string(DEVICE) {
            Ok(got) => print!("{got}"),
            Err(err) => fail("read", err),
        },
        Some("write") => {
            if let Err(err) = fs::write(DEVICE, text) {
                fail("write", err);
            }
        }
        Some("copy") => {
            let mut file = File::create(DEVICE).unwrap_or_else(|e| fail("open", e));
            file.write_all(text.as_bytes()).unwrap_or_else(|e| fail("write", e));
            closed(file).unwrap_or_else(|e| fail("close", e));
        }
        Some("leak") => {
            let mut file = File::create(DEVICE).unwrap_or_else(|e| fail("open", e));
            file.write_all(text.as_bytes()).unwrap_or_else(|e| fail("write", e));
            std::mem::forget(file);
            exit(0);
        }
        Some("both") => {
            let mut file = OpenOptions::new()
                .read(true)
                .write(true)
                .open(DEVICE)
                .unwrap_or_else(|e| fail("open", e));
            let mut got = String::new();
            file.read_to_string(&mut got).unwrap_or_else(|e| fail("read", e));
            print!("{got}");
            if !text.is_empty() {
                file.write_all(text.as_bytes()).unwrap_or_else(|e| fail("write", e));
            }
            closed(file).unwrap_or_else(|e| fail("close", e));
        }
        Some("seek") => {
            let mut file = File::open(DEVICE).unwrap_or_else(|e| fail("open", e));
            match file.seek(SeekFrom::Start(1)) {
                Ok(at) => println!("seeked {at}"),
                Err(err) => println!("seek: {}", err.raw_os_error().unwrap_or(0)),
            }
        }
        _ => {
            eprintln!("usage: cliptest paste|write|copy|leak|both|seek [text]");
            exit(2);
        }
    }
}
