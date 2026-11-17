//! Reversible displacement of untracked paths that block a current-branch fast-forward.
//!
//! Backup data lives in application data. The worktree is only changed after every backup has
//! been copied, synced, and checked against the snapshot collected by the read-only preflight.

use std::{
    collections::HashSet,
    ffi::{OsStr, OsString},
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

use commitscope_core::{ErrorCode, UntrackedOutcome};
#[cfg(any(target_os = "linux", target_os = "macos"))]
use rustix::fs::RenameFlags;
#[cfg(unix)]
use rustix::fs::{AtFlags, Mode, OFlags};

use super::{OperationResult, operation_error, untracked::Candidate};
use crate::{session::RepositorySession, session_store::SessionStore};

static BACKUP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

struct Entry {
    original: PathBuf,
    parent: File,
    leaf: OsString,
    backup: PathBuf,
    snapshot: Candidate,
    permissions: Option<u32>,
}

pub(super) struct Displacement {
    worktree: PathBuf,
    entries: Vec<Entry>,
    backup_dir: Option<PathBuf>,
    identical_count: u32,
}

impl Displacement {
    /// Put backed-up files back without replacing anything created since displacement.
    pub(super) fn restore(self) -> OperationResult<()> {
        let mut failures = Vec::new();
        for entry in self.entries.iter().rev() {
            if !same_worktree_parent(&self.worktree, &entry.original, &entry.parent) {
                failures.push(entry.original.clone());
                continue;
            }
            if !matches!(
                matches_snapshot(&entry.backup, &entry.snapshot, entry.permissions),
                Ok(true)
            ) {
                failures.push(entry.original.clone());
                continue;
            }
            if restore_copy_at(
                &entry.backup,
                &entry.parent,
                &entry.leaf,
                &entry.snapshot,
                entry.permissions,
            )
            .is_err()
                || !same_worktree_parent(&self.worktree, &entry.original, &entry.parent)
            {
                failures.push(entry.original.clone());
            }
        }
        if failures.is_empty() {
            if let Some(directory) = &self.backup_dir {
                fs::remove_dir_all(directory).map_err(|_| {
                    recovery_error(Some(directory), "本地文件已恢复，但无法清理应用数据备份")
                })?;
            }
            return Ok(());
        }
        Err(recovery_error(
            self.backup_dir.as_deref(),
            &format!(
                "无法恢复 {} 个本地文件；原副本仍保存在应用数据备份中",
                failures.len()
            ),
        ))
    }

    /// Release rollback copies after verifying the new HEAD; keep only the backups requested by the user.
    pub(super) fn finish(self, discard: bool) -> OperationResult<UntrackedOutcome> {
        let differing = self
            .entries
            .iter()
            .filter(|entry| !entry.snapshot.identical)
            .count() as u32;
        let keep_backup = !discard && differing > 0;
        for entry in self
            .entries
            .iter()
            .filter(|entry| discard || entry.snapshot.identical)
        {
            fs::remove_file(&entry.backup).map_err(|_| {
                recovery_error(self.backup_dir.as_deref(), "快进已完成，但无法清理临时副本")
            })?;
            remove_empty_backup_parents(entry.backup.parent(), self.backup_dir.as_deref());
        }
        if !keep_backup && let Some(path) = &self.backup_dir {
            fs::remove_dir(path)
                .map_err(|_| recovery_error(Some(path), "快进已完成，但无法清理临时备份目录"))?;
        }
        Ok(UntrackedOutcome {
            identical_count: self.identical_count,
            backed_up_count: if keep_backup { differing } else { 0 },
            discarded_count: if discard { differing } else { 0 },
            backup_dir: if keep_backup {
                self.backup_dir
                    .as_ref()
                    .map(|path| path.to_string_lossy().into_owned())
            } else {
                None
            },
        })
    }

    pub(super) fn recovery_path(&self) -> &Path {
        self.backup_dir.as_deref().unwrap_or(&self.worktree)
    }
}

pub(super) fn displace(
    session: &RepositorySession,
    files: Vec<Candidate>,
) -> OperationResult<Displacement> {
    let worktree = PathBuf::from(&session.discovered.info.path)
        .canonicalize()
        .map_err(|_| unsafe_error("无法验证工作区路径"))?;
    let mut seen = HashSet::new();
    let mut candidates = Vec::new();
    let mut identical_count = 0u32;
    for candidate in files {
        let relative = validate_relative_path(&candidate.raw)?;
        if !seen.insert(candidate.raw.clone()) {
            return Err(unsafe_error("同名未跟踪文件清单包含重复路径"));
        }
        let original = worktree.join(&relative);
        let (parent, leaf) = open_worktree_parent(&worktree, &relative)?;
        if !matches_snapshot_at(&parent, &leaf, &candidate, None)? {
            return Err(unsafe_error("同名未跟踪文件在操作前发生变化，请重新检查"));
        }
        if candidate.identical {
            identical_count = identical_count.saturating_add(1);
        }
        let permissions = file_mode_at(&parent, &leaf, &candidate)?;
        candidates.push((original, parent, leaf, candidate, permissions));
    }

    if candidates.is_empty() {
        return Ok(Displacement {
            worktree,
            entries: Vec::new(),
            backup_dir: None,
            identical_count,
        });
    }

    let store = SessionStore::from_env();
    let backup_root = store
        .backup_root(&session.discovered.info)
        .map_err(|_| unsafe_error("应用数据目录不可用或与仓库重叠"))?;
    let backups = ensure_directory(&backup_root)?;
    let repository_component = repository_key_component(&session.info.repository_key)?;
    let repository_dir = ensure_directory(&backups.join(repository_component))?;
    let backup_dir = create_unique_backup_dir(&repository_dir)?;

    let mut entries = Vec::with_capacity(candidates.len());
    for (original, parent, leaf, snapshot, permissions) in candidates {
        let backup = backup_dir.join(validate_relative_path(&snapshot.raw)?);
        if let Err(error) = copy_to_backup(&parent, &leaf, &backup, &snapshot, permissions) {
            // No worktree paths have been moved yet; partial copies are not recovery data.
            let _ = fs::remove_dir_all(&backup_dir);
            return Err(error);
        }
        entries.push(Entry {
            original,
            parent,
            leaf,
            backup,
            snapshot,
            permissions,
        });
    }
    sync_directory(&backup_dir)?;

    let mut moved = Vec::<(usize, Option<OsString>)>::new();
    for (index, entry) in entries.iter().enumerate() {
        // Rename into a same-directory temporary name first. Validate the moved inode before
        // deleting it, so a concurrent replacement at the original path is never unlinked.
        if !same_worktree_parent(&worktree, &entry.original, &entry.parent) {
            return Err(rollback(
                &entries,
                &moved,
                &backup_dir,
                None,
                unsafe_error("工作区路径在操作期间发生变化"),
            ));
        }
        let staged = match unique_sibling(&entry.original).and_then(|staged| {
            rename_noreplace_at(&entry.parent, &entry.leaf, &entry.parent, &staged)
                .map_err(|_| unsafe_error("无法安全移走本地文件"))?;
            Ok(staged)
        }) {
            Ok(staged) => staged,
            Err(error) => return Err(rollback(&entries, &moved, &backup_dir, None, error)),
        };
        let validated =
            matches_snapshot_at(&entry.parent, &staged, &entry.snapshot, entry.permissions);
        if !matches!(validated, Ok(true)) {
            let staged_recovery =
                if rename_noreplace_at(&entry.parent, &staged, &entry.parent, &entry.leaf).is_err()
                {
                    Some((index, Some(staged)))
                } else {
                    None
                };
            return Err(rollback(
                &entries,
                &moved,
                &backup_dir,
                staged_recovery,
                unsafe_error("同名未跟踪文件在移走时发生变化，请重新检查"),
            ));
        }
        if unlinkat(&entry.parent, &staged).is_err() {
            return Err(rollback(
                &entries,
                &moved,
                &backup_dir,
                Some((index, Some(staged))),
                unsafe_error("已备份的本地文件无法从工作区移走"),
            ));
        }
        moved.push((index, None));
        if !same_worktree_parent(&worktree, &entry.original, &entry.parent) {
            return Err(rollback(
                &entries,
                &moved,
                &backup_dir,
                None,
                unsafe_error("工作区路径在操作期间发生变化"),
            ));
        }
    }

    Ok(Displacement {
        worktree,
        entries,
        backup_dir: Some(backup_dir),
        identical_count,
    })
}

fn copy_to_backup(
    source_parent: &File,
    source_leaf: &OsStr,
    destination: &Path,
    snapshot: &Candidate,
    permissions: Option<u32>,
) -> OperationResult<()> {
    ensure_parent_directories(destination)?;
    match snapshot.mode {
        0o120000 => {
            let target = path_from_bytes(&snapshot.data)?;
            symlink(&target, destination).map_err(|_| unsafe_error("无法保存本地符号链接"))?;
            sync_directory(
                destination
                    .parent()
                    .ok_or_else(|| unsafe_error("备份路径无父目录"))?,
            )?;
        }
        0o100644 | 0o100755 => {
            let source_file = openat_read_nofollow(source_parent, source_leaf)?;
            let mut output = create_private_file(destination)?;
            let mut copied = Vec::new();
            source_file
                .take(snapshot.data.len() as u64 + 1)
                .read_to_end(&mut copied)
                .map_err(|_| unsafe_error("无法读取待备份文件"))?;
            output
                .write_all(&copied)
                .and_then(|_| output.sync_all())
                .map_err(|_| unsafe_error("无法持久化本地备份"))?;
            if copied != snapshot.data {
                return Err(unsafe_error("文件在备份时发生变化，请重新检查"));
            }
            #[cfg(unix)]
            if let Some(mode) = permissions {
                use std::os::unix::fs::PermissionsExt;
                output
                    .set_permissions(fs::Permissions::from_mode(mode))
                    .map_err(|_| unsafe_error("无法保留本地文件权限"))?;
            }
            File::open(destination)
                .and_then(|file| file.sync_all())
                .map_err(|_| unsafe_error("无法验证持久化本地备份"))?;
        }
        _ => return Err(unsafe_error("不支持备份这种文件类型")),
    }
    if !matches_snapshot(destination, snapshot, permissions)? {
        return Err(unsafe_error("本地备份校验失败"));
    }
    Ok(())
}

fn restore_copy_at(
    source: &Path,
    destination_parent: &File,
    destination_leaf: &OsStr,
    snapshot: &Candidate,
    permissions: Option<u32>,
) -> OperationResult<()> {
    match snapshot.mode {
        0o120000 => {
            let target = path_from_bytes(&snapshot.data)?;
            symlinkat(&target, destination_parent, destination_leaf)
                .map_err(|_| unsafe_error("恢复位置已出现新文件，保留应用数据备份"))?;
        }
        0o100644 | 0o100755 => {
            let input = open_read_nofollow(source)?;
            let mut output = create_private_file_at(destination_parent, destination_leaf)?;
            let mut copied = Vec::new();
            input
                .take(snapshot.data.len() as u64 + 1)
                .read_to_end(&mut copied)
                .map_err(|_| unsafe_error("应用数据备份无法读取"))?;
            if copied != snapshot.data {
                return Err(unsafe_error("应用数据备份内容发生变化"));
            }
            output
                .write_all(&copied)
                .and_then(|_| output.sync_all())
                .map_err(|_| unsafe_error("无法恢复本地文件"))?;
            #[cfg(unix)]
            if let Some(mode) = permissions {
                use std::os::unix::fs::PermissionsExt;
                output
                    .set_permissions(fs::Permissions::from_mode(mode))
                    .map_err(|_| unsafe_error("无法恢复本地文件权限"))?;
            }
        }
        _ => return Err(unsafe_error("无法恢复不支持的文件类型")),
    }
    if !matches_snapshot_at(destination_parent, destination_leaf, snapshot, permissions)? {
        return Err(unsafe_error("恢复后的文件与备份不一致"));
    }
    destination_parent
        .sync_all()
        .map_err(|_| unsafe_error("无法持久化恢复后的本地文件"))?;
    Ok(())
}

fn matches_snapshot(
    path: &Path,
    snapshot: &Candidate,
    permissions: Option<u32>,
) -> OperationResult<bool> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(_) => return Err(unsafe_error("无法检查同名未跟踪文件")),
    };
    match snapshot.mode {
        0o120000 if metadata.file_type().is_symlink() => {
            let target = fs::read_link(path).map_err(|_| unsafe_error("无法读取本地符号链接"))?;
            Ok(path_bytes(&target) == snapshot.data)
        }
        0o100644 | 0o100755 if metadata.is_file() && !metadata.file_type().is_symlink() => {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if ((metadata.permissions().mode() & 0o100) != 0) != (snapshot.mode == 0o100755) {
                    return Ok(false);
                }
                if let Some(expected) = permissions
                    && metadata.permissions().mode() & 0o7777 != expected
                {
                    return Ok(false);
                }
            }
            let mut bytes = Vec::new();
            let file = open_read_nofollow(path)?;
            file.take(snapshot.data.len() as u64 + 1)
                .read_to_end(&mut bytes)
                .map_err(|_| unsafe_error("无法读取本地文件"))?;
            Ok(bytes == snapshot.data)
        }
        _ => Ok(false),
    }
}

