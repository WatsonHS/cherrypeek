# CherryPeek

[中文](README.md) | English

A read-only desktop Git history browser for repositories that move fast — for example when coding agents commit many times a day. See at a glance how much was committed recently, by whom, what changed, and how branches relate, without touching your working tree.

> **Status: early preview (0.1).** macOS on Apple silicon only. The read-only browsing features are complete; long-running stability, Windows and Intel Macs are not covered yet. The name is a play on cherry-pick: peek at commits, change nothing. (Earlier documents call it CommitScope, and internal identifiers still use `commitscope`.)

## What it does

- **History** — a virtualized commit list with a branch graph, built for large repositories (tested with 100,000 commits and 1,000 refs). Pick any branch, tag or worktree as the scope; switching scope never checks anything out.
- **Commit details on one page** — full message and trailers, author and committer, parents, which branches contain the commit, a compact change summary, then every changed file with its diff (unified or side by side, changes only or the whole file).
- **Search** — message, author / committer, date, OID and path filters over a local index, with results that stay put while the index fills in. Locate any result in the full history and come back to the results.
- **Files** — browse the tree of any commit, a file's or a directory's history beside it, a change view that slides over the file, line-by-line blame, and a switcher through all files of a commit.
- **Workspace** — staged, unstaged, untracked and conflicted files of the current worktree, with their diffs.
- **Merged status** — branches merged into the default branch by reachability, or by patch content when they were squashed or rebased.
- **Navigation** — back / forward across pages (⌘[ / ⌘]), a ⌘K quick jump to commits, branches and worktrees, and one meaning per shortcut on every page (the full list is under the keyboard icon in the top bar).
- **Hand-off to an agent** — copy a ready-made prompt to review a commit, explain a merge or review everything since a point.

## Read-only

- This version only reads your repositories: it never checks out, stages, commits, merges, rebases or pushes, and browsing a branch does not switch your working tree.
- Repository contents are treated as untrusted text; the window is sandboxed.
- Caches and the search index live in `~/Library/Application Support/CherryPeek`, never inside your repositories. Delete that folder to remove everything the app stored.

## Install

1. Download `CherryPeek-<version>-arm64.dmg` from [Releases](../../releases) (the app is signed and notarized by Apple).
2. Open it and drag CherryPeek into Applications.

Requirements: a Mac with Apple silicon, macOS 12 or later, and Git (the system Git from the Xcode Command Line Tools is enough: `xcode-select --install`).

## Build from source

Requirements: Node.js (see `.node-version`), pnpm 10, a Rust toolchain (see `rust-toolchain.toml`) and Git.

```sh
pnpm install
pnpm dev                 # build and start the app
pnpm start               # start the last build
pnpm package:mac         # an unsigned .app / .dmg for this Mac, in release/
```

Signed releases are built with `pnpm release:mac`; see [docs/RELEASE.md](docs/RELEASE.md) (in Chinese).

The product, design and architecture documents in [docs/](docs/) are written in Chinese.

## License

[MIT](LICENSE). Third-party licenses are listed in [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md) and ship with the app.
