use crate::git_command::{GitFailure, ReadOnlyGit, string_arg};
use std::{collections::HashMap, path::Path, sync::atomic::AtomicBool, time::Instant};

const COMMIT_LIMIT: usize = 512;
const PATCH_BYTES_LIMIT: usize = 8 * 1024 * 1024;
const PATCH_OPTIONS: &[&str] = &[
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    "--no-color",
    "--full-index",
    "--binary",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    "--diff-algorithm=myers",
    "--no-indent-heuristic",
    "--unified=3",
    "--ignore-submodules=none",
];

/// Compare captured tips only. Failure or exhausted limits are inconclusive, never a negative badge.
pub fn compare(
    git: &ReadOnlyGit,
    repository: &Path,
    base: &str,
    branch: &str,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Result<bool, GitFailure> {
    let comparison = Comparison {
        git,
        repository,
        cancelled,
        deadline,
    };
    let revisions = comparison.run(
        &[
            "rev-list",
            "--left-right",
            "--parents",
            &format!("--max-count={}", COMMIT_LIMIT + 1),
            &format!("{base}...{branch}"),
            "--",
        ],
        None,
        1024 * 1024,
    )?;
    let revisions = String::from_utf8_lossy(&revisions);
    if revisions.lines().count() > COMMIT_LIMIT {
        return Err(GitFailure::ResourceLimit);
    }
    let mut base_commits = Vec::new();
    let mut branch_commits = Vec::new();
    let mut branch_has_merge = false;
    for line in revisions.lines() {
        let mut fields = line.split_whitespace();
        let Some(marked_oid) = fields.next() else {
            continue;
        };
        let is_merge = fields.count() > 1;
        if let Some(oid) = marked_oid.strip_prefix('<') {
            if !is_merge {
                base_commits.push(oid);
            }
        } else if let Some(oid) = marked_oid.strip_prefix('>') {
            branch_commits.push(oid);
            branch_has_merge |= is_merge;
        }
    }
    if base_commits.is_empty() || branch_commits.is_empty() {
        return Ok(false);
    }
    let base_patches = comparison.commit_patches(&base_commits)?;
    let base_ids: std::collections::HashSet<_> = base_patches.values().collect();
    if base_ids.is_empty() {
        return Ok(false);
    }
    // A merge's resolution must not be silently omitted from the proof.
    if !branch_has_merge {
        let branch_patches = comparison.commit_patches(&branch_commits)?;
        if branch_commits.iter().all(|oid| {
            branch_patches
                .get(*oid)
                .is_some_and(|patch| base_ids.contains(patch))
        }) {
            return Ok(true);
        }
    }
    let fork = comparison.run(&["merge-base", "--all", base, branch], None, 4096)?;
    let fork = String::from_utf8_lossy(&fork);
    let mut forks = fork.split_whitespace();
    let Some(fork) = forks.next() else {
        return Ok(false);
    };
    if forks.next().is_some() {
        return Err(GitFailure::Unavailable(
            "Multiple merge bases; aggregate patch is ambiguous".into(),
        ));
    }
    let mut args = vec!["diff"];
    args.extend_from_slice(PATCH_OPTIONS);
    args.extend_from_slice(&[fork, branch, "--"]);
    let patch = comparison.run(&args, None, PATCH_BYTES_LIMIT)?;
    let aggregate = comparison.patch_ids(&patch)?;
    Ok(aggregate.values().any(|patch| base_ids.contains(patch)))
}

struct Comparison<'a> {
    git: &'a ReadOnlyGit,
    repository: &'a Path,
    cancelled: &'a AtomicBool,
    deadline: Instant,
}

impl Comparison<'_> {
    fn run(
        &self,
        args: &[&str],
        input: Option<&[u8]>,
        limit: usize,
    ) -> Result<Vec<u8>, GitFailure> {
        let output = self.git.run(
            self.repository,
            &args.iter().map(|arg| string_arg(*arg)).collect::<Vec<_>>(),
            input,
            limit,
            self.cancelled,
            self.deadline,
        )?;
        if !output.status.success() {
            return Err(GitFailure::CommandFailed(
                String::from_utf8_lossy(&output.stderr).into_owned(),
            ));
        }
        Ok(output.stdout)
    }

    fn commit_patches(&self, commits: &[&str]) -> Result<HashMap<String, String>, GitFailure> {
        let mut args = vec!["diff-tree", "--stdin", "--root", "-p"];
        args.extend_from_slice(PATCH_OPTIONS);
        let input = commits.join("\n") + "\n";
        let patches = self.run(&args, Some(input.as_bytes()), PATCH_BYTES_LIMIT)?;
        self.patch_ids(&patches)
    }

    fn patch_ids(&self, patches: &[u8]) -> Result<HashMap<String, String>, GitFailure> {
        let output = self.run(
            &["-c", "patchid.verbatim=false", "patch-id", "--stable"],
            Some(patches),
            (COMMIT_LIMIT + 1) * 132,
        )?;
        Ok(String::from_utf8_lossy(&output)
            .lines()
            .filter_map(|line| {
                let mut fields = line.split_whitespace();
                let patch = fields.next()?;
                let commit = fields.next()?;
                Some((commit.to_owned(), patch.to_owned()))
            })
            .collect())
    }
}