fn matches_snapshot_at(
    parent: &File,
    leaf: &OsStr,
    snapshot: &Candidate,
    permissions: Option<u32>,
) -> OperationResult<bool> {
    match snapshot.mode {
        0o120000 => {
            let target = readlinkat(parent, leaf)?;
            Ok(target.as_deref() == Some(snapshot.data.as_slice()))
        }
        0o100644 | 0o100755 => {
            let file = match openat_read_nofollow(parent, leaf) {
                Ok(file) => file,
                Err(error) if error.code == ErrorCode::RepositoryUnavailable => return Ok(false),
                Err(error) => return Err(error),
            };
            let metadata = file
                .metadata()
                .map_err(|_| unsafe_error("无法检查本地文件"))?;
            if !metadata.is_file() {
                return Ok(false);
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mode = metadata.permissions().mode();
                if ((mode & 0o100) != 0) != (snapshot.mode == 0o100755) {
                    return Ok(false);
                }
                if let Some(expected) = permissions
                    && mode & 0o7777 != expected
                {
                    return Ok(false);
                }
            }
            let mut bytes = Vec::new();
            file.take(snapshot.data.len() as u64 + 1)
                .read_to_end(&mut bytes)
                .map_err(|_| unsafe_error("无法读取本地文件"))?;
            Ok(bytes == snapshot.data)
        }
        _ => Ok(false),
    }
}

