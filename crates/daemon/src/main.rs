mod blame;
mod details;
mod files;
mod framing;
mod git_command;
mod graph;
mod handoff;
mod history;
mod metadata_index;
mod navigation;
mod operations;
mod patch_equivalence;
mod repository;
mod runtime;
mod search;
mod server;
mod session;
mod session_store;
mod updates;
mod workspace;

fn main() {
    if let Err(error) = server::run() {
        eprintln!("commitscope-daemon: {error}");
    }
}
