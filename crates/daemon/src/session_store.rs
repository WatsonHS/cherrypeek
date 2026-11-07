use commitscope_core::{
    LastViewedSnapshot, RecentRepository, RepositoryInfo, RepositoryScope, RepositorySessionInfo,
    StoreStatus,
};
use serde::{Deserialize, Serialize};
use std::{
    env,
    ffi::{OsStr, OsString},
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

const DATA_DIR_ENV: &str = "COMMITSCOPE_APP_DATA_DIR";
const RECENT_FILE: &str = "recent-repositories-v1.json";
const LAST_VIEWED_FILE: &str = "last-viewed-tips-v1.json";
const SCHEMA_VERSION: u32 = 1;
const MAX_FILE_BYTES: usize = 1024 * 1024;
const MAX_RECENT_REPOSITORIES: usize = 20;
const MAX_LAST_VIEWED_ENTRIES: usize = 100;
const MAX_TIPS: usize = 2_000;
const MAX_IDENTITY_BYTES: usize = 128;
const MAX_PATH_BYTES: usize = 16 * 1024;
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone)]
pub struct OpenRepositoryStoreResult {
    pub previous_view: Option<LastViewedSnapshot>,
    pub recent_status: StoreStatus,
    pub last_seen_status: StoreStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RecordViewStoreResult {
    pub saved: bool,
    pub status: StoreStatus,
}

#[derive(Clone)]
pub struct SessionStore {
    data_dir: Option<PathBuf>,
    initial_status: StoreStatus,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RecentDocument {
    schema_version: u32,
    repositories: Vec<RecentRepository>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LastViewedRecord {
    repository_key: String,
    worktree_id: String,
    scope: RepositoryScope,
    snapshot: LastViewedSnapshot,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LastViewedDocument {
    schema_version: u32,
    entries: Vec<LastViewedRecord>,
}

impl SessionStore {
    pub fn metadata_cache_root(&self, repository: &RepositoryInfo) -> Result<PathBuf, ()> {
        let data_dir = self.data_dir.as_deref().ok_or(())?;
        let checked = safe_data_dir(data_dir, repository)?;
        let root = checked.join("metadata-index");
        let root = ensure_safe_directory(&root)?;
        if safe_data_dir(&root, repository)? != root {
            return Err(());
        }
        Ok(root)
    }

    pub fn from_env() -> Self {
        match env::var_os(DATA_DIR_ENV) {
            None => Self {
                data_dir: None,
                initial_status: StoreStatus::Disabled,
            },
            Some(value) => match normalize_app_data_path(&value) {
                Ok(path) => Self {
                    data_dir: Some(path),
                    initial_status: StoreStatus::Ok,
                },
                Err(_) => Self {
                    data_dir: None,
                    initial_status: StoreStatus::Unavailable,
                },
            },
        }
    }

    pub fn recent(&self) -> (Vec<RecentRepository>, StoreStatus) {
        let Some(data_dir) = &self.data_dir else {
            return (Vec::new(), self.initial_status);
        };
        let Some(document) = self.read_recent(data_dir) else {
            return (Vec::new(), self.recent_read_status(data_dir));
        };
        (document.repositories, StoreStatus::Ok)
    }

    pub fn open_repository(
        &self,
        repository: &RepositoryInfo,
        repository_key: &str,
        worktree_id: &str,
        scope: &RepositoryScope,
        observed_at_unix_ms: u64,
    ) -> OpenRepositoryStoreResult {
        let Some(data_dir) = &self.data_dir else {
            return OpenRepositoryStoreResult {
                previous_view: None,
                recent_status: self.initial_status,
                last_seen_status: self.initial_status,
            };
        };

        if !valid_identity(repository_key) || !valid_identity(worktree_id) || !valid_scope(scope) {
            return OpenRepositoryStoreResult {
                previous_view: None,
                recent_status: StoreStatus::Unavailable,
                last_seen_status: StoreStatus::Unavailable,
            };
        }
        let Ok(safe_dir) = safe_data_dir(data_dir, repository) else {
            return OpenRepositoryStoreResult {
                previous_view: None,
                recent_status: StoreStatus::Unavailable,
                last_seen_status: StoreStatus::Unavailable,
            };
        };

        // Read the previous snapshot before writing any state for this open.
        let (previous_view, last_seen_status) = match self.read_last_viewed(&safe_dir) {
            Ok(document) => {
                let found = document.entries.iter().find(|entry| {
                    entry.repository_key == repository_key
                        && entry.worktree_id == worktree_id
                        && &entry.scope == scope
                });
                match found {
                    Some(entry) if valid_snapshot(repository, &entry.snapshot) => {
                        (Some(entry.snapshot.clone()), StoreStatus::Ok)
                    }
                    Some(_) => (None, StoreStatus::Corrupt),
                    None => (None, StoreStatus::Ok),
                }
            }
            Err(status) => (None, status),
        };

        let recent = RecentRepository {
            repository_key: repository_key.to_owned(),
            worktree_id: worktree_id.to_owned(),
            path: repository.path.clone(),
            git_dir: repository.git_dir.clone(),
            common_dir: repository.common_dir.clone(),
            worktree_path: repository.worktree_path.clone(),
            object_format: repository.object_format.clone(),
            last_opened_at_unix_ms: observed_at_unix_ms,
        };
        let recent_status = self.record_recent(&safe_dir, recent, repository);
        OpenRepositoryStoreResult {
            previous_view,
            recent_status,
            last_seen_status,
        }
    }

    pub fn capture_previous_view(
        &self,
        repository: &RepositoryInfo,
        repository_key: &str,
        worktree_id: &str,
        scope: &RepositoryScope,
    ) -> (Option<LastViewedSnapshot>, StoreStatus) {
        let Some(data_dir) = &self.data_dir else {
            return (None, self.initial_status);
        };
        if !valid_identity(repository_key) || !valid_identity(worktree_id) || !valid_scope(scope) {
            return (None, StoreStatus::Unavailable);
        }
        let Ok(safe_dir) = safe_data_dir(data_dir, repository) else {
            return (None, StoreStatus::Unavailable);
        };
        match self.read_last_viewed(&safe_dir) {
            Ok(document) => {
                let found = document.entries.iter().find(|entry| {
                    entry.repository_key == repository_key
                        && entry.worktree_id == worktree_id
                        && &entry.scope == scope
                });
                match found {
                    Some(entry) if valid_snapshot(repository, &entry.snapshot) => {
                        (Some(entry.snapshot.clone()), StoreStatus::Ok)
                    }
                    Some(_) => (None, StoreStatus::Corrupt),
                    None => (None, StoreStatus::Ok),
                }
            }
            Err(status) => (None, status),
        }
    }

    pub fn record_view(&self, session: &RepositorySessionInfo) -> RecordViewStoreResult {
        let Some(data_dir) = &self.data_dir else {
            return RecordViewStoreResult {
                saved: false,
                status: self.initial_status,
            };
        };
        if !valid_identity(&session.repository_key)
            || !valid_identity(&session.worktree_id)
            || !valid_scope(&session.scope)
        {
            return RecordViewStoreResult {
                saved: false,
                status: StoreStatus::Unavailable,
            };
        }
        let Ok(safe_dir) = safe_data_dir(data_dir, &session.repository) else {
            return RecordViewStoreResult {
                saved: false,
                status: StoreStatus::Unavailable,
            };
        };

        let Ok(mut document) = self.read_last_viewed(&safe_dir) else {
            return RecordViewStoreResult {
                saved: false,
                status: self.last_viewed_read_status(&safe_dir),
            };
        };
        let snapshot = LastViewedSnapshot {
            tips: session.tips.clone(),
            viewed_at_unix_ms: now_unix_ms(),
        };
        if !valid_snapshot(&session.repository, &snapshot) {
            return RecordViewStoreResult {
                saved: false,
                status: StoreStatus::Unavailable,
            };
        }
        document.entries.retain(|entry| {
            entry.repository_key != session.repository_key
                || entry.worktree_id != session.worktree_id
                || entry.scope != session.scope
        });
        document.entries.push(LastViewedRecord {
            repository_key: session.repository_key.clone(),
            worktree_id: session.worktree_id.clone(),
            scope: session.scope.clone(),
            snapshot,
        });
        document
            .entries
            .sort_by_key(|entry| entry.snapshot.viewed_at_unix_ms);
        if document.entries.len() > MAX_LAST_VIEWED_ENTRIES {
            let remove_count = document.entries.len() - MAX_LAST_VIEWED_ENTRIES;
            document.entries.drain(0..remove_count);
        }
        match self.write_document(&safe_dir, LAST_VIEWED_FILE, &document, &session.repository) {
            Ok(()) => RecordViewStoreResult {
                saved: true,
                status: StoreStatus::Ok,
            },
            Err(()) => RecordViewStoreResult {
                saved: false,
                status: StoreStatus::Unavailable,
            },
        }
    }

    fn record_recent(
        &self,
        data_dir: &Path,
        recent: RecentRepository,
        repository: &RepositoryInfo,
    ) -> StoreStatus {
        let mut document = match self.read_recent(data_dir) {
            Some(document) => document,
            None => return self.recent_read_status(data_dir),
        };
        document.repositories.retain(|entry| {
            entry.repository_key != recent.repository_key || entry.worktree_id != recent.worktree_id
        });
        document.repositories.push(recent);
        document
            .repositories
            .sort_by_key(|entry| entry.last_opened_at_unix_ms);
        document.repositories.reverse();
        document.repositories.truncate(MAX_RECENT_REPOSITORIES);
        match self.write_document(data_dir, RECENT_FILE, &document, repository) {
            Ok(()) => StoreStatus::Ok,
            Err(()) => StoreStatus::Unavailable,
        }
    }

    fn read_recent(&self, data_dir: &Path) -> Option<RecentDocument> {
        match read_bounded_json(data_dir, RECENT_FILE) {
            Ok(None) => Some(RecentDocument {
                schema_version: SCHEMA_VERSION,
                repositories: Vec::new(),
            }),
            Ok(Some(document)) => {
                let document = serde_json::from_slice::<RecentDocument>(&document).ok()?;
                if document.schema_version != SCHEMA_VERSION
                    || document.repositories.len() > MAX_RECENT_REPOSITORIES
                    || document
                        .repositories
                        .iter()
                        .any(|entry| !valid_recent(entry))
                {
                    None
                } else {
                    Some(document)
                }
            }
            Err(_) => None,
        }
    }

    fn read_last_viewed(&self, data_dir: &Path) -> Result<LastViewedDocument, StoreStatus> {
        match read_bounded_json(data_dir, LAST_VIEWED_FILE) {
            Ok(None) => Ok(LastViewedDocument {
                schema_version: SCHEMA_VERSION,
                entries: Vec::new(),
            }),
            Ok(Some(bytes)) => {
                let document = serde_json::from_slice::<LastViewedDocument>(&bytes)
                    .map_err(|_| StoreStatus::Corrupt)?;
                if document.schema_version != SCHEMA_VERSION
                    || document.entries.len() > MAX_LAST_VIEWED_ENTRIES
                    || document.entries.iter().any(|entry| {
                        !valid_identity(&entry.repository_key)
                            || !valid_identity(&entry.worktree_id)
                            || !valid_scope(&entry.scope)
                            || entry.snapshot.tips.len() > MAX_TIPS
                            || entry.snapshot.tips.iter().any(|oid| !valid_oid(oid))
                    })
                {
                    return Err(StoreStatus::Corrupt);
                }
                Ok(document)
            }
            Err(status) => Err(status),
        }
    }

    fn recent_read_status(&self, data_dir: &Path) -> StoreStatus {
        match read_bounded_json(data_dir, RECENT_FILE) {
            Err(status) => status,
            Ok(Some(bytes)) if serde_json::from_slice::<RecentDocument>(&bytes).is_err() => {
                StoreStatus::Corrupt
            }
            Ok(Some(bytes)) => match serde_json::from_slice::<RecentDocument>(&bytes) {
                Ok(document)
                    if document.schema_version == SCHEMA_VERSION
                        && document.repositories.len() <= MAX_RECENT_REPOSITORIES
                        && document.repositories.iter().all(valid_recent) =>
                {
                    StoreStatus::Ok
                }
                _ => StoreStatus::Corrupt,
            },
            Ok(None) => StoreStatus::Ok,
        }
    }

    fn last_viewed_read_status(&self, data_dir: &Path) -> StoreStatus {
        match self.read_last_viewed(data_dir) {
            Ok(_) => StoreStatus::Ok,
            Err(status) => status,
        }
    }

    fn write_document<T: Serialize>(
        &self,
        data_dir: &Path,
        name: &str,
        document: &T,
        repository: &RepositoryInfo,
    ) -> Result<(), ()> {
        let bytes = serde_json::to_vec(document).map_err(|_| ())?;
        if bytes.len() > MAX_FILE_BYTES {
            return Err(());
        }
        let checked_dir = safe_data_dir(data_dir, repository)?;
        if checked_dir != data_dir {
            return Err(());
        }
        let safe_dir = ensure_safe_directory(data_dir).map_err(|_| ())?;
        if safe_data_dir(&safe_dir, repository)? != safe_dir {
            return Err(());
        }
        atomic_replace(&safe_dir, name, &bytes)
    }
}

fn valid_recent(entry: &RecentRepository) -> bool {
    valid_identity(&entry.repository_key)
        && valid_identity(&entry.worktree_id)
        && bounded_absolute_path(&entry.path)
        && bounded_absolute_path(&entry.git_dir)
        && bounded_absolute_path(&entry.common_dir)
        && entry
            .worktree_path
            .as_deref()
            .is_none_or(bounded_absolute_path)
        && matches!(entry.object_format.as_str(), "sha1" | "sha256")
}

fn valid_snapshot(repository: &RepositoryInfo, snapshot: &LastViewedSnapshot) -> bool {
    let unique_tips = snapshot
        .tips
        .iter()
        .collect::<std::collections::HashSet<_>>();
    snapshot.tips.len() <= MAX_TIPS
        && unique_tips.len() == snapshot.tips.len()
        && snapshot.tips.iter().all(|oid| {
            oid_length(&repository.object_format).is_some_and(|length| oid.len() == length)
                && valid_oid(oid)
        })
}

fn valid_scope(scope: &RepositoryScope) -> bool {
    match scope {
        RepositoryScope::Head | RepositoryScope::AllBranches => true,
        RepositoryScope::Ref(name) => {
            name.len() <= MAX_PATH_BYTES
                && (name.starts_with("refs/heads/")
                    || name.starts_with("refs/remotes/")
                    || name.starts_with("refs/tags/"))
                && !name.contains('\0')
        }
        RepositoryScope::Worktree(id) => valid_identity(id),
    }
}

fn valid_oid(value: &str) -> bool {
    value.bytes().all(|byte| byte.is_ascii_hexdigit()) && (value.len() == 40 || value.len() == 64)
}

fn oid_length(object_format: &str) -> Option<usize> {
    match object_format {
        "sha1" => Some(40),
        "sha256" => Some(64),
        _ => None,
    }
}

fn valid_identity(value: &str) -> bool {
    !value.is_empty() && value.len() <= MAX_IDENTITY_BYTES && !value.contains('\0')
}

fn absolute_path(value: &str) -> bool {
    let path = Path::new(value);
    path.is_absolute() && !value.contains('\0')
}

fn bounded_absolute_path(value: &str) -> bool {
    absolute_path(value) && value.len() <= MAX_PATH_BYTES
}

fn normalize_app_data_path(value: &OsStr) -> Result<PathBuf, ()> {
    let path = PathBuf::from(value);
    if !path.is_absolute() || path.as_os_str().to_string_lossy().contains('\0') {
        return Err(());
    }
    if path
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return Err(());
    }
    canonicalize_allow_missing(&path)
}

fn safe_data_dir(data_dir: &Path, repository: &RepositoryInfo) -> Result<PathBuf, ()> {
    let safe = canonicalize_allow_missing(data_dir)?;
    let mut protected = vec![
        canonicalize_existing(Path::new(&repository.path))?,
        canonicalize_existing(Path::new(&repository.git_dir))?,
        canonicalize_existing(Path::new(&repository.common_dir))?,
    ];
    if let Some(path) = repository.worktree_path.as_deref() {
        protected.push(canonicalize_existing(Path::new(path))?);
    }
    if protected
        .iter()
        .any(|repo_path| safe.starts_with(repo_path))
    {
        return Err(());
    }
    Ok(safe)
}

fn canonicalize_existing(path: &Path) -> Result<PathBuf, ()> {
    if !path.is_absolute() {
        return Err(());
    }
    fs::canonicalize(path).map_err(|_| ())
}

fn canonicalize_allow_missing(path: &Path) -> Result<PathBuf, ()> {
    if !path.is_absolute() {
        return Err(());
    }
    let normalized = normalize_absolute(path)?;
    let mut existing = normalized.as_path();
    let mut missing = Vec::<OsString>::new();
    loop {
        match fs::symlink_metadata(existing) {
            Ok(_) => break,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let name = existing.file_name().ok_or(())?.to_os_string();
                missing.push(name);
                existing = existing.parent().ok_or(())?;
            }
            Err(_) => return Err(()),
        }
    }
    let mut result = fs::canonicalize(existing).map_err(|_| ())?;
    for component in missing.iter().rev() {
        result.push(component);
    }
    Ok(result)
}

fn normalize_absolute(path: &Path) -> Result<PathBuf, ()> {
    let mut result = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => result.push(prefix.as_os_str()),
            Component::RootDir => result.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                result.pop();
            }
            Component::Normal(value) => result.push(value),
        }
    }
    if result.is_absolute() {
        Ok(result)
    } else {
        Err(())
    }
}

