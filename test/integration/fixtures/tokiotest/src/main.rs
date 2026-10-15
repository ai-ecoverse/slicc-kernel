use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Notify;

async fn echo() -> String {
    let addr = ("127.0.0.1", 4701);
    let listener = TcpListener::bind(addr).await.expect("bind");
    let server = tokio::spawn(async move {
        let (mut s, _) = listener.accept().await.expect("accept");
        let mut buf = Vec::new();
        s.read_to_end(&mut buf).await.expect("server read");
        s.write_all(b"echo ").await.expect("server write");
        s.write_all(&buf).await.expect("server write");
    });
    let mut c = TcpStream::connect(addr).await.expect("connect");
    c.write_all(b"hello").await.expect("client write");
    c.shutdown().await.expect("shutdown");
    let mut out = String::new();
    c.read_to_string(&mut out).await.expect("client read");
    server.await.expect("server");
    out
}

async fn stdin_roundtrip() -> String {
    let addr = ("127.0.0.1", 4702);
    let listener = TcpListener::bind(addr).await.expect("bind");
    let server = tokio::spawn(async move {
        let (mut s, _) = listener.accept().await.expect("accept");
        let (mut r, mut w) = s.split();
        tokio::io::copy(&mut r, &mut w).await.expect("copy");
    });
    let mut c = TcpStream::connect(addr).await.expect("connect");
    let mut input = Vec::new();
    tokio::io::stdin().read_to_end(&mut input).await.expect("stdin");
    c.write_all(&input).await.expect("write");
    c.shutdown().await.expect("shutdown");
    let mut back = Vec::new();
    c.read_to_end(&mut back).await.expect("read");
    server.await.expect("server");
    let mut out = tokio::io::stdout();
    out.write_all(&back).await.expect("stdout");
    out.flush().await.expect("flush");
    String::new()
}

async fn sleep_timeout(ms: u64) -> String {
    let start = Instant::now();
    let r = tokio::time::timeout(Duration::from_millis(ms), std::future::pending::<()>()).await;
    let took = start.elapsed().as_millis() as u64;
    format!(
        "{} {}",
        if r.is_err() { "timed out" } else { "finished" },
        if took >= ms { "not early" } else { "early" }
    )
}

async fn wake() -> String {
    let notify = Arc::new(Notify::new());
    let n = notify.clone();
    let blocking = tokio::task::spawn_blocking(move || {
        std::thread::sleep(Duration::from_millis(100));
        n.notify_one();
        "blocking done"
    });
    notify.notified().await;
    format!("woken, {}", blocking.await.expect("join"))
}

fn nonblocking(s: TcpStream) -> TcpStream {
    let std = s.into_std().expect("into_std");
    std.set_nonblocking(true).expect("set_nonblocking");
    TcpStream::from_std(std).expect("from_std")
}

async fn backpressure() -> String {
    const SIZE: usize = 4 << 20;
    let addr = ("127.0.0.1", 4703);
    let listener = TcpListener::bind(addr).await.expect("bind");
    let server = tokio::spawn(async move {
        let (mut s, _) = listener.accept().await.expect("accept");
        tokio::time::sleep(Duration::from_millis(100)).await;
        let mut n = 0usize;
        let mut buf = vec![0u8; 65536];
        loop {
            let r = s.read(&mut buf).await.expect("read");
            if r == 0 {
                break;
            }
            n += r;
        }
        n
    });
    let mut c = nonblocking(TcpStream::connect(addr).await.expect("connect"));
    let data = vec![7u8; SIZE];
    c.write_all(&data).await.expect("write");
    c.shutdown().await.expect("shutdown");
    let got = server.await.expect("server");
    format!("sent {} received {}", SIZE, got)
}

async fn serve(port: u16) -> String {
    let listener = TcpListener::bind(("127.0.0.1", port)).await.expect("bind");
    let (mut s, _) = listener.accept().await.expect("accept");
    let mut buf = Vec::new();
    s.read_to_end(&mut buf).await.expect("read");
    let reply = String::from_utf8_lossy(&buf).to_uppercase();
    s.write_all(reply.as_bytes()).await.expect("write");
    format!("served {}", reply)
}

async fn client(port: u16) -> String {
    let mut tries = 0;
    let mut c = loop {
        match TcpStream::connect(("127.0.0.1", port)).await {
            Ok(c) => break c,
            Err(e) if tries < 100 => {
                tries += 1;
                let _ = e;
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            Err(e) => panic!("connect: {e}"),
        }
    };
    c.write_all(b"ping").await.expect("write");
    c.shutdown().await.expect("shutdown");
    let mut out = String::new();
    c.read_to_string(&mut out).await.expect("read");
    format!("client got {}", out)
}

async fn run(args: Vec<String>) -> String {
    let arg = |i: usize| args.get(i).map(String::as_str).unwrap_or("");
    match arg(1) {
        "echo" => echo().await,
        "stdin" => stdin_roundtrip().await,
        "sleep" => sleep_timeout(arg(2).parse().unwrap_or(50)).await,
        "wake" => wake().await,
        "backpressure" => backpressure().await,
        "serve" => serve(arg(2).parse().expect("port")).await,
        "client" => client(arg(2).parse().expect("port")).await,
        other => {
            eprintln!("usage: tokiotest [--multi] echo|stdin|sleep MS|wake|backpressure|serve PORT|client PORT ({other})");
            std::process::exit(2)
        }
    }
}

fn main() {
    let mut args: Vec<String> = std::env::args().collect();
    let multi = args.get(1).map(String::as_str) == Some("--multi");
    if multi {
        args.remove(1);
    }
    let rt = if multi {
        tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build()
    } else {
        tokio::runtime::Builder::new_current_thread().enable_all().build()
    }
    .expect("runtime");
    let out = rt.block_on(run(args));
    if !out.is_empty() {
        println!("{out}");
    }
}
