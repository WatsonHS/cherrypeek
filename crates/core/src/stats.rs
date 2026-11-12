use crate::{
    ActivityAuthor, ActivityDay, GitPath, MetadataIndexCoverage, OperationCommit, SearchIdentity,
    SearchQuery,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StatsRange {
    pub start_unix: i64,
    pub end_unix: i64,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum StatsBucket {
    TenMinutes,
    Hour,
    Day,
    Week,
    Month,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GetActivityOverviewParams {
    pub query: SearchQuery,
    pub range: StatsRange,
    pub bucket: StatsBucket,
}
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActivityTotals {
    pub commits: u64,
    pub active_days: u64,
    pub authors: u64,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActivityBucket {
    pub start_unix: i64,
    pub count: u64,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActivityRhythm {
    pub longest_streak_days: u64,
    pub longest_gap_days: u64,
    pub busiest_day: Option<ActivityDay>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommitTypeCount {
    pub prefix: String,
    pub count: u64,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BranchActivity {
    pub ref_name: String,
    pub count: u64,
    pub last_commit_unix: Option<i64>,
    pub complete: bool,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActivitySession {
    pub start_unix: i64,
    pub end_unix: i64,
    pub count: u64,
    pub authors: Vec<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActivityOverview {
    pub coverage: MetadataIndexCoverage,
    pub buckets: Vec<ActivityBucket>,
    pub totals: ActivityTotals,
    pub previous_totals: ActivityTotals,
    pub rhythm: ActivityRhythm,
    pub week_hour: Vec<Vec<u64>>,
    pub types: Vec<CommitTypeCount>,
    pub merge_count: u64,
    pub revert_count: u64,
    pub fixup_count: u64,
    pub authors: Vec<ActivityAuthor>,
    pub authors_truncated: bool,
    pub branches: Vec<BranchActivity>,
    pub branches_truncated: bool,
    pub sessions: Vec<ActivitySession>,
    pub sessions_truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GetChangeStatsParams {
    pub query: SearchQuery,
    pub range: StatsRange,
    pub bucket: StatsBucket,
    #[serde(default)]
    pub directory_prefix: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChangeTotals {
    pub additions: u64,
    pub deletions: u64,
    pub files_changed: u64,
    pub files_added: u64,
    pub files_deleted: u64,
    pub files_renamed: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExcludedChanges {
    pub lines: u64,
    pub lock_files: u64,
    pub merge_commits: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChangeBucket {
    pub start_unix: i64,
    pub additions: u64,
    pub deletions: u64,
    pub net_growth: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LargeCommit {
    pub oid: String,
    pub summary: String,
    pub author: SearchIdentity,
    pub additions: u64,
    pub deletions: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DirectoryChanges {
    pub path: GitPath,
    pub lines: u64,
    pub commits: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileChanges {
    pub path: GitPath,
    pub additions: u64,
    pub deletions: u64,
    pub commits: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuthorDirectoryCell {
    pub directory: GitPath,
    pub lines: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuthorDirectories {
    pub author: SearchIdentity,
    pub cells: Vec<AuthorDirectoryCell>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChangeKinds {
    pub code: u64,
    pub test: u64,
    pub docs: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtensionChanges {
    pub extension: String,
    pub additions: u64,
    pub deletions: u64,
    pub files_changed: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChangeSession {
    pub authors: Vec<String>,
    pub start_unix: i64,
    pub end_unix: i64,
    pub count: u64,
    pub additions: u64,
    pub deletions: u64,
    pub directories: Vec<GitPath>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChangeStats {
    pub coverage: MetadataIndexCoverage,
    pub totals: ChangeTotals,
    pub previous_totals: ChangeTotals,
    pub excluded: ExcludedChanges,
    pub buckets: Vec<ChangeBucket>,
    pub size_histogram: Vec<u64>,
    pub largest: Vec<LargeCommit>,
    pub directories: Vec<DirectoryChanges>,
    pub directories_truncated: bool,
    pub files: Vec<FileChanges>,
    pub files_truncated: bool,
    pub author_directories: Vec<AuthorDirectories>,
    pub author_directories_truncated: bool,
    pub kinds: ChangeKinds,
    pub extensions: Vec<ExtensionChanges>,
    pub extensions_truncated: bool,
    pub sessions: Vec<ChangeSession>,
    pub sessions_truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StatsExclusions {
    pub patterns: Vec<String>,
    pub defaults: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetStatsExclusionsParams {
    pub patterns: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChurnFile {
    pub path: GitPath,
    pub commits: u64,
    pub authors: u64,
    pub days: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FilePair {
    pub a: GitPath,
    pub b: GitPath,
    pub together: u64,
    pub share_of_a_per_mille: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SoloDirectory {
    pub path: GitPath,
    pub author: SearchIdentity,
    pub lines: u64,
    pub commits: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UntestedChanges {
    pub count: u64,
    pub total: u64,
    pub commits: Vec<LargeCommit>,
    pub commits_truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NotableStats {
    pub coverage: MetadataIndexCoverage,
    pub churn_files: Vec<ChurnFile>,
    pub churn_files_truncated: bool,
    pub pairs: Vec<FilePair>,
    pub pairs_truncated: bool,
    pub pair_commits_skipped: u64,
    pub solo_directories: Vec<SoloDirectory>,
    pub solo_directories_truncated: bool,
    pub untested: UntestedChanges,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GetStatsCommitsParams {
    pub query: SearchQuery,
    pub range: StatsRange,
    pub selection: StatsSelection,
    pub offset: u32,
    pub limit: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StatsCommitPage {
    pub coverage: MetadataIndexCoverage,
    pub total: u64,
    pub commits: Vec<OperationCommit>,
    pub next_offset: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum StatsSelection {
    File { path_hex: String },
    Directory { path_hex: String },
    Pair { a_hex: String, b_hex: String },
    Untested,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvolutionParams {
    pub commit: String,
    pub path_hex: String,
    pub range: Option<StatsRange>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvolutionSkipped {
    pub path: GitPath,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvolutionEstimate {
    pub files: u32,
    pub total_files: u32,
    pub lines: u64,
    pub bytes: u64,
    pub file_limit: u32,
    pub skipped: Vec<EvolutionSkipped>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvolutionAge {
    pub within7d: u64,
    pub within30d: u64,
    pub within90d: u64,
    pub within1y: u64,
    pub older: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvolutionOwner {
    pub author: SearchIdentity,
    pub lines: u64,
    pub commits: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SurvivalWeek {
    pub start_unix: i64,
    pub added: u64,
    pub kept: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SurvivalAuthor {
    pub author: SearchIdentity,
    pub added: u64,
    pub kept: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvolutionSurvival {
    pub coverage: MetadataIndexCoverage,
    pub weeks: Vec<SurvivalWeek>,
    pub by_author: Vec<SurvivalAuthor>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvolutionCovered {
    pub files: u32,
    pub lines: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvolutionResult {
    pub as_of_unix: i64,
    pub age: EvolutionAge,
    pub ownership: Vec<EvolutionOwner>,
    pub survival: EvolutionSurvival,
    pub covered: EvolutionCovered,
    pub skipped: Vec<EvolutionSkipped>,
    pub complete: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvolutionProgress {
    pub files_done: u32,
    pub files_total: u32,
    pub current_path: Option<GitPath>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvolutionChunk {
    pub progress: EvolutionProgress,
    pub result: EvolutionResult,
}