fn ensure_safe_directory(path: &Path) -> Result<PathBuf, ()> {
    let canonical = canonicalize_allow_missing(path)?;
    if let Ok(metadata) = fs::symlink_metadata(path)
        && (metadata.file_type().is_symlink() || !metadata.is_dir())
    {
        return Err(());
    }
    fs::create_dir_all(path).map_err(|_| ())?;
    let verified = fs::canonicalize(path).map_err(|_| ())?;
    if verified != canonical {
        return Err(());
    }
    if !fs::metadata(&verified).map_err(|_| ())?.is_dir() {
        return Err(());
    }
    Ok(verified)
}

fn read_bounded_json(data_dir: &Path, name: &str) -> Result<Option<Vec<u8>>, StoreStatus> {
    let path = data_dir.join(name);
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(StoreStatus::Unavailable),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(StoreStatus::Corrupt);
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let file = options.open(&path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::InvalidInput {
            StoreStatus::Corrupt
        } else {
            StoreStatus::Unavailable
        }
    })?;
    if !file
        .metadata()
        .map_err(|_| StoreStatus::Unavailable)?
        .is_file()
    {
        return Err(StoreStatus::Corrupt);
    }
    let mut bytes = Vec::with_capacity(MAX_FILE_BYTES.min(metadata.len() as usize));
    file.take((MAX_FILE_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| StoreStatus::Unavailable)?;
    if bytes.len() > MAX_FILE_BYTES {
        return Err(StoreStatus::Corrupt);
    }
    Ok(Some(bytes))
}

