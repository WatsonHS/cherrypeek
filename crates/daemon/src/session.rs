use crate::{repository::DiscoveredRepository, session_store::SessionStore};
use commitscope_core::{
    ErrorCode, RecentRepository, RepositoryScope, RepositorySessionInfo, SessionPersistenceStatus,
    StoreStatus,
};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Clone)]
pub struct RepositorySession {
    pub info: RepositorySessionInfo,
    pub discovered: Arc<DiscoveredRepository>,
}

pub struct SessionCommit {
    pub session: Arc<RepositorySession>,
    pub replaced_repo_id: Option<String>,
}

pub struct SessionManager {
    current: Option<Arc<RepositorySession>>,
    latest_open_intent: u64,
    pending_opens: HashMap<u64, Arc<AtomicBool>>,
    store: SessionStore,
}

impl SessionManager {
    pub fn new(store: SessionStore) -> Self {
        Self {
            current: None,
            latest_open_intent: 0,
            pending_opens: HashMap::new(),
            store,
        }
    }

    pub fn begin_open(&mut self, cancelled: Arc<AtomicBool>) -> u64 {
        self.latest_open_intent = self.latest_open_intent.wrapping_add(1).max(1);
        for pending in self.pending_opens.values() {
            pending.store(true, Ordering::Release);
        }
        let intent = self.latest_open_intent;
        self.pending_opens.insert(intent, cancelled);
        intent
    }

    pub fn finish_open_failure(&mut self, intent: u64) {
        self.pending_opens.remove(&intent);
    }

    pub fn commit_open(
        &mut self,
        intent: u64,
        cancelled: &AtomicBool,
        discovered: Arc<DiscoveredRepository>,
    ) -> Result<SessionCommit, SessionError> {
        if cancelled.load(Ordering::Acquire) || intent != self.latest_open_intent {
            self.pending_opens.remove(&intent);
            return Err(SessionError::new(
                ErrorCode::Cancelled,
                "Repository open was cancelled or superseded",
            ));
        }

        let repository_key = repository_key(&discovered)?;
        let worktree_id = worktree_id(&repository_key, &discovered)?;
        let observed_at_unix_ms = now_unix_ms();
        let repo_id = fresh_token("repo")?;
        let generation = fresh_token("gen")?;
        if cancelled.load(Ordering::Acquire) || intent != self.latest_open_intent {
            self.pending_opens.remove(&intent);
            return Err(SessionError::new(
                ErrorCode::Cancelled,
                "Repository open was cancelled or superseded",
            ));
        }
        // The server serializes session mutations on its main loop. This is the
        // open commit point: cancellation and newer intents are checked before
        // persistence, and the session is published after the store call.
        let stored = self.store.open_repository(
            &discovered.info,
            &repository_key,
            &worktree_id,
            observed_at_unix_ms,
        );

        let info = RepositorySessionInfo {
            repo_id,
            generation,
            repository_key,
            worktree_id,
            scope: RepositoryScope::Head,
            observed_at_unix_ms,
            repository: discovered.info.clone(),
            previous_view: stored.previous_view,
            persistence: SessionPersistenceStatus {
                recent: stored.recent_status,
                last_seen: stored.last_seen_status,
            },
        };
        let session = Arc::new(RepositorySession { info, discovered });
        let replaced_repo_id = self
            .current
            .replace(Arc::clone(&session))
            .map(|previous| previous.info.repo_id.clone());
        self.pending_opens.remove(&intent);
        Ok(SessionCommit {
            session,
            replaced_repo_id,
        })
    }

    pub fn require_current(
        &self,
        repo_id: &str,
        generation: &str,
    ) -> Result<Arc<RepositorySession>, SessionError> {
        self.current
            .as_ref()
            .filter(|session| {
                session.info.repo_id == repo_id && session.info.generation == generation
            })
            .map(Arc::clone)
            .ok_or_else(|| {
                SessionError::new(ErrorCode::StaleContext, "Repository session is stale")
            })
    }

    pub fn record_view(
        &self,
        repo_id: &str,
        generation: &str,
    ) -> Result<(bool, StoreStatus), SessionError> {
        let session = self.require_current(repo_id, generation)?;
        let result = self.store.record_view(&session.info);
        Ok((result.saved, result.status))
    }

    pub fn close(&mut self, repo_id: &str, generation: &str) -> Result<String, SessionError> {
        let session = self.require_current(repo_id, generation)?;
        self.cancel_pending_opens();
        self.current = None;
        Ok(session.info.repo_id.clone())
    }

    pub fn recent(&self) -> (Vec<RecentRepository>, StoreStatus) {
        self.store.recent()
    }

    pub fn cancel_pending_opens(&mut self) {
        self.latest_open_intent = self.latest_open_intent.wrapping_add(1).max(1);
        for pending in self.pending_opens.values() {
            pending.store(true, Ordering::Release);
        }
        self.pending_opens.clear();
    }
}

pub struct SessionError {
    pub code: ErrorCode,
    pub message: String,
}

impl SessionError {
    fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

fn repository_key(discovered: &DiscoveredRepository) -> Result<String, SessionError> {
    let mut hash = Sha256::new();
    hash.update(b"commitscope:repository:v1\0");
    hash_field(&mut hash, &discovered.info.common_dir);
    hash_field(&mut hash, &discovered.info.object_format);
    Ok(format!("sha256:{}", encode_hex(&hash.finalize())))
}

fn worktree_id(
    repository_key: &str,
    discovered: &DiscoveredRepository,
) -> Result<String, SessionError> {
    let mut hash = Sha256::new();
    hash.update(b"commitscope:worktree:v1\0");
    hash_field(&mut hash, repository_key);
    hash_field(&mut hash, &discovered.info.git_dir);
    Ok(format!("sha256:{}", encode_hex(&hash.finalize())))
}

fn hash_field(hash: &mut Sha256, field: &str) {
    hash.update((field.len() as u64).to_be_bytes());
    hash.update(field.as_bytes());
}

fn fresh_token(prefix: &str) -> Result<String, SessionError> {
    let mut random = [0u8; 32];
    getrandom::fill(&mut random).map_err(|_| {
        SessionError::new(
            ErrorCode::RepositoryUnavailable,
            "Could not create a unique repository session identifier",
        )
    })?;
    Ok(format!("{prefix}:{}", encode_hex(&random)))
}

fn encode_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}
