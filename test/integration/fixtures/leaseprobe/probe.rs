use std::env;
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::fd::FromRawFd;

#[link(wasm_import_module = "wasix_32v1")]
extern "C" {
    fn sock_open(domain: u32, ty: u32, proto: u32, fd: *mut u32) -> u32;
    fn sock_connect(fd: u32, addr: *const u8) -> u32;
}

fn connect() -> File {
    let mut fd = 0;
    let mut addr = [0u8; 20];
    addr[..8].copy_from_slice(&[1, 0, 0x06, 0x24, 127, 0, 0, 1]);
    unsafe {
        assert_eq!(sock_open(1, 1, 0, &mut fd), 0);
        assert_eq!(sock_connect(fd, addr.as_ptr()), 0);
        File::from_raw_fd(fd as i32)
    }
}

fn exchange(mut args: impl Iterator<Item = String>, reader: &mut BufReader<File>) {
    print!("[");
    let mut sep = "";
    for command in &mut args {
        let bytes = command.as_bytes();
        let mut frame = vec![0x81];
        if bytes.len() < 126 {
            frame.push(0x80 | bytes.len() as u8);
        } else {
            frame.push(0xfe);
            frame.extend_from_slice(&u16::try_from(bytes.len()).unwrap().to_be_bytes());
        }
        let mask = [1, 2, 3, 4];
        frame.extend(mask);
        frame.extend(bytes.iter().enumerate().map(|(i, b)| b ^ mask[i % 4]));
        reader.get_mut().write_all(&frame).unwrap();
        let mut head = [0; 2];
        reader.read_exact(&mut head).unwrap();
        assert_eq!(head[0], 0x81);
        let len = if head[1] == 126 {
            reader.read_exact(&mut head).unwrap();
            u16::from_be_bytes(head) as usize
        } else {
            head[1] as usize
        };
        let mut reply = vec![0; len];
        reader.read_exact(&mut reply).unwrap();
        print!("{sep}{}", String::from_utf8(reply).unwrap());
        sep = ",";
    }
    println!("]");
}

fn main() {
    let mut args = env::args().skip(1);
    let mode = args.next().unwrap();
    let url = env::var("SLICC_CDP_LEASE_URL").unwrap_or_default();
    if mode == "env" {
        println!("{url}\n{}", env::var("SLICC_CDP_URL").unwrap_or_default());
        return;
    }
    let path = args.next().unwrap();
    let (path, upgrade) = if mode == "get" {
        (path, "")
    } else {
        (format!("{}{}", url.strip_prefix("ws://127.0.0.1:9222").unwrap(), path),
         "Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n")
    };
    let mut fd = connect();
    write!(
        fd,
        "GET {path} HTTP/1.1\r\nHost: unrelated.example\r\n{upgrade}\r\n"
    )
    .unwrap();
    let mut reader = BufReader::new(fd);
    let mut line = String::new();
    reader.read_line(&mut line).unwrap();
    let status: u32 = line.split_whitespace().nth(1).unwrap().parse().unwrap();
    loop {
        line.clear();
        assert!(reader.read_line(&mut line).unwrap() > 0);
        if line == "\r\n" {
            break;
        }
    }
    if mode == "get" {
        let mut body = String::new();
        reader.read_to_string(&mut body).unwrap();
        print!("{status}\n{body}");
    } else if status == 101 {
        exchange(args, &mut reader);
    } else {
        println!("{{\"refused\":\"{status}\"}}");
    }
}