fn atomic_replace(directory: &Path, name: &str, bytes: &[u8]) -> Result<(), ()> {
    let destination = directory.join(name);
    match fs::symlink_metadata(&destination) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => return Err(()),
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(()),
        _ => {}
    }
    let suffix = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let temporary = directory.join(format!(".{name}.{}.{}.tmp", std::process::id(), suffix));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let mut created = false;
    let result = (|| {
        let mut file = options.open(&temporary).map_err(|_| ())?;
        created = true;
        file.write_all(bytes).map_err(|_| ())?;
        file.sync_all().map_err(|_| ())?;
        drop(file);
        fs::rename(&temporary, &destination).map_err(|_| ())?;
        File::open(directory)
            .and_then(|directory| directory.sync_all())
            .map_err(|_| ())?;
        Ok(())
    })();
    if result.is_err() && created {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use commitscope_core::SessionPersistenceStatus;
    use std::sync::atomic::AtomicU64;

    static TEST_COUNTER: AtomicU64 = AtomicU64::new(0);

    struct TestDir(PathBuf);

    impl TestDir {
        fn new(label: &str) -> Self {
            let path = env::temp_dir().join(format!(
                "commitscope-session-store-{label}-{}-{}",
                std::process::id(),
                TEST_COUNTER.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn test_repository(root: &Path, head: Option<&str>) -> RepositoryInfo {
        let worktree = root.join("worktree");
        let git_dir = worktree.join(".git");
        fs::create_dir_all(&git_dir).unwrap();
        let path = worktree.to_string_lossy().into_owned();
        let git_dir = git_dir.to_string_lossy().into_owned();
        RepositoryInfo {
            path: path.clone(),
            git_dir: git_dir.clone(),
            common_dir: git_dir,
            worktree_path: Some(path),
            is_bare: false,
            is_shallow: false,
            object_format: "sha1".into(),
            head_oid: head.map(str::to_owned),
            head_reference: Some("refs/heads/main".into()),
        }
    }

    fn test_session(repository: RepositoryInfo) -> RepositorySessionInfo {
        let tips = repository.head_oid.iter().cloned().collect();
        RepositorySessionInfo {
            repo_id: "repo-1".into(),
            generation: "generation-1".into(),
            repository_key: "repository-key".into(),
            worktree_id: "worktree-id".into(),
            scope: RepositoryScope::Head,
            tips,
            observed_at_unix_ms: 100,
            repository,
            previous_view: None,
            persistence: SessionPersistenceStatus {
                recent: StoreStatus::Ok,
                last_seen: StoreStatus::Ok,
            },
        }
    }

    #[test]
    fn normalized_paths_resolve_dot_segments() {
        assert_eq!(
            normalize_absolute(Path::new("/tmp/a/../b")).unwrap(),
            Path::new("/tmp/b")
        );
    }

    #[test]
    fn repository_and_linked_worktree_paths_are_protected_before_directory_creation() {
        let temp = TestDir::new("protected-path");
        let repository = test_repository(&temp.0, Some(&"a".repeat(40)));
        let data_dir = PathBuf::from(&repository.path).join("app-data");
        assert!(safe_data_dir(&data_dir, &repository).is_err());
        assert!(
            !data_dir.exists(),
            "unsafe app-data path must not be created"
        );
    }

    #[test]
    fn open_records_recent_but_only_record_view_persists_captured_head() {
        let temp = TestDir::new("captured-head");
        let app_data = temp.0.join("app-data");
        let old_head = "a".repeat(40);
        let repository = test_repository(&temp.0, Some(&old_head));
        let store = SessionStore {
            data_dir: Some(app_data.clone()),
            initial_status: StoreStatus::Ok,
        };

        let opened = store.open_repository(
            &repository,
            "repository-key",
            "worktree-id",
            &RepositoryScope::Head,
            123,
        );
        assert_eq!(opened.previous_view, None);
        assert_eq!(opened.recent_status, StoreStatus::Ok);
        assert_eq!(opened.last_seen_status, StoreStatus::Ok);
        assert!(app_data.join(RECENT_FILE).exists());
        assert!(
            !app_data.join(LAST_VIEWED_FILE).exists(),
            "open must not mark the session viewed"
        );

        let session = test_session(repository.clone());
        let recorded = store.record_view(&session);
        assert_eq!(
            recorded,
            RecordViewStoreResult {
                saved: true,
                status: StoreStatus::Ok
            }
        );

        let advanced_head = "b".repeat(40);
        let mut advanced_repository = repository.clone();
        advanced_repository.head_oid = Some(advanced_head.clone());
        let reopened = store.open_repository(
            &advanced_repository,
            "repository-key",
            "worktree-id",
            &RepositoryScope::Head,
            456,
        );
        assert_eq!(reopened.previous_view.unwrap().tips, vec![old_head]);

        let advanced_session = test_session(advanced_repository.clone());
        assert!(store.record_view(&advanced_session).saved);
        let reopened_again = store.open_repository(
            &advanced_repository,
            "repository-key",
            "worktree-id",
            &RepositoryScope::Head,
            789,
        );
        assert_eq!(
            reopened_again.previous_view.unwrap().tips,
            vec![advanced_head]
        );
    }

    #[test]
    fn last_viewed_snapshots_are_isolated_by_scope_and_keep_all_tips() {
        let temp = TestDir::new("scope-tips");
        let app_data = temp.0.join("app-data");
        let head = "a".repeat(40);
        let other = "b".repeat(40);
        let repository = test_repository(&temp.0, Some(&head));
        let store = SessionStore {
            data_dir: Some(app_data),
            initial_status: StoreStatus::Ok,
        };
        let mut session = test_session(repository.clone());
        session.scope = RepositoryScope::AllBranches;
        session.tips = vec![head.clone(), other.clone()];
        assert!(store.record_view(&session).saved);

        let all = store.open_repository(
            &repository,
            "repository-key",
            "worktree-id",
            &RepositoryScope::AllBranches,
            456,
        );
        assert_eq!(all.previous_view.unwrap().tips, vec![head.clone(), other]);
        let head_only = store.open_repository(
            &repository,
            "repository-key",
            "worktree-id",
            &RepositoryScope::Head,
            789,
        );
        assert_eq!(head_only.previous_view, None);
    }

    #[test]
    fn viewed_empty_repository_is_distinct_from_never_viewed_repository() {
        let temp = TestDir::new("empty-viewed");
        let app_data = temp.0.join("app-data");
        let empty_repository = test_repository(&temp.0, None);
        let store = SessionStore {
            data_dir: Some(app_data.clone()),
            initial_status: StoreStatus::Ok,
        };
        let empty_session = test_session(empty_repository);
        assert!(store.record_view(&empty_session).saved);

        let mut first_commit_repository = test_repository(&temp.0, Some(&"d".repeat(40)));
        first_commit_repository.head_reference = Some("refs/heads/main".into());
        let reopened = store.open_repository(
            &first_commit_repository,
            "repository-key",
            "worktree-id",
            &RepositoryScope::Head,
            123,
        );
        assert_eq!(reopened.previous_view.unwrap().tips, Vec::<String>::new());
    }

    #[test]
    fn corrupt_last_viewed_file_is_not_overwritten_and_recent_store_still_works() {
        let temp = TestDir::new("corrupt-store");
        let app_data = temp.0.join("app-data");
        fs::create_dir_all(&app_data).unwrap();
        let corrupt_bytes = b"{not json";
        fs::write(app_data.join(LAST_VIEWED_FILE), corrupt_bytes).unwrap();
        let repository = test_repository(&temp.0, Some(&"b".repeat(40)));
        let store = SessionStore {
            data_dir: Some(app_data.clone()),
            initial_status: StoreStatus::Ok,
        };

        let opened = store.open_repository(
            &repository,
            "repository-key",
            "worktree-id",
            &RepositoryScope::Head,
            123,
        );
        assert_eq!(opened.previous_view, None);
        assert_eq!(opened.last_seen_status, StoreStatus::Corrupt);
        assert_eq!(opened.recent_status, StoreStatus::Ok);
        assert_eq!(
            fs::read(app_data.join(LAST_VIEWED_FILE)).unwrap(),
            corrupt_bytes
        );
        let recorded = store.record_view(&test_session(repository));
        assert_eq!(
            recorded,
            RecordViewStoreResult {
                saved: false,
                status: StoreStatus::Corrupt
            }
        );
        assert_eq!(
            fs::read(app_data.join(LAST_VIEWED_FILE)).unwrap(),
            corrupt_bytes
        );
    }

    #[test]
    fn recent_list_is_deduplicated_and_bounded() {
        let temp = TestDir::new("recent-limit");
        let app_data_path = temp.0.join("app-data");
        fs::create_dir_all(&app_data_path).unwrap();
        let app_data = fs::canonicalize(app_data_path).unwrap();
        let repository = test_repository(&temp.0, Some(&"c".repeat(40)));
        let store = SessionStore {
            data_dir: Some(app_data.clone()),
            initial_status: StoreStatus::Ok,
        };
        for index in 0..(MAX_RECENT_REPOSITORIES + 3) {
            let path = format!("/tmp/repository-{index}");
            assert_eq!(
                store.record_recent(
                    &app_data,
                    RecentRepository {
                        repository_key: format!("repository-{index}"),
                        worktree_id: "worktree".into(),
                        path: path.clone(),
                        git_dir: format!("{path}/.git"),
                        common_dir: format!("{path}/.git"),
                        worktree_path: Some(path),
                        object_format: "sha1".into(),
                        last_opened_at_unix_ms: index as u64,
                    },
                    &repository
                ),
                StoreStatus::Ok
            );
        }
        let latest_path = "/tmp/repository-10".to_owned();
        assert_eq!(
            store.record_recent(
                &app_data,
                RecentRepository {
                    repository_key: "repository-10".into(),
                    worktree_id: "worktree".into(),
                    path: latest_path.clone(),
                    git_dir: format!("{latest_path}/.git"),
                    common_dir: format!("{latest_path}/.git"),
                    worktree_path: Some(latest_path),
                    object_format: "sha1".into(),
                    last_opened_at_unix_ms: 100,
                },
                &repository
            ),
            StoreStatus::Ok
        );
        let (repositories, status) = store.recent();
        assert_eq!(status, StoreStatus::Ok);
        assert_eq!(repositories.len(), MAX_RECENT_REPOSITORIES);
        assert_eq!(repositories[0].repository_key, "repository-10");
        assert!(
            !repositories
                .iter()
                .any(|entry| entry.repository_key == "repository-0")
        );
        assert_eq!(
            repositories
                .iter()
                .filter(|entry| entry.repository_key == "repository-10")
                .count(),
            1
        );
    }

    #[test]
    fn last_viewed_entries_are_bounded_to_one_hundred_scopes() {
        let temp = TestDir::new("last-viewed-limit");
        let app_data = temp.0.join("app-data");
        let repository = test_repository(&temp.0, Some(&"e".repeat(40)));
        let store = SessionStore {
            data_dir: Some(app_data.clone()),
            initial_status: StoreStatus::Ok,
        };
        for index in 0..(MAX_LAST_VIEWED_ENTRIES + 5) {
            let mut session = test_session(repository.clone());
            session.repository_key = format!("repository-{index}");
            let saved = store.record_view(&session);
            assert_eq!(
                saved,
                RecordViewStoreResult {
                    saved: true,
                    status: StoreStatus::Ok
                }
            );
        }
        let document = store.read_last_viewed(&app_data).unwrap();
        assert_eq!(document.entries.len(), MAX_LAST_VIEWED_ENTRIES);
        assert!(
            !document
                .entries
                .iter()
                .any(|entry| entry.repository_key == "repository-0")
        );
        assert!(
            document
                .entries
                .iter()
                .any(|entry| entry.repository_key == "repository-104")
        );
    }

    #[test]
    fn bounded_reader_rejects_oversize_and_symlink_state_files() {
        let temp = TestDir::new("bounded-reader");
        let app_data = temp.0.join("app-data");
        fs::create_dir_all(&app_data).unwrap();
        let oversized = app_data.join(RECENT_FILE);
        fs::write(&oversized, vec![b' '; MAX_FILE_BYTES + 1]).unwrap();
        assert_eq!(
            read_bounded_json(&app_data, RECENT_FILE),
            Err(StoreStatus::Corrupt)
        );

        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            fs::remove_file(&oversized).unwrap();
            let outside = temp.0.join("outside.json");
            fs::write(&outside, b"{}").unwrap();
            symlink(&outside, &oversized).unwrap();
            assert_eq!(
                read_bounded_json(&app_data, RECENT_FILE),
                Err(StoreStatus::Corrupt)
            );
        }
    }
}
