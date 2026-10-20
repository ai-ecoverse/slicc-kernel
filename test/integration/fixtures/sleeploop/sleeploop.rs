use std::time::{Duration, Instant};

fn main() {
    let rounds: u32 = std::env::args().nth(1).and_then(|a| a.parse().ok()).unwrap_or(40);
    let me = std::fs::read_link("/proc/self").map(|p| p.display().to_string()).unwrap_or_default();
    std::fs::write("/tmp/sleeploop.ready", me).unwrap();
    let start = Instant::now();
    for _ in 0..rounds {
        std::thread::sleep(Duration::from_millis(25));
    }
    println!("slept {} rounds in {} ms", rounds, start.elapsed().as_millis());
}
