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
    RefreshRepository(RefreshRepositoryParams),
    GetRepositoryNavigation(EmptyParams),
    SelectRepositoryScope(SelectRepositoryScopeParams),
    RefMergeStatus(RefMergeStatusParams),
    GetMetadataIndexStatus(EmptyParams),
    ControlMetadataIndex(ControlMetadataIndexParams),
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
            "isNewSinceLastSeen":true
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
