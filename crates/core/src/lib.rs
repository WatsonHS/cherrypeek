use schemars::{JsonSchema, Schema, SchemaGenerator, generate::SchemaSettings};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::borrow::Cow;

pub const PROTOCOL_VERSION: u32 = 1;

fn deserialize_protocol_version<'de, D>(deserializer: D) -> Result<u32, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let version = u32::deserialize(deserializer)?;
    if version == PROTOCOL_VERSION {
        Ok(version)
    } else {
        Err(serde::de::Error::custom("unsupported protocol version"))
    }
}

fn deserialize_required_nullable<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}

struct NullableStringSchema;

impl JsonSchema for NullableStringSchema {
    fn inline_schema() -> bool {
        true
    }

    fn schema_name() -> Cow<'static, str> {
        "NullableString".into()
    }

    fn json_schema(_generator: &mut SchemaGenerator) -> Schema {
        Schema::try_from(serde_json::json!({"type": ["string", "null"]}))
            .expect("valid nullable string schema")
    }
}

struct NullablePathHexSchema;

impl JsonSchema for NullablePathHexSchema {
    fn inline_schema() -> bool {
        true
    }

    fn schema_name() -> Cow<'static, str> {
        "NullablePathHex".into()
    }

    fn json_schema(_generator: &mut SchemaGenerator) -> Schema {
        Schema::try_from(serde_json::json!({
            "anyOf": [
                {"type": "string", "maxLength": 32768},
                {"type": "null"}
            ]
        }))
        .expect("valid nullable path hex schema")
    }
}

struct NullableOidSchema;

impl JsonSchema for NullableOidSchema {
    fn inline_schema() -> bool {
        true
    }

    fn schema_name() -> Cow<'static, str> {
        "NullableOid".into()
    }

    fn json_schema(_generator: &mut SchemaGenerator) -> Schema {
        Schema::try_from(serde_json::json!({
            "anyOf": [
                {"type": "string", "maxLength": 64},
                {"type": "null"}
            ]
        }))
        .expect("valid nullable object ID schema")
    }
}

struct NullableMetadataIndexFailureSchema;

impl JsonSchema for NullableMetadataIndexFailureSchema {
    fn inline_schema() -> bool {
        true
    }

    fn schema_name() -> Cow<'static, str> {
        "NullableMetadataIndexFailure".into()
    }

    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        let failure = generator.subschema_for::<MetadataIndexFailure>();
        Schema::try_from(serde_json::json!({"anyOf":[failure, {"type":"null"}]}))
            .expect("valid nullable metadata index failure schema")
    }
}

struct NullableTimestampSchema;

impl JsonSchema for NullableTimestampSchema {
    fn inline_schema() -> bool {
        true
    }

    fn schema_name() -> Cow<'static, str> {
        "NullableTimestamp".into()
    }

    fn json_schema(_generator: &mut SchemaGenerator) -> Schema {
        Schema::try_from(serde_json::json!({"anyOf":[{"type":"integer"},{"type":"null"}]}))
            .expect("valid nullable timestamp schema")
    }
}

struct NullableSearchPathFilterSchema;

impl JsonSchema for NullableSearchPathFilterSchema {
    fn inline_schema() -> bool {
        true
    }

    fn schema_name() -> Cow<'static, str> {
        "NullableSearchPathFilter".into()
    }

    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        let path_filter = generator.subschema_for::<SearchPathFilter>();
        Schema::try_from(serde_json::json!({
            "anyOf": [path_filter, {"type":"null"}]
        }))
        .expect("valid nullable search path filter schema")
    }
}

struct NullableBooleanSchema;

impl JsonSchema for NullableBooleanSchema {
    fn inline_schema() -> bool {
        true
    }

    fn schema_name() -> Cow<'static, str> {
        "NullableBoolean".into()
    }

    fn json_schema(_generator: &mut SchemaGenerator) -> Schema {
        Schema::try_from(serde_json::json!({"type":["boolean","null"]}))
            .expect("valid nullable boolean schema")
    }
}

struct NullableGitPathSchema;

impl JsonSchema for NullableGitPathSchema {
    fn inline_schema() -> bool {
        true
    }

    fn schema_name() -> Cow<'static, str> {
        "NullableGitPath".into()
    }

    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        let path = generator.subschema_for::<GitPath>();
        Schema::try_from(serde_json::json!({"anyOf":[path, {"type":"null"}]}))
            .expect("valid nullable Git path schema")
    }
}

struct NullableNonnegativeIntegerSchema;

impl JsonSchema for NullableNonnegativeIntegerSchema {
    fn inline_schema() -> bool {
        true
    }

    fn schema_name() -> Cow<'static, str> {
        "NullableNonnegativeInteger".into()
    }

    fn json_schema(_generator: &mut SchemaGenerator) -> Schema {
        Schema::try_from(serde_json::json!({
            "anyOf":[{"type":"integer", "minimum":0}, {"type":"null"}]
        }))
        .expect("valid nullable nonnegative integer schema")
    }
}

struct NullableParentIndexSchema;

impl JsonSchema for NullableParentIndexSchema {
    fn inline_schema() -> bool {
        true
    }

    fn schema_name() -> Cow<'static, str> {
        "NullableParentIndex".into()
    }

    fn json_schema(_generator: &mut SchemaGenerator) -> Schema {
        Schema::try_from(serde_json::json!({
            "anyOf":[{"type":"integer", "minimum":0, "maximum":127}, {"type":"null"}]
        }))
        .expect("valid nullable parent index schema")
    }
}

struct NullableSchema<T>(std::marker::PhantomData<T>);

impl<T: JsonSchema> JsonSchema for NullableSchema<T> {
    fn inline_schema() -> bool {
        true
    }

    fn schema_name() -> Cow<'static, str> {
        format!("Nullable{}", T::schema_name()).into()
    }

    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        let value_schema = generator.subschema_for::<T>();
        let value_schema = serde_json::to_value(value_schema).expect("nullable schema serializes");
        Schema::try_from(serde_json::json!({
            "anyOf": [value_schema, {"type": "null"}]
        }))
        .expect("valid nullable schema")
    }
}

struct NullableCommitUpdateReasonSchema;

impl JsonSchema for NullableCommitUpdateReasonSchema {
    fn inline_schema() -> bool {
        true
    }

    fn schema_name() -> Cow<'static, str> {
        "NullableCommitUpdateReason".into()
    }

    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        let reason = generator.subschema_for::<CommitUpdateReason>();
        Schema::try_from(serde_json::json!({"anyOf":[reason, {"type":"null"}]}))
            .expect("valid nullable commit update reason schema")
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "GitInfo")]
pub struct GitInfo {
    pub available: bool,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    #[schemars(required)]
    #[schemars(with = "NullableStringSchema")]
    #[schemars(length(max = 4096))]
    pub version: Option<String>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    #[schemars(required)]
    #[schemars(with = "NullableStringSchema")]
    #[schemars(length(max = 4096))]
    pub error: Option<String>,
}