fn file_mode_at(
    parent: &File,
    leaf: &OsStr,
    candidate: &Candidate,
) -> OperationResult<Option<u32>> {
    if candidate.mode == 0o120000 {
        return Ok(None);
    }
    let file = openat_read_nofollow(parent, leaf)?;
    let metadata = file
        .metadata()
        .map_err(|_| unsafe_error("无法读取待备份文件权限"))?;
    if !metadata.is_file() {
        return Err(unsafe_error("待备份路径不再是普通文件"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        Ok(Some(metadata.permissions().mode() & 0o7777))
    }
    #[cfg(not(unix))]
    {
        Ok(None)
    }
}

fn validate_relative_path(raw: &[u8]) -> OperationResult<PathBuf> {
    if raw.is_empty() || raw.contains(&0) || raw.first() == Some(&b'/') {
        return Err(unsafe_error("未跟踪文件路径不安全"));
    }
    let mut result = PathBuf::new();
    for part in raw.split(|byte| *byte == b'/') {
        if part.is_empty() || part == b"." || part == b".." || part.eq_ignore_ascii_case(b".git") {
            return Err(unsafe_error("未跟踪文件路径不安全"));
        }
        result.push(path_from_bytes(part)?);
    }
    if result
        .components()
        .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err(unsafe_error("未跟踪文件路径不安全"));
    }
    Ok(result)
}

fn open_worktree_parent(root: &Path, relative: &Path) -> OperationResult<(File, OsString)> {
    let mut components = relative.components();
    let mut names = Vec::<OsString>::new();
    for component in components.by_ref() {
        let Component::Normal(name) = component else {
            return Err(unsafe_error("文件路径不安全"));
        };
        names.push(name.to_os_string());
    }
    let leaf = names
        .pop()
        .ok_or_else(|| unsafe_error("文件路径无文件名"))?;
    let mut directory = open_directory(root).map_err(|_| unsafe_error("无法安全打开工作区目录"))?;
    for name in names {
        directory = open_directory_at(&directory, &name)
            .map_err(|_| unsafe_error("拒绝沿符号链接或非目录穿越工作区"))?;
    }
    Ok((directory, leaf))
}

fn same_worktree_parent(root: &Path, original: &Path, pinned: &File) -> bool {
    let Some(relative) = original.strip_prefix(root).ok() else {
        return false;
    };
    let Some(parent) = relative.parent() else {
        return false;
    };
    let Ok((current, _)) = open_worktree_parent(root, &parent.join("__commitscope_parent_probe__"))
    else {
        return false;
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        matches!((current.metadata(), pinned.metadata()), (Ok(a), Ok(b)) if a.dev() == b.dev() && a.ino() == b.ino())
    }
    #[cfg(not(unix))]
    {
        false
    }
}

fn ensure_parent_directories(path: &Path) -> OperationResult<()> {
    let parent = path
        .parent()
        .ok_or_else(|| unsafe_error("备份路径无父目录"))?;
    let mut cursor = PathBuf::new();
    for component in parent.components() {
        cursor.push(component.as_os_str());
        if cursor.as_os_str().is_empty() {
            continue;
        }
        match fs::create_dir(&cursor) {
            Ok(()) => sync_directory(cursor.parent().unwrap_or(Path::new("/")))?,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(_) => return Err(unsafe_error("无法创建应用数据备份目录")),
        }
        let metadata =
            fs::symlink_metadata(&cursor).map_err(|_| unsafe_error("无法检查应用数据备份目录"))?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(unsafe_error("应用数据备份目录不安全"));
        }
    }
    Ok(())
}

