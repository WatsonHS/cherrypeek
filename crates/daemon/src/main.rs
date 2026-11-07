mod framing;
mod git_command;
mod history;
mod navigation;
mod repository;
mod runtime;
mod server;
mod session;
mod session_store;

fn main() {
    if let Err(error) = server::run() {
        eprintln!("commitscope-daemon: {error}");
    }
}