impl GitInfo {
    pub fn unavailable(message: impl Into<String>) -> Self {
        Self {
            available: false,
            version: None,
            error: Some(message.into()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum Capability {
    GetRuntimeInfo,
    ReadRepositoryPreview,
    RepositorySessions,
    HistoryPagination,
    HistoryNewSinceLastSeen,
    RepositoryScopes,
    MetadataIndex,
    MetadataSearch,
    HistoryGraph,
    CommitDetails,
    ActivityStats,
    RepositoryObservation,
    HandoffFacts,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "CoreReady")]
pub struct CoreReady {
    #[serde(deserialize_with = "deserialize_protocol_version")]
    #[schemars(range(min = 1, max = 1))]
    pub protocol_version: u32,
    pub core_version: String,
    pub pid: u32,
    pub git: GitInfo,
    pub capabilities: Vec<Capability>,
}

impl CoreReady {
    #[must_use]
    pub fn current_process(git: GitInfo) -> Self {
        Self {
            protocol_version: PROTOCOL_VERSION,
            core_version: env!("CARGO_PKG_VERSION").to_owned(),
            pid: std::process::id(),
            git,
            capabilities: vec![
                Capability::GetRuntimeInfo,
                Capability::ReadRepositoryPreview,
                Capability::RepositorySessions,
                Capability::HistoryPagination,
                Capability::HistoryNewSinceLastSeen,
                Capability::RepositoryScopes,
                Capability::MetadataIndex,
                Capability::MetadataSearch,
                Capability::HistoryGraph,
                Capability::CommitDetails,
                Capability::ActivityStats,
                Capability::RepositoryObservation,
                Capability::HandoffFacts,
            ],
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[serde(rename_all_fields = "camelCase")]
#[schemars(rename = "ClientMessage")]
#[serde(tag = "type")]
pub enum ClientMessage {
    #[serde(rename = "hello")]
    Hello { protocol_version: u32 },
    #[serde(rename = "request")]
    Request {
        #[schemars(length(min = 1, max = 128))]
        request_id: String,
        method: String,
        #[serde(deserialize_with = "deserialize_required_nullable")]
        #[schemars(required)]
        #[schemars(with = "NullableStringSchema")]
        #[schemars(length(min = 1, max = 256))]
        repo_id: Option<String>,
        #[serde(deserialize_with = "deserialize_required_nullable")]
        #[schemars(required)]
        #[schemars(with = "NullableStringSchema")]
        #[schemars(length(min = 1, max = 256))]
        generation: Option<String>,
        #[schemars(with = "RequestParams")]
        params: Value,
    },
    #[serde(rename = "cancel")]
    Cancel {
        #[schemars(length(min = 1, max = 128))]
        request_id: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
#[schemars(rename = "RequestParams")]
pub enum RequestParams {
    RuntimeInfo(EmptyParams),
    RepositoryPreview(ReadRepositoryPreviewParams),
    OpenRepository(OpenRepositoryParams),
    GetRepositorySession(EmptyParams),
    ReadSessionPreview(EmptyParams),
    ReadHistoryPage(ReadHistoryPageParams),
    LocateCommit(LocateCommitParams),
    RefreshRepository(RefreshRepositoryParams),
    GetRepositoryNavigation(EmptyParams),
    SelectRepositoryScope(SelectRepositoryScopeParams),
    RefMergeStatus(RefMergeStatusParams),
    GetMetadataIndexStatus(EmptyParams),
    ControlMetadataIndex(ControlMetadataIndexParams),
    SearchCommits(SearchCommitsParams),
    ListSearchIdentities(SearchIdentitiesParams),
    GetCommit(GetCommitParams),
    ListChangedFiles(ListChangedFilesParams),
    ReadMergeCommits(ReadMergeCommitsParams),
    BranchesContaining(BranchesContainingParams),
    ReadDiff(ReadDiffParams),
    ListSearchPaths(ListSearchPathsParams),
    GetActivityStats(GetActivityStatsParams),
    ObserveRepository(EmptyParams),
    DiffRefSnapshots(EmptyParams),
    GetHandoffFacts(GetHandoffFactsParams),
    RecordRepositoryView(EmptyParams),
    CloseRepository(EmptyParams),
    ListRecentRepositories(EmptyParams),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct EmptyParams {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReadRepositoryPreviewParams {
    #[schemars(length(min = 1, max = 16384))]
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OpenRepositoryParams {
    #[schemars(length(min = 1, max = 16384))]
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReadHistoryPageParams {
    #[serde(deserialize_with = "deserialize_required_nullable")]
    #[schemars(required)]
    #[schemars(with = "NullableStringSchema")]
    #[schemars(length(max = 512))]
    pub cursor: Option<String>,
    #[schemars(range(min = 1, max = 500))]
    pub page_size: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocateCommitParams {
    #[schemars(length(min = 40, max = 64))]
    pub oid: String,
    #[schemars(range(min = 1, max = 500))]
    pub page_size: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RefreshRepositoryParams {
    #[schemars(range(min = 1, max = 500))]
    pub page_size: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SelectRepositoryScopeParams {
    pub scope: RepositoryScope,
    #[schemars(range(min = 1, max = 500))]
    pub page_size: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RefMergeStatusParams {
    #[schemars(length(min = 1, max = 50))]
    pub ref_names: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum MetadataIndexAction {
    Pause,
    Resume,
    Cancel,
    Rebuild,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ControlMetadataIndexParams {
    pub action: MetadataIndexAction,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum MetadataIndexState {
    Idle,
    Queued,
    Running,
    Paused,
    Cancelled,
    Complete,
    QuotaLimited,
    Unavailable,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MetadataIndexCoverage {
    pub processed: u64,
    pub complete: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MetadataIndexFailure {
    pub code: ErrorCode,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MetadataIndexStatus {
    #[serde(deserialize_with = "deserialize_required_nullable")]
    #[schemars(required)]
    #[schemars(with = "NullableStringSchema")]
    pub snapshot_key: Option<String>,
    pub state: MetadataIndexState,
    pub coverage: MetadataIndexCoverage,
    pub disk_bytes: u64,
    pub quota_bytes: u64,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    #[schemars(required)]
    #[schemars(with = "NullableMetadataIndexFailureSchema")]
    pub error: Option<MetadataIndexFailure>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SearchIdentity {
    #[schemars(length(max = 4096))]
    pub name: String,
    #[schemars(length(max = 4096))]
    pub email: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum SearchTimeField {
    Author,
    Committer,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SearchQuery {
    #[schemars(length(max = 4096))]
    pub message: String,
    pub case_sensitive: bool,
    #[schemars(length(max = 50))]
    pub authors: Vec<SearchIdentity>,
    #[schemars(length(max = 50))]
    pub committers: Vec<SearchIdentity>,
    #[schemars(length(max = 64))]
    pub oid_prefix: String,
    pub time_field: SearchTimeField,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    #[schemars(required)]
    #[schemars(with = "NullableTimestampSchema")]
    pub from_timestamp: Option<i64>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    #[schemars(required)]
    #[schemars(with = "NullableTimestampSchema")]
    pub to_timestamp: Option<i64>,
    #[schemars(length(max = 128))]
    pub time_zone: String,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    #[schemars(required)]
    #[schemars(with = "NullableSearchPathFilterSchema")]
    pub path: Option<SearchPathFilter>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SearchPathFilter {
    #[schemars(length(max = 32768))]
    pub raw_hex: String,
    pub kind: SearchPathKind,
    pub include_descendants: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum SearchPathKind {
    File,
    Directory,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListSearchPathsParams {
    #[schemars(length(max = 32768))]
    pub text: String,
    #[schemars(range(min = 1, max = 100))]
    pub limit: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GetActivityStatsParams {
    pub query: SearchQuery,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActivityDay {
    #[schemars(length(min = 10, max = 10))]
    pub day: String,
    pub count: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActivityAuthor {
    #[schemars(length(max = 4096))]
    pub name: String,
    #[schemars(length(max = 4096))]
    pub email: String,
    pub count: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActivityStats {
    #[schemars(length(min = 1, max = 128))]
    pub query_key: String,
    pub coverage: MetadataIndexCoverage,
    pub index: MetadataIndexStatus,
    pub matched_count: u64,
    pub time_field: SearchTimeField,
    #[schemars(length(min = 1, max = 128))]
    pub time_zone: String,
    #[schemars(length(max = 3660))]
    pub days: Vec<ActivityDay>,
    pub days_truncated: bool,
    #[schemars(length(max = 500))]
    pub authors: Vec<ActivityAuthor>,
    pub authors_truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RepositoryObservation {
    #[schemars(length(min = 1, max = 256))]
    pub generation: String,
    pub observed_at_unix_ms: u64,
    pub changed_ref_count: u32,
    pub worktrees_changed: bool,
    pub change_count: u32,
    pub refs_truncated: bool,
    pub worktrees_truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum RefSnapshotChangeKind {
    FastForward,
    Rewritten,
    Created,
    Deleted,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RefSnapshotChange {
    #[schemars(length(min = 1, max = 16384))]
    pub name: String,
    pub kind: RefKind,
    pub change: RefSnapshotChangeKind,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    #[schemars(required)]
    #[schemars(with = "NullableOidSchema")]
    pub old_oid: Option<String>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    #[schemars(required)]
    #[schemars(with = "NullableOidSchema")]
    pub new_oid: Option<String>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    #[schemars(required)]
    #[schemars(with = "NullableNonnegativeIntegerSchema")]
    pub added_count: Option<u64>,
    #[schemars(length(max = 20))]
    pub added_commits: Vec<CommitSummary>,
    pub added_commits_truncated: bool,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    #[schemars(required)]
    #[schemars(with = "NullableNonnegativeIntegerSchema")]
    pub replaced_count: Option<u64>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    #[schemars(required)]
    #[schemars(with = "NullableSchema<MergeStatus>")]
    pub deleted_merge_status: Option<MergeStatus>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RefSnapshotDiff {
    #[schemars(length(min = 1, max = 256))]
    pub from_generation: String,
    #[schemars(length(min = 1, max = 256))]
    pub to_generation: String,
    pub observed_at_unix_ms: u64,
    #[schemars(length(max = 2000))]
    pub changes: Vec<RefSnapshotChange>,
    pub truncated: bool,
    pub complete: bool,
    pub worktrees_changed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GetHandoffFactsParams {
    #[serde(deserialize_with = "deserialize_required_nullable")]
    #[schemars(required)]
    #[schemars(with = "NullableStringSchema")]
    #[schemars(length(max = 16384))]
    pub branch_ref: Option<String>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    #[schemars(required)]
    #[schemars(with = "NullableOidSchema")]
    pub selected_oid: Option<String>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    #[schemars(required)]
    #[schemars(with = "NullableStringSchema")]
    #[schemars(length(max = 256))]
    pub operation_worktree_id: Option<String>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    #[schemars(required)]
    #[schemars(with = "NullableStringSchema")]
    #[schemars(length(max = 256))]
    pub stale_worktree_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HandoffParentGroup {
    pub parent_index: u16,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    #[schemars(required)]
    #[schemars(with = "NullableNonnegativeIntegerSchema")]
    pub total_count: Option<u64>,
    #[schemars(length(max = 50))]
    pub commits: Vec<CommitSummary>,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HandoffFacts {
    pub observed_at_unix_ms: u64,
    pub repository: RepositoryInfo,
    pub scope: RepositoryScope,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    #[schemars(required)]
    #[schemars(with = "NullableSchema<WorktreeInfo>")]
    pub window_worktree: Option<WorktreeInfo>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    #[schemars(required)]
    #[schemars(with = "NullableSchema<RefInfo>")]
    pub branch: Option<RefInfo>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    #[schemars(required)]
    #[schemars(with = "NullableDefaultBaseSchema")]
    pub base: Option<DefaultBase>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    #[schemars(required)]
    #[schemars(with = "NullableSchema<WorktreeInfo>")]
    pub operation_worktree: Option<WorktreeInfo>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    #[schemars(required)]
    #[schemars(with = "NullableSchema<CommitSummary>")]
    pub selected_commit: Option<CommitSummary>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    #[schemars(required)]
    #[schemars(with = "NullableNonnegativeIntegerSchema")]
    pub ahead: Option<u64>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    #[schemars(required)]
    #[schemars(with = "NullableNonnegativeIntegerSchema")]
    pub behind: Option<u64>,
    #[schemars(length(max = 20))]
    pub overlap_paths: Vec<GitPath>,
    pub overlap_complete: bool,
    pub overlap_truncated: bool,
    #[schemars(length(max = 50))]
    pub branch_commits: Vec<CommitSummary>,
    pub branch_commits_truncated: bool,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    #[schemars(required)]
    #[schemars(with = "NullableNonnegativeIntegerSchema")]
    pub branch_commits_count: Option<u64>,
    #[schemars(length(max = 50))]
    pub changed_files: Vec<ChangedFile>,
    pub changed_files_truncated: bool,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    #[schemars(required)]
    #[schemars(with = "NullableNonnegativeIntegerSchema")]
    pub changed_files_count: Option<u64>,
    #[schemars(length(max = 127))]
    pub merge_parent_groups: Vec<HandoffParentGroup>,
    pub merge_parent_groups_truncated: bool,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    #[schemars(required)]
    #[schemars(with = "NullableSchema<MergeStatus>")]
    pub merge_status: Option<MergeStatus>,
    #[schemars(length(max = 128))]
    pub checked_out_by: Vec<WorktreeInfo>,
    pub checked_out_by_complete: bool,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    #[schemars(required)]
    #[schemars(with = "NullableSchema<WorktreeInfo>")]
    pub stale_worktree: Option<WorktreeInfo>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SearchPathEntry {
    pub path: GitPath,
    pub kind: SearchPathKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SearchPaths {
    #[schemars(length(max = 100))]
    pub entries: Vec<SearchPathEntry>,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SearchCommitsParams {
    pub query: SearchQuery,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    #[schemars(required)]
    #[schemars(with = "NullableStringSchema")]
    #[schemars(length(max = 1024))]
    pub cursor: Option<String>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    #[schemars(required)]
    #[schemars(with = "NullableStringSchema")]
    #[schemars(length(max = 64))]
    pub anchor_oid: Option<String>,
    #[schemars(range(min = 1, max = 500))]
    pub page_size: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SearchPage {
    #[schemars(length(min = 1, max = 128))]
    pub query_key: String,
    #[schemars(length(min = 1, max = 128))]
    pub snapshot_key: String,
    #[schemars(length(min = 1, max = 512))]
    pub result_version: String,
    #[schemars(length(max = 500))]
    pub commits: Vec<CommitSummary>,
    pub page_offset: u64,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    #[schemars(required)]
    #[schemars(with = "NullableStringSchema")]
    #[schemars(length(max = 1024))]
    pub previous_cursor: Option<String>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    #[schemars(required)]
    #[schemars(with = "NullableStringSchema")]
    #[schemars(length(max = 1024))]
    pub next_cursor: Option<String>,
    pub matched_count: u64,
    pub coverage: MetadataIndexCoverage,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    #[schemars(required)]
    #[schemars(with = "NullableBooleanSchema")]
    pub anchor_found: Option<bool>,
    pub index: MetadataIndexStatus,
    #[schemars(length(max = 500))]
    pub path_matches: Vec<SearchPathMatch>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SearchPathMatch {
    #[schemars(length(min = 40, max = 64))]
    pub oid: String,
    #[schemars(length(max = 128))]
    pub parent_indices: Vec<Option<u16>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SearchIdentitiesParams {
    pub field: SearchTimeField,
    #[schemars(length(max = 1024))]
    pub text: String,
    #[schemars(range(min = 1, max = 100))]
    pub limit: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GetCommitParams {
    #[schemars(length(min = 40, max = 64))]
    pub oid: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListChangedFilesParams {
    #[schemars(length(min = 40, max = 64))]
    pub oid: String,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    #[schemars(required)]
    #[schemars(with = "NullableParentIndexSchema")]
    pub parent_index: Option<u8>,
    pub offset: u32,
    #[schemars(range(min = 1, max = 200))]
    pub page_size: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReadMergeCommitsParams {
    #[schemars(length(min = 40, max = 64))]
    pub oid: String,
    #[schemars(range(min = 1, max = 127))]
    pub parent_index: u8,
    pub offset: u32,
    #[schemars(range(min = 1, max = 200))]
    pub page_size: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BranchesContainingParams {
    #[schemars(length(min = 40, max = 64))]
    pub oid: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReadDiffParams {
    #[schemars(length(min = 40, max = 64))]
    pub oid: String,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    #[schemars(required)]
    #[schemars(with = "NullableParentIndexSchema")]
    pub parent_index: Option<u8>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    #[schemars(required)]
    #[schemars(with = "NullablePathHexSchema")]
    pub old_path_hex: Option<String>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    #[schemars(required)]
    #[schemars(with = "NullablePathHexSchema")]
    pub new_path_hex: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Trailer {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum CommitUpdateState {
    Unaffected,
    Affected,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum CommitUpdateReason {
    ScopeUnavailable,
    NoLongerReachable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommitUpdate {
    pub state: CommitUpdateState,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    #[schemars(required)]
    #[schemars(with = "NullableCommitUpdateReasonSchema")]
    pub reason: Option<CommitUpdateReason>,
    pub checked_at_unix_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommitDetails {
    pub commit: CommitSummary,
    #[schemars(length(max = 1_048_576))]
    pub message: String,
    #[schemars(length(max = 1_048_576))]
    pub message_without_trailers: String,
    #[schemars(length(max = 4096))]
    pub trailers: Vec<Trailer>,
    #[schemars(length(max = 2000))]
    pub refs: Vec<RefInfo>,
    #[schemars(length(max = 128))]
    pub worktrees: Vec<WorktreeInfo>,
    pub observed_at_unix_ms: u64,
    pub refs_truncated: bool,
    pub worktrees_truncated: bool,
    pub update: CommitUpdate,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitPath {
    #[schemars(length(max = 16384))]
    pub display: String,
    #[schemars(length(max = 32768))]
    pub raw_hex: String,
    pub text_lossy: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ChangedFileStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
    Copied,
    TypeChanged,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChangedFile {
    pub status: ChangedFileStatus,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    #[schemars(required)]
    #[schemars(with = "NullableGitPathSchema")]
    pub old_path: Option<GitPath>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    #[schemars(required)]
    #[schemars(with = "NullableGitPathSchema")]
    pub new_path: Option<GitPath>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    #[schemars(required)]
    #[schemars(with = "NullableOidSchema")]
    pub old_oid: Option<String>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    #[schemars(required)]
    #[schemars(with = "NullableOidSchema")]
    pub new_oid: Option<String>,
    #[schemars(length(min = 6, max = 6))]
    pub old_mode: String,
    #[schemars(length(min = 6, max = 6))]
    pub new_mode: String,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    #[schemars(required)]
    #[schemars(with = "NullableU8Schema")]
    pub similarity: Option<u8>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    #[schemars(required)]
    #[schemars(with = "NullableNonnegativeIntegerSchema")]
    pub additions: Option<u64>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    #[schemars(required)]
    #[schemars(with = "NullableNonnegativeIntegerSchema")]
    pub deletions: Option<u64>,
    pub binary: bool,
    pub gitlink: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum FileDiffKind {
    Text,
    Binary,
    Gitlink,
    Lfs,
    TooLarge,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileDiff {
    #[schemars(length(min = 40, max = 64))]
    pub oid: String,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    #[schemars(required)]
    #[schemars(with = "NullableParentIndexSchema")]
    pub parent_index: Option<u8>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    #[schemars(required)]
    #[schemars(with = "NullableOidSchema")]
    pub parent_oid: Option<String>,
    pub file: ChangedFile,
    pub kind: FileDiffKind,
    #[schemars(length(max = 131072))]
    pub patch: String,
    pub truncated: bool,
    pub text_lossy: bool,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    #[schemars(required)]
    #[schemars(with = "NullableNonnegativeIntegerSchema")]
    pub old_size: Option<u64>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    #[schemars(required)]
    #[schemars(with = "NullableNonnegativeIntegerSchema")]
    pub new_size: Option<u64>,
}

struct NullableU8Schema;

impl JsonSchema for NullableU8Schema {
    fn inline_schema() -> bool {
        true
    }

    fn schema_name() -> Cow<'static, str> {
        "NullableU8".into()
    }

    fn json_schema(_generator: &mut SchemaGenerator) -> Schema {
        Schema::try_from(serde_json::json!({
            "anyOf":[{"type":"integer", "minimum":0, "maximum":100}, {"type":"null"}]
        }))
        .expect("valid nullable u8 schema")
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChangeCounts {
    pub added: u32,
    pub modified: u32,
    pub deleted: u32,
    pub renamed: u32,
    pub copied: u32,
    pub type_changed: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DirectoryChangeOverview {
    #[serde(deserialize_with = "deserialize_required_nullable")]
    #[schemars(required)]
    #[schemars(with = "NullableGitPathSchema")]
    pub path: Option<GitPath>,
    pub total_files: u32,
    pub additions: u64,
    pub deletions: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChangeOverview {
    pub total_files: u32,
    pub counts: ChangeCounts,
    pub additions: u64,
    pub deletions: u64,
    pub binary_files: u32,
    pub gitlink_files: u32,
    #[schemars(length(max = 20000))]
    pub directories: Vec<DirectoryChangeOverview>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChangedFilesPage {
    #[schemars(length(min = 40, max = 64))]
    pub oid: String,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    #[schemars(required)]
    #[schemars(with = "NullableParentIndexSchema")]
    pub parent_index: Option<u8>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    #[schemars(required)]
    #[schemars(with = "NullableOidSchema")]
    pub parent_oid: Option<String>,
    pub offset: u32,
    #[schemars(range(min = 1, max = 200))]
    pub page_size: u16,
    pub total_files: u32,
    pub has_more: bool,
    #[schemars(length(max = 200))]
    pub files: Vec<ChangedFile>,
    pub overview: ChangeOverview,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MergeCommitsPage {
    #[schemars(length(min = 40, max = 64))]
    pub oid: String,
    #[schemars(range(min = 1, max = 127))]
    pub parent_index: u8,
    #[schemars(length(min = 40, max = 64))]
    pub parent_oid: String,
    #[schemars(length(min = 40, max = 64))]
    pub first_parent_oid: String,
    pub offset: u32,
    #[schemars(range(min = 1, max = 200))]
    pub page_size: u16,
    pub total_commits: u32,
    pub has_more: bool,
    #[schemars(length(max = 200))]
    pub commits: Vec<CommitSummary>,
    #[schemars(length(max = 1000))]
    pub authors: Vec<MergeAuthorCount>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MergeAuthorCount {
    #[schemars(length(max = 4096))]
    pub name: String,
    #[schemars(length(max = 4096))]
    pub email: String,
    pub count: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BranchesContainingResult {
    #[schemars(length(min = 40, max = 64))]
    pub oid: String,
    #[schemars(length(max = 2000))]
    pub branches: Vec<RefInfo>,
    pub observed_at_unix_ms: u64,
    pub complete: bool,
    pub refs_truncated: bool,
    pub boundary_limited: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SearchIdentities {
    pub field: SearchTimeField,
    #[schemars(length(max = 100))]
    pub identities: Vec<SearchIdentity>,
    pub truncated: bool,
    pub coverage: MetadataIndexCoverage,
    pub index: MetadataIndexStatus,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[serde(rename_all_fields = "camelCase")]
#[schemars(rename = "ServerMessage")]
#[serde(tag = "type")]
#[allow(clippy::large_enum_variant)]
pub enum ServerMessage {
    #[serde(rename = "hello")]
    Hello { core: CoreReady },
    #[serde(rename = "response")]
    Response {
        #[schemars(length(min = 1, max = 128))]
        request_id: String,
        #[serde(deserialize_with = "deserialize_required_nullable")]
        #[schemars(required)]
        #[schemars(with = "NullableStringSchema")]
        #[schemars(length(min = 1, max = 256))]
        repo_id: Option<String>,
        #[serde(deserialize_with = "deserialize_required_nullable")]
        #[schemars(required)]
        #[schemars(with = "NullableStringSchema")]
        #[schemars(length(min = 1, max = 256))]
        generation: Option<String>,
        sequence: u32,
        done: bool,
        coverage: Coverage,
        #[serde(deserialize_with = "deserialize_required_nullable")]
        #[schemars(required)]
        #[schemars(with = "NullableStringSchema")]
        next_cursor: Option<String>,
        data: ResponseData,
    },
    #[serde(rename = "error")]
    Error {
        #[serde(deserialize_with = "deserialize_required_nullable")]
        #[schemars(required)]
        #[schemars(with = "NullableStringSchema")]
        #[schemars(length(min = 1, max = 128))]
        request_id: Option<String>,
        #[serde(deserialize_with = "deserialize_required_nullable")]
        #[schemars(required)]
        #[schemars(with = "NullableStringSchema")]
        #[schemars(length(min = 1, max = 256))]
        repo_id: Option<String>,
        #[serde(deserialize_with = "deserialize_required_nullable")]
        #[schemars(required)]
        #[schemars(with = "NullableStringSchema")]
        #[schemars(length(min = 1, max = 256))]
        generation: Option<String>,
        code: ErrorCode,
        message: String,
        retryable: bool,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Coverage {
    pub complete: bool,
    pub processed: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[serde(rename_all_fields = "camelCase")]
#[serde(tag = "section")]
pub enum ResponseData {
    #[serde(rename = "core")]
    Core { core_version: String, pid: u32 },
    #[serde(rename = "metadataIndex")]
    MetadataIndex { status: MetadataIndexStatus },
    #[serde(rename = "searchPage")]
    SearchPage { page: SearchPage },
    #[serde(rename = "searchIdentities")]
    SearchIdentities { result: SearchIdentities },
    #[serde(rename = "searchPaths")]
    SearchPaths { paths: SearchPaths },
    #[serde(rename = "activityStats")]
    ActivityStats { stats: ActivityStats },
    #[serde(rename = "repositoryObservation")]
    RepositoryObservation { observation: RepositoryObservation },
    #[serde(rename = "refSnapshotDiff")]
    RefSnapshotDiff { diff: RefSnapshotDiff },
    #[serde(rename = "handoffFacts")]
    HandoffFacts { facts: HandoffFacts },
    #[serde(rename = "commitDetails")]
    CommitDetails { details: CommitDetails },
    #[serde(rename = "changedFiles")]
    ChangedFiles { page: ChangedFilesPage },
    #[serde(rename = "mergeCommits")]
    MergeCommits { page: MergeCommitsPage },
    #[serde(rename = "branchesContaining")]
    BranchesContaining { result: BranchesContainingResult },
    #[serde(rename = "fileDiff")]
    FileDiff { diff: FileDiff },
    #[serde(rename = "git")]
    Git { git: GitInfo },
    #[serde(rename = "repository")]
    Repository {
        repository: RepositoryInfo,
        refs: Vec<RefInfo>,
        refs_truncated: bool,
    },
    #[serde(rename = "commits")]
    Commits {
        commits: Vec<CommitSummary>,
        has_more: bool,
    },
    #[serde(rename = "repositorySession")]
    RepositorySession { session: RepositorySessionInfo },
    #[serde(rename = "repositoryViewRecorded")]
    RepositoryViewRecorded { saved: bool, status: StoreStatus },
    #[serde(rename = "repositoryClosed")]
    RepositoryClosed { closed: bool },
    #[serde(rename = "recentRepositories")]
    RecentRepositories {
        repositories: Vec<RecentRepository>,
        status: StoreStatus,
    },
    #[serde(rename = "historyPage")]
    HistoryPage {
        #[schemars(length(max = 500))]
        commits: Vec<HistoryCommit>,
        offset: u32,
        #[schemars(range(min = 1, max = 500))]
        page_size: u16,
        #[schemars(length(min = 1, max = 512))]
        cursor: String,
        #[serde(deserialize_with = "deserialize_required_nullable")]
        #[schemars(required)]
        #[schemars(with = "NullableStringSchema")]
        previous_cursor: Option<String>,
        has_more: bool,
        new_since_last_seen_status: NewSinceLastSeenStatus,
        #[serde(deserialize_with = "deserialize_required_nullable")]
        #[schemars(required)]
        #[schemars(with = "NullableOidSchema")]
        last_seen_divider_oid: Option<String>,
    },
    #[serde(rename = "repositoryNavigation")]
    RepositoryNavigation { navigation: RepositoryNavigation },
    #[serde(rename = "refMergeStatus")]
    RefMergeStatus { result: RefMergeStatusResult },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoryCommit {
    #[serde(flatten)]
    #[schemars(flatten)]
    pub commit: CommitSummary,
    pub is_new_since_last_seen: bool,
    pub graph: HistoryGraph,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoryGraph {
    #[schemars(range(max = 16383))]
    pub lane: u16,
    #[schemars(range(max = 5))]
    pub color: u8,
    #[schemars(length(max = 128))]
    pub parents: Vec<String>,
    pub boundary: bool,
    #[schemars(range(max = 63))]
    pub above: u8,
    #[schemars(range(max = 63))]
    pub below: u8,
    #[schemars(range(max = 16384))]
    pub hidden_lane_count: u16,
    #[schemars(length(max = 8192))]
    pub hidden_through_ranges: Vec<HistoryGraphLaneRange>,
    #[schemars(length(max = 256))]
    pub segments: Vec<HistoryGraphSegment>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoryGraphLaneRange {
    #[schemars(range(min = 6, max = 16383))]
    pub start_lane: u16,
    #[schemars(range(min = 6, max = 16383))]
    pub end_lane: u16,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum HistoryGraphSegmentKind {
    Through,
    Incoming,
    Outgoing,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoryGraphSegment {
    #[schemars(range(max = 16383))]
    pub from_lane: u16,
    #[schemars(range(max = 16383))]
    pub to_lane: u16,
    #[schemars(range(max = 5))]
    pub color: u8,
    pub kind: HistoryGraphSegmentKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum NewSinceLastSeenStatus {
    Ready,
    FirstView,
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RepositorySessionInfo {
    #[schemars(length(min = 1, max = 256))]
    pub repo_id: String,
    #[schemars(length(min = 1, max = 256))]
    pub generation: String,
    #[schemars(length(min = 1, max = 128))]
    pub repository_key: String,
    #[schemars(length(min = 1, max = 128))]
    pub worktree_id: String,
    pub scope: RepositoryScope,
    #[schemars(length(max = 2000))]
    pub tips: Vec<String>,
    pub observed_at_unix_ms: u64,
    pub repository: RepositoryInfo,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    #[schemars(required)]
    #[schemars(with = "NullableLastViewedSnapshotSchema")]
    pub previous_view: Option<LastViewedSnapshot>,
    pub persistence: SessionPersistenceStatus,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum RepositoryScope {
    Head,
    AllBranches,
    Ref(#[schemars(length(min = 1, max = 16384))] String),
    Worktree(#[schemars(length(min = 1, max = 256))] String),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorktreeInfo {
    #[schemars(length(min = 1, max = 256))]
    pub id: String,
    #[schemars(length(min = 1, max = 16384))]
    pub path: String,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    #[schemars(required)]
    #[schemars(with = "NullableOidSchema")]
    pub head_oid: Option<String>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    #[schemars(required)]
    #[schemars(with = "NullableStringSchema")]
    pub head_reference: Option<String>,
    pub is_main: bool,
    pub is_current: bool,
    pub is_bare: bool,
    pub is_detached: bool,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    #[schemars(required)]
    #[schemars(with = "NullableStringSchema")]
    pub locked_reason: Option<String>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    #[schemars(required)]
    #[schemars(with = "NullableStringSchema")]
    pub prunable_reason: Option<String>,
    pub available: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DefaultBase {
    pub name: String,
    pub oid: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RepositoryNavigation {
    #[schemars(length(max = 2000))]
    pub refs: Vec<RefInfo>,
    pub refs_truncated: bool,
    #[schemars(length(max = 128))]
    pub worktrees: Vec<WorktreeInfo>,
    pub worktrees_truncated: bool,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    #[schemars(required)]
    #[schemars(with = "NullableDefaultBaseSchema")]
    pub default_base: Option<DefaultBase>,
    pub observed_at_unix_ms: u64,
}

struct NullableDefaultBaseSchema;

impl JsonSchema for NullableDefaultBaseSchema {
    fn inline_schema() -> bool {
        true
    }
    fn schema_name() -> Cow<'static, str> {
        "NullableDefaultBase".into()
    }
    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        let schema = generator.subschema_for::<DefaultBase>();
        let schema = serde_json::to_value(schema).expect("default base schema serializes");
        Schema::try_from(serde_json::json!({"anyOf": [schema, {"type": "null"}]}))
            .expect("valid nullable default base schema")
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RefMergeStatusResult {
    #[serde(deserialize_with = "deserialize_required_nullable")]
    #[schemars(required)]
    #[schemars(with = "NullableDefaultBaseSchema")]
    pub default_base: Option<DefaultBase>,
    #[schemars(length(max = 50))]
    pub statuses: Vec<RefMergeStatus>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RefMergeStatus {
    pub name: String,
    pub oid: String,
    pub status: MergeStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum MergeStatus {
    Merged,
    NotMerged,
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LastViewedSnapshot {
    #[schemars(length(max = 2000))]
    pub tips: Vec<String>,
    pub viewed_at_unix_ms: u64,
}

struct NullableLastViewedSnapshotSchema;

impl JsonSchema for NullableLastViewedSnapshotSchema {
    fn inline_schema() -> bool {
        true
    }

    fn schema_name() -> Cow<'static, str> {
        "NullableLastViewedSnapshot".into()
    }

    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        let value_schema = generator.subschema_for::<LastViewedSnapshot>();
        let value_schema =
            serde_json::to_value(value_schema).expect("last viewed snapshot schema serializes");
        Schema::try_from(serde_json::json!({
            "anyOf": [value_schema, {"type": "null"}]
        }))
        .expect("valid nullable last viewed snapshot schema")
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionPersistenceStatus {
    pub recent: StoreStatus,
    pub last_seen: StoreStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum StoreStatus {
    Ok,
    Disabled,
    Unavailable,
    Corrupt,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecentRepository {
    #[schemars(length(min = 1, max = 128))]
    pub repository_key: String,
    #[schemars(length(min = 1, max = 128))]
    pub worktree_id: String,
    #[schemars(length(min = 1, max = 16384))]
    pub path: String,
    #[schemars(length(min = 1, max = 16384))]
    pub git_dir: String,
    #[schemars(length(min = 1, max = 16384))]
    pub common_dir: String,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    #[schemars(required)]
    #[schemars(with = "NullableStringSchema")]
    #[schemars(length(min = 1, max = 16384))]
    pub worktree_path: Option<String>,
    #[schemars(length(min = 1, max = 16))]
    pub object_format: String,
    pub last_opened_at_unix_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RepositoryInfo {
    pub path: String,
    pub git_dir: String,
    pub common_dir: String,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    #[schemars(required)]
    #[schemars(with = "NullableStringSchema")]
    pub worktree_path: Option<String>,
    pub is_bare: bool,
    pub is_shallow: bool,
    pub object_format: String,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    #[schemars(required)]
    #[schemars(with = "NullableStringSchema")]
    pub head_oid: Option<String>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    #[schemars(required)]
    #[schemars(with = "NullableStringSchema")]
    pub head_reference: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum RefKind {
    LocalBranch,
    RemoteBranch,
    Tag,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RefInfo {
    pub name: String,
    pub kind: RefKind,
    pub oid: String,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    #[schemars(required)]
    #[schemars(with = "NullableStringSchema")]
    pub peeled_oid: Option<String>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    #[schemars(required)]
    #[schemars(with = "NullableStringSchema")]
    pub symbolic_target: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommitIdentity {
    pub name: String,
    pub email: String,
    pub timestamp: String,
    pub offset: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommitSummary {
    pub oid: String,
    pub parents: Vec<String>,
    pub summary: String,
    pub summary_truncated: bool,
    pub author: CommitIdentity,
    pub committer: CommitIdentity,
    pub text_lossy: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    ProtocolMismatch,
    ProtocolError,
    InvalidRequest,
    UnknownMethod,
    Busy,
    Cancelled,
    Timeout,
    CoreExited,
    StaleContext,
    GitUnavailable,
    NotARepository,
    RepositoryUnavailable,
    MissingObject,
    UnsupportedRepository,
    ResourceLimit,
    GitError,
    PermissionDenied,
    InvalidCursor,
    SnapshotChanged,
    ScopeUnavailable,
    IndexUnavailable,
    IndexCorrupt,
    IndexVersionUnsupported,
}

#[must_use]
pub fn core_ready_schema() -> Schema {
    schema_for::<CoreReady>()
}

#[must_use]
pub fn client_message_schema() -> Schema {
    schema_for::<ClientMessage>()
}

#[must_use]
pub fn server_message_schema() -> Schema {
    schema_for::<ServerMessage>()
}

fn schema_for<T: JsonSchema>() -> Schema {
    SchemaGenerator::new(SchemaSettings::draft07()).into_root_schema_for::<T>()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    #[test]
    fn client_and_server_messages_match_the_wire_format() {
        let request = ClientMessage::Request {
            request_id: "request-1".into(),
            method: "getRuntimeInfo".into(),
            repo_id: None,
            generation: None,
            params: json!({}),
        };
        assert_eq!(
            serde_json::to_value(request).unwrap(),
            json!({
                "type": "request",
                "requestId": "request-1",
                "method": "getRuntimeInfo",
                "repoId": null,
                "generation": null,
                "params": {}
            })
        );
        assert!(
            serde_json::from_value::<ClientMessage>(json!({
                "type": "hello",
                "protocolVersion": 1,
                "extra": true
            }))
            .is_err()
        );
        assert!(
            serde_json::from_value::<ClientMessage>(json!({
                "type":"request",
                "requestId":"request-1",
                "method":"getRuntimeInfo",
                "generation":null,
                "params":{}
            }))
            .is_err()
        );
        assert!(
            serde_json::from_value::<GitInfo>(json!({
                "available":false,
                "error":"missing version"
            }))
            .is_err()
        );
        assert!(
            serde_json::from_value::<CoreReady>(json!({
                "protocolVersion":2,
                "coreVersion":"0.1.0",
                "pid":1,
                "git":{"available":false,"version":null,"error":null},
                "capabilities":["getRuntimeInfo"]
            }))
            .is_err()
        );

        let error = ServerMessage::Error {
            request_id: Some("request-1".into()),
            repo_id: None,
            generation: None,
            code: ErrorCode::Cancelled,
            message: "请求已取消".into(),
            retryable: false,
        };
        assert_eq!(serde_json::to_value(error).unwrap()["code"], "CANCELLED");
        assert!(
            serde_json::from_value::<ServerMessage>(json!({
                "type":"error",
                "repoId":null,
                "generation":null,
                "code":"CANCELLED",
                "message":"cancelled",
                "retryable":false
            }))
            .is_err()
        );
        let nullable_error: ServerMessage = serde_json::from_value(json!({
            "type":"error",
            "requestId":null,
            "repoId":null,
            "generation":null,
            "code":"PROTOCOL_ERROR",
            "message":"invalid",
            "retryable":false
        }))
        .expect("required nullable fields accept explicit null");
        assert!(matches!(
            nullable_error,
            ServerMessage::Error {
                request_id: None,
                ..
            }
        ));

        let open_request: ClientMessage = serde_json::from_value(json!({
            "type":"request",
            "requestId":"open-1",
            "method":"openRepository",
            "repoId":null,
            "generation":null,
            "params":{"path":"/tmp/repo"}
        }))
        .expect("open request uses the generated path params");
        assert!(matches!(open_request, ClientMessage::Request { .. }));
        assert_eq!(
            serde_json::to_value(ErrorCode::PermissionDenied).unwrap(),
            json!("PERMISSION_DENIED")
        );
    }

    #[test]
    fn schemas_use_draft_07_and_cover_message_unions() {
        for schema in [
            core_ready_schema(),
            client_message_schema(),
            server_message_schema(),
        ] {
            let value: Value = serde_json::to_value(schema).unwrap();
            assert_eq!(value["$schema"], "http://json-schema.org/draft-07/schema#");
            assert!(value["title"].is_string());
            if let Some(variants) = value["oneOf"].as_array() {
                assert!(
                    variants
                        .iter()
                        .all(|variant| variant["additionalProperties"] == false)
                );
            } else {
                assert_eq!(value["additionalProperties"], false);
            }
        }
        let core: Value = serde_json::to_value(core_ready_schema()).unwrap();
        assert!(
            core["required"]
                .as_array()
                .unwrap()
                .contains(&json!("protocolVersion"))
        );
        let client: Value = serde_json::to_value(client_message_schema()).unwrap();
        let request_schema = client["oneOf"]
            .as_array()
            .unwrap()
            .iter()
            .find(|schema| schema["properties"]["type"]["const"] == "request")
            .unwrap();
        let required = request_schema["required"].as_array().unwrap();
        assert!(required.contains(&json!("repoId")));
        assert!(required.contains(&json!("generation")));
        assert_eq!(
            request_schema["properties"]["repoId"]["type"],
            json!(["string", "null"])
        );
        let server: Value = serde_json::to_value(server_message_schema()).unwrap();
        let error_schema = server["oneOf"]
            .as_array()
            .unwrap()
            .iter()
            .find(|schema| schema["properties"]["type"]["const"] == "error")
            .unwrap();
        for field in ["requestId", "repoId", "generation"] {
            assert!(
                error_schema["required"]
                    .as_array()
                    .unwrap()
                    .contains(&json!(field))
            );
        }
        assert_eq!(
            error_schema["properties"]["requestId"]["type"],
            json!(["string", "null"])
        );
        let session_schema = &server["definitions"]["RepositorySessionInfo"];
        assert!(
            session_schema["required"]
                .as_array()
                .unwrap()
                .contains(&json!("previousView"))
        );
        assert_eq!(
            session_schema["properties"]["previousView"]["anyOf"][1]["type"],
            "null"
        );
        let recent_schema = &server["definitions"]["RecentRepository"];
        assert_eq!(
            recent_schema["properties"]["worktreePath"]["type"],
            json!(["string", "null"])
        );
    }

    #[test]
    fn metadata_index_status_error_is_required_nullable() {
        let status: MetadataIndexStatus = serde_json::from_value(json!({
            "snapshotKey":"abc",
            "state":"idle",
            "coverage":{"processed":0,"complete":false},
            "diskBytes":0,
            "quotaBytes":1024,
            "error":null
        }))
        .unwrap();
        assert_eq!(status.error, None);
        let schema: Value = serde_json::to_value(server_message_schema()).unwrap();
        let error_schema = &schema["definitions"]["MetadataIndexStatus"]["properties"]["error"];
        assert!(
            error_schema["anyOf"]
                .as_array()
                .is_some_and(|variants| variants.iter().any(|variant| variant["type"] == "null"))
        );
        let missing = json!({
            "snapshotKey":null,"state":"idle","coverage":{"processed":0,"complete":false},"diskBytes":0,"quotaBytes":1024
        });
        assert!(serde_json::from_value::<MetadataIndexStatus>(missing).is_err());
    }

    #[test]
    fn history_commit_is_flattened_and_roundtrips_without_losing_the_marker() {
        let wire = json!({
            "oid":"0123456789012345678901234567890123456789",
            "parents":[],
            "summary":"initial",
            "summaryTruncated":false,
            "author":{"name":"A","email":"a@example.test","timestamp":"1","offset":"+0000"},
            "committer":{"name":"A","email":"a@example.test","timestamp":"1","offset":"+0000"},
            "textLossy":false,
            "isNewSinceLastSeen":true,
            "graph":{"lane":0,"color":0,"parents":[],"boundary":false,"above":0,"below":0,"hiddenLaneCount":0,"hiddenThroughRanges":[],"segments":[]}
        });
        let decoded: HistoryCommit = serde_json::from_value(wire.clone()).unwrap();
        assert!(decoded.is_new_since_last_seen);
        assert_eq!(decoded.commit.summary, "initial");
        assert_eq!(serde_json::to_value(decoded).unwrap(), wire);

        let mut unknown = wire;
        unknown["unexpected"] = json!(true);
        assert!(serde_json::from_value::<HistoryCommit>(unknown).is_err());

        let schema = serde_json::to_value(server_message_schema()).unwrap();
        let printed = schema.to_string();
        assert!(printed.contains("isNewSinceLastSeen"));
        assert!(printed.contains("lastSeenDividerOid"));
        assert!(printed.contains("maxLength"));
    }

    #[test]
    fn repository_scope_keeps_legacy_head_encoding_and_uses_external_ref_tags() {
        assert_eq!(
            serde_json::to_value(RepositoryScope::Head).unwrap(),
            json!("head")
        );
        assert_eq!(
            serde_json::to_value(RepositoryScope::AllBranches).unwrap(),
            json!("allBranches")
        );
        assert_eq!(
            serde_json::to_value(RepositoryScope::Ref("refs/heads/topic".into())).unwrap(),
            json!({"ref":"refs/heads/topic"})
        );
        assert_eq!(
            serde_json::to_value(RepositoryScope::Worktree("worktree:opaque".into())).unwrap(),
            json!({"worktree":"worktree:opaque"})
        );
        assert_eq!(
            serde_json::from_value::<RepositoryScope>(json!("head")).unwrap(),
            RepositoryScope::Head
        );
    }
}