fn ensure_directory(path: &Path) -> OperationResult<PathBuf> {
    ensure_parent_directories(path)?;
    match fs::create_dir(path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(_) => return Err(unsafe_error("无法创建应用数据备份目录")),
    }
    let metadata = fs::symlink_metadata(path).map_err(|_| unsafe_error("无法检查应用数据目录"))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(unsafe_error("应用数据备份目录不安全"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|_| unsafe_error("无法保护应用数据备份目录"))?;
    }
    let canonical = fs::canonicalize(path).map_err(|_| unsafe_error("无法验证应用数据目录"))?;
    if canonical != path {
        return Err(unsafe_error("应用数据备份目录被替换"));
    }
    Ok(canonical)
}

fn create_unique_backup_dir(parent: &Path) -> OperationResult<PathBuf> {
    let now = chrono::Utc::now().format("%Y%m%dT%H%M%S%.3fZ");
    for _ in 0..100 {
        let sequence = BACKUP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let path = parent.join(format!("{now}-{sequence:06}"));
        match fs::create_dir(&path) {
            Ok(()) => {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    fs::set_permissions(&path, fs::Permissions::from_mode(0o700))
                        .map_err(|_| unsafe_error("无法保护本地备份目录"))?;
                }
                sync_directory(parent)?;
                return Ok(path);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => return Err(unsafe_error("无法创建本地备份目录")),
        }
    }
    Err(unsafe_error("无法分配唯一的本地备份目录"))
}

