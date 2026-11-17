use crate::GitPath;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GetBranchSyncParams {
    pub ref_names: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RefTarget {
    pub ref_name: String,
    pub oid: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum BranchSyncState {
    UpToDate,
    Behind,
    Ahead,
    Diverged,
    NoUpstream,
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BranchSync {
    pub ref_name: String,
    pub oid: String,
    pub upstream: Option<RefTarget>,
    pub ahead: Option<u64>,
    pub behind: Option<u64>,
    pub state: BranchSyncState,
    pub checked_out_by: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BranchSyncResult {
    pub branches: Vec<BranchSync>,
    pub last_fetch_unix_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged, deny_unknown_fields)]
pub enum SwitchTarget {
    Local {
        #[serde(rename = "refName")]
        ref_name: String,
    },
    Remote {
        #[serde(rename = "remoteRefName")]
        remote_ref_name: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PushRepositoryParams {
    pub ref_name: String,
    pub expected_oid: String,
    #[serde(deserialize_with = "crate::deserialize_required_nullable")]
    #[schemars(required)]
    #[schemars(with = "crate::NullableStringSchema")]
    pub remote: Option<String>,
    pub set_upstream: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "outcome",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum PushResult {
    Rejected {
        blockers: Vec<OperationBlocker>,
    },
    Done {
        remote: String,
        ref_name: String,
        remote_ref_name: String,
        new_oid: String,
        set_upstream: bool,
        finished_at_unix_ms: u64,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum RepositoryOperation {
    FastForward {
        ref_name: String,
        expected_oid: String,
        upstream_oid: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        replace_untracked: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        discard_untracked: Option<String>,
    },
    Switch {
        target: SwitchTarget,
        expected_oid: String,
        expected_head_oid: String,
    },
    CreateBranch {
        name: String,
        start_oid: String,
        switch_after: bool,
        expected_head_oid: String,
    },
    DeleteBranch {
        ref_name: String,
        expected_oid: String,
        base_ref_name: String,
    },
    FastForwardMerge {
        target_ref: String,
        expected_target_oid: String,
        source_ref: String,
        expected_source_oid: String,
        switch_to_target: bool,
    },
    WorkspaceStage {
        paths_hex: Vec<String>,
        all: bool,
    },
    WorkspaceUnstage {
        paths_hex: Vec<String>,
        all: bool,
    },
    WorkspaceDiscard {
        path_hex: String,
        untracked: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        expected_head_oid: Option<String>,
    },
    WorkspaceCommit {
        message: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        expected_head_oid: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OperationParams {
    pub operation: RepositoryOperation,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OperationCommit {
    pub oid: String,
    pub summary: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DirtyOperationPath {
    pub path: GitPath,
    pub staged: bool,
    pub unstaged: bool,
    pub untracked: bool,
    pub replace: Option<UntrackedDifference>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UntrackedDifference {
    pub upstream_only_lines: Option<u32>,
    pub local_only_lines: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum OperationBlocker {
    Diverged {
        ahead: u64,
        behind: u64,
        local_commits: Vec<OperationCommit>,
        upstream_commits: Vec<OperationCommit>,
        local_commits_truncated: bool,
        upstream_commits_truncated: bool,
        overlap_paths: Vec<GitPath>,
        overlap_paths_truncated: bool,
    },
    Dirty {
        paths: Vec<DirtyOperationPath>,
        paths_truncated: bool,
        replace_token: Option<String>,
    },
    CheckedOutElsewhere {
        worktree_path: String,
    },
    InProgress {
        operation: String,
    },
    NoUpstream,
    NotFastForward,
    RefChanged,
    NameInvalid,
    NameExists,
    Bare,
    /// Unmerged index, sparse checkout or incomplete preflight; no operation is attempted.
    UnsafeState {
        message: String,
    },
    RemoteRejected {
        remote: String,
        message: String,
    },
    NotAncestorMerged {
        base_ref_name: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OperationCheck {
    pub allowed: bool,
    pub blockers: Vec<OperationBlocker>,
    pub preserved_dirty_count: u32,
    pub identical_untracked_count: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdatedRef {
    pub ref_name: String,
    pub old_oid: Option<String>,
    pub new_oid: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "outcome",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum OperationRun {
    Rejected {
        blockers: Vec<OperationBlocker>,
    },
    Done {
        head_oid: Option<String>,
        head_reference: Option<String>,
        updated_ref: Option<UpdatedRef>,
        untracked: Option<UntrackedOutcome>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        committed_oid: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UntrackedOutcome {
    pub identical_count: u32,
    pub backed_up_count: u32,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub discarded_count: u32,
    pub backup_dir: Option<String>,
}

fn is_zero(count: &u32) -> bool {
    *count == 0
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteInfo {
    pub name: String,
    pub web_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BranchUpstream {
    pub ref_name: String,
    pub upstream_ref_name: String,
}
