mod framing;
mod git_command;
mod repository;
mod runtime;
mod server;

fn main() {
    if let Err(error) = server::run() {
        eprintln!("commitscope-daemon: {error}");
    }
}