fn remove_empty_backup_parents(mut parent: Option<&Path>, stop: Option<&Path>) {
    while let (Some(path), Some(stop_path)) = (parent, stop) {
        if path == stop_path || !path.starts_with(stop_path) {
            break;
        }
        if fs::remove_dir(path).is_err() {
            break;
        }
        parent = path.parent();
    }
}

fn unique_sibling(path: &Path) -> OperationResult<OsString> {
    path.parent()
        .ok_or_else(|| unsafe_error("文件路径无父目录"))?;
    path.file_name()
        .ok_or_else(|| unsafe_error("文件路径无文件名"))?;
    for _ in 0..32 {
        let sequence = BACKUP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let staged = OsString::from(format!(
            ".commitscope-displaced-{}-{sequence}",
            std::process::id()
        ));
        if path
            .parent()
            .expect("parent checked")
            .join(&staged)
            .symlink_metadata()
            .is_err()
        {
            return Ok(staged);
        }
    }
    Err(unsafe_error("无法分配安全的临时文件名"))
}

fn create_private_file(path: &Path) -> OperationResult<File> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        OpenOptions::new()
            .write(true)
            .read(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(path)
            .map_err(|_| unsafe_error("无法安全创建本地备份文件"))
    }
    #[cfg(not(unix))]
    {
        OpenOptions::new()
            .write(true)
            .read(true)
            .create_new(true)
            .open(path)
            .map_err(|_| unsafe_error("无法安全创建本地备份文件"))
    }
}

#[cfg(unix)]
fn open_directory(path: &Path) -> std::io::Result<File> {
    rustix::fs::open(
        path,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .map(File::from)
    .map_err(std::io::Error::from)
}

#[cfg(unix)]
fn open_directory_at(parent: &File, name: &OsStr) -> std::io::Result<File> {
    rustix::fs::openat(
        parent,
        name,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .map(File::from)
    .map_err(std::io::Error::from)
}

#[cfg(not(unix))]
fn open_directory(_path: &Path) -> std::io::Result<File> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "safe directory handles are unsupported",
    ))
}

#[cfg(not(unix))]
fn open_directory_at(_parent: &File, _name: &OsStr) -> std::io::Result<File> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "safe directory handles are unsupported",
    ))
}

#[cfg(unix)]
fn openat_read_nofollow(parent: &File, name: &OsStr) -> OperationResult<File> {
    rustix::fs::openat(
        parent,
        name,
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .map(File::from)
    .map_err(|_| unsafe_error("无法安全读取本地文件"))
}

#[cfg(not(unix))]
fn openat_read_nofollow(_parent: &File, _name: &OsStr) -> OperationResult<File> {
    Err(unsafe_error("当前平台不支持安全文件读取"))
}

#[cfg(unix)]
fn create_private_file_at(parent: &File, name: &OsStr) -> OperationResult<File> {
    rustix::fs::openat(
        parent,
        name,
        OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::from_raw_mode(0o600),
    )
    .map(File::from)
    .map_err(|_| unsafe_error("恢复位置已出现新文件，保留应用数据备份"))
}

#[cfg(not(unix))]
fn create_private_file_at(_parent: &File, _name: &OsStr) -> OperationResult<File> {
    Err(unsafe_error("当前平台不支持安全文件恢复"))
}

#[cfg(unix)]
fn symlinkat(target: &Path, parent: &File, name: &OsStr) -> std::io::Result<()> {
    rustix::fs::symlinkat(target, parent, name).map_err(std::io::Error::from)
}

#[cfg(not(unix))]
fn symlinkat(_target: &Path, _parent: &File, _name: &OsStr) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "safe symlink restore is unsupported",
    ))
}

#[cfg(unix)]
fn readlinkat(parent: &File, name: &OsStr) -> OperationResult<Option<Vec<u8>>> {
    match rustix::fs::readlinkat(parent, name, Vec::new()) {
        Ok(target) => Ok(Some(target.into_bytes())),
        Err(rustix::io::Errno::INVAL | rustix::io::Errno::NOENT) => Ok(None),
        Err(_) => Err(unsafe_error("无法读取本地符号链接")),
    }
}

#[cfg(not(unix))]
fn readlinkat(_parent: &File, _name: &OsStr) -> OperationResult<Option<Vec<u8>>> {
    Err(unsafe_error("当前平台不支持安全符号链接读取"))
}

#[cfg(unix)]
fn unlinkat(parent: &File, name: &OsStr) -> std::io::Result<()> {
    rustix::fs::unlinkat(parent, name, AtFlags::empty()).map_err(std::io::Error::from)
}

#[cfg(not(unix))]
fn unlinkat(_parent: &File, _name: &OsStr) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "safe unlink is unsupported",
    ))
}

fn sync_directory(path: &Path) -> OperationResult<()> {
    File::open(path)
        .and_then(|file| file.sync_all())
        .map_err(|_| unsafe_error("无法持久化备份目录"))
}

fn open_read_nofollow(path: &Path) -> OperationResult<File> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(path)
            .map_err(|_| unsafe_error("无法安全读取本地文件"))
    }
    #[cfg(not(unix))]
    {
        OpenOptions::new()
            .read(true)
            .open(path)
            .map_err(|_| unsafe_error("无法安全读取本地文件"))
    }
}

fn rollback(
    entries: &[Entry],
    moved: &[(usize, Option<OsString>)],
    backup_dir: &Path,
    current_stage: Option<(usize, Option<OsString>)>,
    cause: crate::details::DetailError,
) -> crate::details::DetailError {
    let mut incomplete = Vec::new();
    if let Some((index, Some(staged))) = current_stage {
        let entry = &entries[index];
        if rename_noreplace_at(&entry.parent, &staged, &entry.parent, &entry.leaf).is_err() {
            incomplete.push(format!(
                "{}（临时副本：{}）",
                entry.original.display(),
                entry
                    .original
                    .parent()
                    .unwrap_or(Path::new("."))
                    .join(&staged)
                    .display()
            ));
        }
    }
    for (index, staged) in moved.iter().rev() {
        let entry = &entries[*index];
        let result = match staged {
            Some(path) => rename_noreplace_at(&entry.parent, path, &entry.parent, &entry.leaf)
                .map_err(|_| unsafe_error("恢复位置已出现新文件，临时副本仍保留")),
            None => restore_copy_at(
                &entry.backup,
                &entry.parent,
                &entry.leaf,
                &entry.snapshot,
                entry.permissions,
            ),
        };
        if result.is_err() {
            incomplete.push(entry.original.display().to_string());
        }
    }
    if incomplete.is_empty() {
        let _ = fs::remove_dir_all(backup_dir);
        return cause;
    }
    operation_error(
        ErrorCode::GitError,
        &format!(
            "{}；{} 个文件未能自动放回（{}），备份保留在 {}",
            cause.message,
            incomplete.len(),
            incomplete.join("、"),
            backup_dir.display()
        ),
    )
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn rename_noreplace_at(
    from_dir: &File,
    from: &OsStr,
    to_dir: &File,
    to: &OsStr,
) -> std::io::Result<()> {
    rustix::fs::renameat_with(from_dir, from, to_dir, to, RenameFlags::NOREPLACE)
        .map_err(std::io::Error::from)
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn rename_noreplace_at(
    _from_dir: &File,
    _from: &OsStr,
    _to_dir: &File,
    _to: &OsStr,
) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "no-replace rename is unsupported",
    ))
}

fn path_from_bytes(bytes: &[u8]) -> OperationResult<PathBuf> {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        Ok(PathBuf::from(std::ffi::OsStr::from_bytes(bytes)))
    }
    #[cfg(not(unix))]
    {
        String::from_utf8(bytes.to_vec())
            .map(PathBuf::from)
            .map_err(|_| unsafe_error("当前平台不支持该原始路径"))
    }
}

fn path_bytes(path: &Path) -> Vec<u8> {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        path.as_os_str().as_bytes().to_vec()
    }
    #[cfg(not(unix))]
    {
        path.to_string_lossy().as_bytes().to_vec()
    }
}

#[cfg(unix)]
fn symlink(target: &Path, link: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}
#[cfg(not(unix))]
fn symlink(_target: &Path, _link: &Path) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "symlinks unsupported",
    ))
}

fn repository_key_component(key: &str) -> OperationResult<String> {
    let suffix = key
        .strip_prefix("sha256:")
        .ok_or_else(|| unsafe_error("仓库身份格式无效"))?;
    if suffix.len() != 64 || !suffix.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(unsafe_error("仓库身份格式无效"));
    }
    Ok(format!("sha256-{}", suffix.to_ascii_lowercase()))
}

fn unsafe_error(message: &str) -> crate::details::DetailError {
    operation_error(ErrorCode::RepositoryUnavailable, message)
}

fn recovery_error(directory: Option<&Path>, message: &str) -> crate::details::DetailError {
    let message = match directory {
        Some(path) => format!("{message}。备份位置：{}", path.display()),
        None => message.to_owned(),
    };
    operation_error(ErrorCode::GitError, &message)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestDir(PathBuf);

    impl TestDir {
        fn new(label: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "commitscope-untracked-backup-{label}-{}-{}",
                std::process::id(),
                BACKUP_SEQUENCE.fetch_add(1, Ordering::Relaxed),
            ));
            let _ = fs::remove_dir_all(&path);
            fs::create_dir_all(&path).unwrap();
            Self(fs::canonicalize(path).unwrap())
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn candidate(data: &[u8]) -> Candidate {
        Candidate {
            raw: b"nested/file.txt".to_vec(),
            data: data.to_vec(),
            mode: 0o100644,
            identical: false,
            difference: None,
        }
    }

    #[test]
    fn restore_never_overwrites_a_concurrent_file_and_keeps_the_backup() {
        let temp = TestDir::new("concurrent-restore");
        let worktree = temp.0.join("worktree");
        let backup_dir = temp.0.join("backup");
        fs::create_dir_all(worktree.join("nested")).unwrap();
        fs::create_dir_all(backup_dir.join("nested")).unwrap();
        let destination = worktree.join("nested/file.txt");
        let backup = backup_dir.join("nested/file.txt");
        let local = candidate(b"local copy");
        fs::write(&backup, &local.data).unwrap();
        fs::write(&destination, b"concurrent version").unwrap();
        let parent = open_directory(&worktree.join("nested")).unwrap();

        let result = restore_copy_at(
            &backup,
            &parent,
            OsStr::new("file.txt"),
            &local,
            Some(0o644),
        );

        assert!(result.is_err());
        assert_eq!(fs::read(&destination).unwrap(), b"concurrent version");
        assert_eq!(fs::read(&backup).unwrap(), b"local copy");
    }

    #[test]
    fn failed_restore_reports_and_preserves_recovery_copy() {
        let temp = TestDir::new("restore-retained");
        let worktree = temp.0.join("worktree");
        let backup_dir = temp.0.join("backup");
        fs::create_dir_all(worktree.join("nested")).unwrap();
        fs::create_dir_all(backup_dir.join("nested")).unwrap();
        let destination = worktree.join("nested/file.txt");
        let backup = backup_dir.join("nested/file.txt");
        let local = candidate(b"local copy");
        fs::write(&backup, &local.data).unwrap();
        fs::write(&destination, b"new concurrent file").unwrap();
        let parent = open_directory(&worktree.join("nested")).unwrap();
        let displacement = Displacement {
            worktree,
            entries: vec![Entry {
                original: destination.clone(),
                parent,
                leaf: OsString::from("file.txt"),
                backup: backup.clone(),
                snapshot: local,
                permissions: Some(0o644),
            }],
            backup_dir: Some(backup_dir.clone()),
            identical_count: 0,
        };

        let error = displacement.restore().unwrap_err();

        assert!(error.message.contains(&backup_dir.display().to_string()));
        assert_eq!(fs::read(destination).unwrap(), b"new concurrent file");
        assert_eq!(fs::read(backup).unwrap(), b"local copy");
    }

    #[test]
    fn finish_retains_only_differing_file_copies() {
        let temp = TestDir::new("finish-differing-only");
        let backup_dir = temp.0.join("backup");
        fs::create_dir_all(&backup_dir).unwrap();
        let identical_backup = backup_dir.join("same.txt");
        let differing_backup = backup_dir.join("different.txt");
        fs::write(&identical_backup, b"same").unwrap();
        fs::write(&differing_backup, b"local").unwrap();
        let displacement = Displacement {
            worktree: temp.0.join("worktree"),
            entries: vec![
                Entry {
                    original: PathBuf::from("same.txt"),
                    parent: open_directory(&backup_dir).unwrap(),
                    leaf: OsString::from("same.txt"),
                    backup: identical_backup.clone(),
                    snapshot: Candidate {
                        raw: b"same.txt".to_vec(),
                        data: b"same".to_vec(),
                        mode: 0o100644,
                        identical: true,
                        difference: None,
                    },
                    permissions: Some(0o644),
                },
                Entry {
                    original: PathBuf::from("different.txt"),
                    parent: open_directory(&backup_dir).unwrap(),
                    leaf: OsString::from("different.txt"),
                    backup: differing_backup.clone(),
                    snapshot: Candidate {
                        raw: b"different.txt".to_vec(),
                        data: b"local".to_vec(),
                        mode: 0o100644,
                        identical: false,
                        difference: None,
                    },
                    permissions: Some(0o644),
                },
            ],
            backup_dir: Some(backup_dir.clone()),
            identical_count: 1,
        };

        let result = displacement.finish(false).unwrap();

        assert_eq!(result.identical_count, 1);
        assert_eq!(result.backed_up_count, 1);
        assert_eq!(
            result.backup_dir.as_deref(),
            Some(backup_dir.to_string_lossy().as_ref())
        );
        assert!(!identical_backup.exists());
        assert_eq!(fs::read(differing_backup).unwrap(), b"local");
    }

    #[test]
    fn swapped_parent_does_not_receive_a_restore_write() {
        let temp = TestDir::new("swapped-parent");
        let worktree = temp.0.join("worktree");
        let backup_dir = temp.0.join("backup");
        fs::create_dir_all(worktree.join("nested")).unwrap();
        fs::create_dir_all(&backup_dir).unwrap();
        let original = worktree.join("nested/file.txt");
        let backup = backup_dir.join("file.txt");
        let local = candidate(b"local copy");
        fs::write(&backup, &local.data).unwrap();
        let (parent, leaf) = open_worktree_parent(&worktree, Path::new("nested/file.txt")).unwrap();
        let parked = worktree.join("parked");
        fs::rename(worktree.join("nested"), &parked).unwrap();
        fs::create_dir(worktree.join("nested")).unwrap();
        fs::write(&original, b"concurrent version").unwrap();
        let displacement = Displacement {
            worktree: worktree.clone(),
            entries: vec![Entry {
                original,
                parent,
                leaf,
                backup: backup.clone(),
                snapshot: local,
                permissions: Some(0o644),
            }],
            backup_dir: Some(backup_dir.clone()),
            identical_count: 0,
        };

        assert!(displacement.restore().is_err());

        assert_eq!(
            fs::read(worktree.join("nested/file.txt")).unwrap(),
            b"concurrent version"
        );
        assert_eq!(fs::read(backup).unwrap(), b"local copy");
        assert!(!parked.join("file.txt").exists());
    }

    #[test]
    fn backup_and_restore_preserve_nondefault_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let temp = TestDir::new("permissions");
        let worktree = temp.0.join("worktree");
        let backup_root = temp.0.join("backups");
        fs::create_dir_all(worktree.join("nested")).unwrap();
        let source = worktree.join("nested/file.txt");
        fs::write(&source, b"private executable").unwrap();
        fs::set_permissions(&source, fs::Permissions::from_mode(0o750)).unwrap();
        let snapshot = Candidate {
            raw: b"nested/file.txt".to_vec(),
            data: b"private executable".to_vec(),
            mode: 0o100755,
            identical: false,
            difference: None,
        };
        let (parent, leaf) = open_worktree_parent(&worktree, Path::new("nested/file.txt")).unwrap();
        let mode = file_mode_at(&parent, &leaf, &snapshot).unwrap();
        let backup = backup_root.join("nested/file.txt");
        copy_to_backup(&parent, &leaf, &backup, &snapshot, mode).unwrap();
        fs::remove_file(&source).unwrap();

        restore_copy_at(&backup, &parent, &leaf, &snapshot, mode).unwrap();

        assert_eq!(
            fs::metadata(source).unwrap().permissions().mode() & 0o7777,
            0o750
        );
    }
}
