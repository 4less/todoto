use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use chrono::{DateTime, Utc};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{Manager, State};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Note {
    pub id: String,
    pub title: String,
    pub content: String,
    #[serde(default)]
    pub folder: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub tags: Vec<String>,
    // Repo-relative path to the .md file (e.g. "folder/Title.md").
    // Not persisted in the file itself — computed at load/save time.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub file_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkSession {
    pub start: String,
    pub end: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Todo {
    pub id: String,
    pub title: String,
    pub done: bool,
    pub priority: Priority,
    pub due_date: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub started_at: Option<String>,
    #[serde(default)]
    pub finished_at: Option<String>,
    #[serde(default)]
    pub work_sessions: Vec<WorkSession>,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub note_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Priority {
    Low,
    Medium,
    High,
}

impl PartialOrd for Priority {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for Priority {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        fn rank(p: &Priority) -> u8 {
            match p {
                Priority::Low => 0,
                Priority::Medium => 1,
                Priority::High => 2,
            }
        }
        rank(self).cmp(&rank(other))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TodoData {
    pub todos: Vec<Todo>,
    pub version: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct LegacyAppData {
    #[serde(default)]
    pub notes: Vec<Note>,
    #[serde(default)]
    pub todos: Vec<Todo>,
    pub version: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Settings {
    pub repo_path: String,
    pub repo_url: String,
    // git_username and git_email are kept for settings.json backward-compat
    // but are no longer used by the GitHub API sync
    #[serde(default)]
    pub git_username: String,
    #[serde(default)]
    pub git_email: String,
    pub git_token: String,
    pub auto_sync: bool,
    pub sync_interval_seconds: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncResult {
    pub success: bool,
    pub message: String,
    pub timestamp: DateTime<Utc>,
}

#[derive(Serialize, Clone)]
pub struct CommitInfo {
    pub sha: String,
    pub date: String,
    pub message: String,
}

pub struct AppState {
    pub settings: Settings,
    pub settings_path: PathBuf,
    pub last_sync: Option<DateTime<Utc>>,
    pub syncing: Arc<AtomicBool>,
}

// ── Settings I/O ──────────────────────────────────────────────────────────────

fn load_settings_from_path(path: &Path) -> Settings {
    if path.exists() {
        fs::read_to_string(path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    } else {
        Settings {
            auto_sync: true,
            sync_interval_seconds: 300,
            ..Default::default()
        }
    }
}

fn save_settings_to_path(settings: &Settings, path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}

// ── Todos storage ─────────────────────────────────────────────────────────────

fn task_note_path(repo_base: &Path, todo_id: &str) -> PathBuf {
    repo_base.join("task-notes").join(format!("{todo_id}.md"))
}

fn todos_path(settings: &Settings) -> Option<PathBuf> {
    if settings.repo_path.is_empty() {
        None
    } else {
        Some(PathBuf::from(&settings.repo_path).join("todos.json"))
    }
}

fn load_todos(settings: &Settings) -> Vec<Todo> {
    let Some(path) = todos_path(settings) else { return vec![] };
    let todos = if path.exists() {
        fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str::<TodoData>(&s).ok())
            .map(|d| d.todos)
            .unwrap_or_default()
    } else {
        let legacy_path = PathBuf::from(&settings.repo_path).join("todoto-data.json");
        if legacy_path.exists() {
            fs::read_to_string(&legacy_path)
                .ok()
                .and_then(|s| serde_json::from_str::<LegacyAppData>(&s).ok())
                .map(|d| d.todos)
                .unwrap_or_default()
        } else {
            vec![]
        }
    };
    // Populate notes content from separate .md files (notes field is not in JSON)
    let repo_base = PathBuf::from(&settings.repo_path);
    todos.into_iter().map(|mut t| {
        if t.notes.is_none() {
            if let Some(ref rel_path) = t.note_path {
                t.notes = fs::read_to_string(repo_base.join(rel_path)).ok();
            } else {
                // Fallback: check task-notes/{id}.md even if note_path not set in JSON
                let fallback = task_note_path(&repo_base, &t.id);
                if fallback.exists() {
                    t.notes = fs::read_to_string(&fallback).ok();
                }
            }
        }
        t
    }).collect()
}

fn save_todos(settings: &Settings, todos: &[Todo]) -> Result<(), String> {
    let path = todos_path(settings).ok_or("No repo path configured")?;
    fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    let repo_base = PathBuf::from(&settings.repo_path);
    // Serialize todos, migrating any legacy inline notes to files and stripping
    // the `notes` field from JSON (it lives in separate .md files).
    let todo_values: Vec<serde_json::Value> = todos.iter().map(|todo| {
        let mut todo = todo.clone();
        if todo.notes.is_some() && todo.note_path.is_none() && !repo_base.as_os_str().is_empty() {
            if let Some(content) = &todo.notes {
                if !content.trim().is_empty() {
                    let note_file = task_note_path(&repo_base, &todo.id);
                    if let Some(parent) = note_file.parent() {
                        if fs::create_dir_all(parent).is_ok() && fs::write(&note_file, content).is_ok() {
                            if let Ok(rel) = note_file.strip_prefix(&repo_base) {
                                todo.note_path = Some(rel.to_string_lossy().replace('\\', "/"));
                            }
                        }
                    }
                }
            }
        }
        let mut v = serde_json::to_value(&todo).unwrap_or(serde_json::Value::Null);
        if let Some(obj) = v.as_object_mut() { obj.remove("notes"); }
        v
    }).collect();
    let data = serde_json::json!({ "todos": todo_values, "version": 1 });
    let json = serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())
}

// ── Note file storage (.md with YAML frontmatter) ─────────────────────────────

fn sanitize_filename(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            _ => c,
        })
        .collect::<String>()
        .trim()
        .to_string()
}

fn note_file_path(repo_base: &Path, note: &Note) -> PathBuf {
    let name = format!("{}.md", sanitize_filename(&note.title));
    if note.folder.is_empty() {
        repo_base.join(name)
    } else {
        repo_base.join(&note.folder).join(name)
    }
}

fn write_note_file(repo_base: &Path, note: &Note) -> Result<(), String> {
    let mut path = note_file_path(repo_base, note);
    fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;

    // Guard against silent overwrites: if a file already exists at this path
    // with a different ID, use a unique filename to avoid clobbering the other note.
    if path.exists() {
        let existing_raw = fs::read_to_string(&path).unwrap_or_default();
        let existing_id = existing_raw
            .lines()
            .find_map(|l| l.strip_prefix("id: "))
            .map(str::trim)
            .unwrap_or("");
        if !existing_id.is_empty() && existing_id != note.id {
            let short_id = &note.id[..note.id.len().min(8)];
            let name = format!("{}_{}.md", sanitize_filename(&note.title), short_id);
            path = if note.folder.is_empty() {
                repo_base.join(name)
            } else {
                repo_base.join(&note.folder).join(name)
            };
        }
    }

    let tags_str = note.tags.join(", ");
    let file_content = format!(
        "---\nid: {}\ntitle: {}\npinned: {}\ntags: {}\ncreated_at: {}\nupdated_at: {}\n---\n{}",
        note.id,
        note.title,
        note.pinned,
        tags_str,
        note.created_at.to_rfc3339(),
        note.updated_at.to_rfc3339(),
        note.content
    );
    fs::write(&path, file_content).map_err(|e| e.to_string())
}

fn parse_note_file(path: &Path, repo_base: &Path) -> Option<Note> {
    let raw = fs::read_to_string(path).ok()?;

    let (fm_str, body) = if raw.starts_with("---\n") {
        let rest = &raw[4..];
        if let Some(end) = rest.find("\n---\n") {
            (&rest[..end], &rest[end + 5..])
        } else {
            ("", raw.as_str())
        }
    } else {
        ("", raw.as_str())
    };

    let mut id = String::new();
    let mut title = String::new();
    let mut pinned = false;
    let mut tags: Vec<String> = Vec::new();
    let mut created_at = Utc::now();
    let mut updated_at = Utc::now();

    for line in fm_str.lines() {
        if let Some((k, v)) = line.split_once(": ") {
            match k.trim() {
                "id" => id = v.trim().to_string(),
                "title" => title = v.trim().to_string(),
                "pinned" => pinned = v.trim() == "true",
                "tags" => {
                    tags = v
                        .split(',')
                        .map(|t| t.trim().to_string())
                        .filter(|t| !t.is_empty())
                        .collect()
                }
                "created_at" => created_at = v.trim().parse().unwrap_or_else(|_| Utc::now()),
                "updated_at" => updated_at = v.trim().parse().unwrap_or_else(|_| Utc::now()),
                _ => {}
            }
        }
    }

    if id.is_empty() {
        id = Uuid::new_v4().to_string();
    }
    if title.is_empty() {
        title = path
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned();
    }

    let rel = path.strip_prefix(repo_base).ok()?;
    let folder = rel
        .parent()
        .filter(|p| *p != Path::new(""))
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();

    let file_path = rel.to_string_lossy().replace('\\', "/");
    Some(Note { id, title, content: body.to_string(), folder, created_at, updated_at, pinned, tags, file_path })
}

fn scan_notes(repo_base: &Path) -> Vec<Note> {
    let mut raw: Vec<Note> = Vec::new();
    scan_dir_for_notes(repo_base, repo_base, &mut raw);
    // Deduplicate by ID: when two files share an ID, keep the most recently updated.
    let mut by_id: HashMap<String, Note> = HashMap::new();
    for note in raw {
        let keep = match by_id.get(&note.id) {
            Some(existing) => note.updated_at > existing.updated_at,
            None => true,
        };
        if keep {
            by_id.insert(note.id.clone(), note);
        }
    }
    by_id.into_values().collect()
}

fn scan_dir_for_notes(dir: &Path, repo_base: &Path, notes: &mut Vec<Note>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    let mut entries: Vec<_> = entries.flatten().collect();
    entries.sort_by_key(|e| e.path());
    for entry in entries {
        let path = entry.path();
        if path.is_dir() {
            let name = path.file_name().unwrap_or_default().to_string_lossy();
            if name.starts_with('.') { continue; }
            // Skip the global image store and task-notes dir at the repo root
            if path.parent() == Some(repo_base) && (name == "img" || name == "task-notes") { continue; }
            scan_dir_for_notes(&path, repo_base, notes);
        } else if path.extension().map(|e| e == "md").unwrap_or(false) {
            if let Some(note) = parse_note_file(&path, repo_base) {
                notes.push(note);
            }
        }
    }
}

fn scan_folders(repo_base: &Path) -> Vec<String> {
    let mut folders: Vec<String> = Vec::new();
    scan_folders_in(repo_base, repo_base, &mut folders);
    folders.sort();
    folders
}

fn scan_folders_in(dir: &Path, repo_base: &Path, out: &mut Vec<String>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() { continue; }
        let name = path.file_name().unwrap_or_default().to_string_lossy();
        if name.starts_with('.') { continue; }
        if path.parent() == Some(repo_base) && (name == "img" || name == "task-notes") { continue; }
        if let Ok(rel) = path.strip_prefix(repo_base) {
            let rel_str = rel.to_string_lossy().replace('\\', "/");
            if !rel_str.is_empty() {
                out.push(rel_str);
            }
        }
        scan_folders_in(&path, repo_base, out);
    }
}

fn find_note_file(repo_base: &Path, id: &str) -> Option<PathBuf> {
    find_note_file_in(repo_base, repo_base, id)
}

fn find_note_file_in(dir: &Path, repo_base: &Path, id: &str) -> Option<PathBuf> {
    let Ok(entries) = fs::read_dir(dir) else { return None };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            let name = path.file_name().unwrap_or_default().to_string_lossy();
            if !name.starts_with('.') {
                if let Some(found) = find_note_file_in(&path, repo_base, id) {
                    return Some(found);
                }
            }
        } else if path.extension().map(|e| e == "md").unwrap_or(false) {
            if let Some(note) = parse_note_file(&path, repo_base) {
                if note.id == id {
                    return Some(path);
                }
            }
        }
    }
    None
}

fn migrate_legacy_notes(settings: &Settings) {
    if settings.repo_path.is_empty() {
        return;
    }
    let legacy_path = PathBuf::from(&settings.repo_path).join("todoto-data.json");
    if !legacy_path.exists() {
        return;
    }
    let Ok(raw) = fs::read_to_string(&legacy_path) else { return };
    let Ok(mut legacy) = serde_json::from_str::<LegacyAppData>(&raw) else { return };
    if legacy.notes.is_empty() {
        return;
    }
    let repo_base = PathBuf::from(&settings.repo_path);
    for note in &legacy.notes {
        let _ = write_note_file(&repo_base, note);
    }
    legacy.notes.clear();
    if let Ok(json) = serde_json::to_string_pretty(&legacy) {
        let _ = fs::write(&legacy_path, json);
    }
}

// ── GitHub API types ──────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct GhTreeItem {
    path: String,
    sha: String,
    #[serde(rename = "type")]
    kind: String,
}

#[derive(Deserialize)]
struct GhTree {
    tree: Vec<GhTreeItem>,
}

#[derive(Deserialize)]
struct GhFileResponse {
    content: String,
    sha: String,
}

#[derive(Serialize)]
struct GhPutBody<'a> {
    message: &'a str,
    content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    sha: Option<&'a str>,
}

#[derive(Deserialize)]
struct GhPutResponse {
    content: GhPutContent,
}

#[derive(Deserialize)]
struct GhPutContent {
    sha: String,
}

#[derive(Serialize)]
struct GhDeleteBody<'a> {
    message: &'a str,
    sha: &'a str,
}

// ── Sync manifest ─────────────────────────────────────────────────────────────

// Maps repo-relative path → GitHub blob SHA, tracking what was last synced.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct SyncManifest {
    files: HashMap<String, String>,
}

fn load_manifest(repo_path: &Path) -> SyncManifest {
    let path = repo_path.join(".sync_manifest.json");
    fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_manifest(repo_path: &Path, manifest: &SyncManifest) {
    let path = repo_path.join(".sync_manifest.json");
    let tmp = repo_path.join(".sync_manifest.json.tmp");
    if let Ok(json) = serde_json::to_string_pretty(manifest) {
        if fs::write(&tmp, json).is_ok() {
            let _ = fs::rename(&tmp, &path);
        }
    }
}

// ── GitHub API helpers ────────────────────────────────────────────────────────

fn make_github_client(token: &str) -> Result<Client, String> {
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert(
        reqwest::header::ACCEPT,
        "application/vnd.github+json".parse().unwrap(),
    );
    headers.insert("X-GitHub-Api-Version", "2022-11-28".parse().unwrap());
    headers.insert(reqwest::header::USER_AGENT, "todoto/1.0".parse().unwrap());
    headers.insert(
        reqwest::header::AUTHORIZATION,
        format!("Bearer {token}").parse().map_err(|e: reqwest::header::InvalidHeaderValue| e.to_string())?,
    );
    Client::builder()
        .default_headers(headers)
        .build()
        .map_err(|e| e.to_string())
}

fn parse_github_repo(url: &str) -> Option<(String, String)> {
    let url = url.trim_end_matches('/').trim_end_matches(".git");
    let path = url.strip_prefix("https://github.com/")?;
    let (owner, repo) = path.split_once('/')?;
    if owner.is_empty() || repo.is_empty() {
        return None;
    }
    Some((owner.to_string(), repo.to_string()))
}

// Computes the same SHA git uses for a blob, so we can compare with GitHub's tree SHA.
fn github_blob_sha(content: &[u8]) -> String {
    let header = format!("blob {}\0", content.len());
    let mut h = Sha1::new();
    h.update(header.as_bytes());
    h.update(content);
    format!("{:x}", h.finalize())
}

fn encode_url_path(path: &str) -> String {
    path.split('/').map(|seg| {
        seg.replace('%', "%25")
           .replace(' ', "%20")
           .replace('#', "%23")
           .replace('?', "%3F")
           .replace('&', "%26")
           .replace('+', "%2B")
    }).collect::<Vec<_>>().join("/")
}

fn is_image_extension(ext: &str) -> bool {
    matches!(ext, "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "bmp" | "ico")
}

fn is_synced_file(path: &str) -> bool {
    if path.ends_with(".md") || path == "todos.json" {
        return true;
    }
    if let Some(ext) = path.rsplit('.').next() {
        return is_image_extension(ext);
    }
    false
}

// Returns map of repo-relative path → GitHub blob SHA for all tracked files.
async fn gh_list_tree(client: &Client, owner: &str, repo: &str) -> Result<HashMap<String, String>, String> {
    let url = format!("https://api.github.com/repos/{owner}/{repo}/git/trees/HEAD?recursive=1");
    let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
    let status = resp.status().as_u16();
    // 404 = repo not found; 409 = repo exists but is empty (no commits yet)
    if status == 404 || status == 409 {
        return Ok(HashMap::new());
    }
    if !resp.status().is_success() {
        return Err(format!("list tree: HTTP {status}"));
    }
    let tree: GhTree = resp.json().await.map_err(|e| e.to_string())?;
    Ok(tree
        .tree
        .into_iter()
        .filter(|i| i.kind == "blob" && is_synced_file(&i.path))
        .map(|i| (i.path, i.sha))
        .collect())
}

// Downloads a file from GitHub. Returns (decoded_utf8_content, blob_sha).
async fn gh_get_file(client: &Client, owner: &str, repo: &str, path: &str) -> Result<(String, String), String> {
    let url = format!(
        "https://api.github.com/repos/{owner}/{repo}/contents/{}",
        encode_url_path(path)
    );
    let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("get {path}: HTTP {}", resp.status()));
    }
    let file: GhFileResponse = resp.json().await.map_err(|e| e.to_string())?;
    // GitHub wraps base64 in newlines every 60 chars
    let clean = file.content.replace(['\n', '\r'], "");
    let bytes = B64.decode(&clean).map_err(|e| format!("decode {path}: {e}"))?;
    let content = String::from_utf8(bytes).map_err(|e| format!("utf8 {path}: {e}"))?;
    Ok((content, file.sha))
}

// Downloads a file from GitHub at a specific commit ref. Returns decoded utf-8 content.
async fn gh_get_file_at_ref(client: &Client, owner: &str, repo: &str, path: &str, ref_: &str) -> Result<String, String> {
    let url = format!(
        "https://api.github.com/repos/{owner}/{repo}/contents/{}?ref={}",
        encode_url_path(path),
        ref_
    );
    let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("get {path}@{ref_}: HTTP {}", resp.status()));
    }
    let file: GhFileResponse = resp.json().await.map_err(|e| e.to_string())?;
    let clean = file.content.replace(['\n', '\r'], "");
    let bytes = B64.decode(&clean).map_err(|e| format!("decode {path}: {e}"))?;
    String::from_utf8(bytes).map_err(|e| format!("utf8 {path}: {e}"))
}

const GH_MAX_FILE_BYTES: usize = 1_000_000; // GitHub Contents API hard limit is ~1 MB

// Creates or updates a file on GitHub. Returns the new blob SHA.
async fn gh_put_file(
    client: &Client,
    owner: &str,
    repo: &str,
    path: &str,
    content: &str,
    current_sha: Option<&str>,
) -> Result<String, String> {
    if content.len() > GH_MAX_FILE_BYTES {
        return Err(format!(
            "Cannot sync {path}: file is {} KB, GitHub's limit is 1 MB. Split it or reduce its size.",
            content.len() / 1024
        ));
    }
    let url = format!(
        "https://api.github.com/repos/{owner}/{repo}/contents/{}",
        encode_url_path(path)
    );
    let encoded = B64.encode(content.as_bytes());
    let message = format!("sync: {}", Utc::now().format("%Y-%m-%d %H:%M UTC"));
    let body = GhPutBody { message: &message, content: encoded.clone(), sha: current_sha };
    let resp = client.put(&url).json(&body).send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    // 422 with no SHA means the file already exists on GitHub but wasn't in our tree
    // (e.g. git/trees response was truncated). Fetch the real SHA and retry once.
    if status.as_u16() == 422 && current_sha.is_none() {
        let (_, file_sha) = gh_get_file(client, owner, repo, path).await?;
        let body2 = GhPutBody { message: &message, content: encoded, sha: Some(file_sha.as_str()) };
        let resp2 = client.put(&url).json(&body2).send().await.map_err(|e| e.to_string())?;
        if !resp2.status().is_success() {
            let status2 = resp2.status();
            let text = resp2.text().await.unwrap_or_default();
            return Err(format!("put {path}: HTTP {status2}: {text}"));
        }
        let put_resp: GhPutResponse = resp2.json().await.map_err(|e| e.to_string())?;
        return Ok(put_resp.content.sha);
    }
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("put {path}: HTTP {status}: {text}"));
    }
    let put_resp: GhPutResponse = resp.json().await.map_err(|e| e.to_string())?;
    Ok(put_resp.content.sha)
}

// Downloads a binary file from GitHub. Returns (raw_bytes, blob_sha).
async fn gh_get_binary_file(client: &Client, owner: &str, repo: &str, path: &str) -> Result<(Vec<u8>, String), String> {
    let url = format!(
        "https://api.github.com/repos/{owner}/{repo}/contents/{}",
        encode_url_path(path)
    );
    let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("get {path}: HTTP {}", resp.status()));
    }
    let file: GhFileResponse = resp.json().await.map_err(|e| e.to_string())?;
    let clean = file.content.replace(['\n', '\r'], "");
    let bytes = B64.decode(&clean).map_err(|e| format!("decode {path}: {e}"))?;
    Ok((bytes, file.sha))
}

// Creates or updates a binary file on GitHub. Returns the new blob SHA.
async fn gh_put_binary_file(
    client: &Client,
    owner: &str,
    repo: &str,
    path: &str,
    bytes: &[u8],
    current_sha: Option<&str>,
) -> Result<String, String> {
    let url = format!(
        "https://api.github.com/repos/{owner}/{repo}/contents/{}",
        encode_url_path(path)
    );
    let encoded = B64.encode(bytes);
    let message = format!("sync: {}", Utc::now().format("%Y-%m-%d %H:%M UTC"));
    let body = GhPutBody { message: &message, content: encoded.clone(), sha: current_sha };
    let resp = client.put(&url).json(&body).send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    if status.as_u16() == 422 && current_sha.is_none() {
        let (_, file_sha) = gh_get_binary_file(client, owner, repo, path).await?;
        let body2 = GhPutBody { message: &message, content: encoded, sha: Some(file_sha.as_str()) };
        let resp2 = client.put(&url).json(&body2).send().await.map_err(|e| e.to_string())?;
        if !resp2.status().is_success() {
            let status2 = resp2.status();
            let text = resp2.text().await.unwrap_or_default();
            return Err(format!("put {path}: HTTP {status2}: {text}"));
        }
        let put_resp: GhPutResponse = resp2.json().await.map_err(|e| e.to_string())?;
        return Ok(put_resp.content.sha);
    }
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("put {path}: HTTP {status}: {text}"));
    }
    let put_resp: GhPutResponse = resp.json().await.map_err(|e| e.to_string())?;
    Ok(put_resp.content.sha)
}

async fn gh_delete_file(client: &Client, owner: &str, repo: &str, path: &str, sha: &str) -> Result<(), String> {
    let url = format!(
        "https://api.github.com/repos/{owner}/{repo}/contents/{}",
        encode_url_path(path)
    );
    let body = GhDeleteBody {
        message: &format!("sync: delete {}", path.rsplit('/').next().unwrap_or(path)),
        sha,
    };
    let resp = client.delete(&url).json(&body).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("delete {path}: HTTP {status}: {text}"));
    }
    Ok(())
}

// ── Local file scanning ───────────────────────────────────────────────────────

// Returns all tracked local text files as a map of forward-slash relative path → content.
fn scan_local_files(repo_path: &Path) -> HashMap<String, String> {
    let mut files = HashMap::new();
    scan_local_dir(repo_path, repo_path, &mut files);
    files
}

// Returns all tracked local image files as a map of forward-slash relative path → raw bytes.
fn scan_local_binary_files(repo_path: &Path) -> HashMap<String, Vec<u8>> {
    let mut files = HashMap::new();
    scan_local_binary_dir(repo_path, repo_path, &mut files);
    files
}

fn scan_local_dir(dir: &Path, base: &Path, out: &mut HashMap<String, String>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    let mut entries: Vec<_> = entries.flatten().collect();
    entries.sort_by_key(|e| e.path());
    for entry in entries {
        let path = entry.path();
        let name = path.file_name().unwrap_or_default().to_string_lossy();
        if name.starts_with('.') {
            continue;
        }
        if path.is_dir() {
            scan_local_dir(&path, base, out);
        } else if path.extension().map_or(false, |e| e == "md") || name == "todos.json" {
            if let Ok(content) = fs::read_to_string(&path) {
                if let Ok(rel) = path.strip_prefix(base) {
                    let rel_str = rel.to_string_lossy().replace('\\', "/");
                    out.insert(rel_str, content);
                }
            }
        }
    }
}

fn scan_local_binary_dir(dir: &Path, base: &Path, out: &mut HashMap<String, Vec<u8>>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    let mut entries: Vec<_> = entries.flatten().collect();
    entries.sort_by_key(|e| e.path());
    for entry in entries {
        let path = entry.path();
        let name = path.file_name().unwrap_or_default().to_string_lossy();
        if name.starts_with('.') {
            continue;
        }
        if path.is_dir() {
            scan_local_binary_dir(&path, base, out);
        } else if path.extension().map_or(false, |e| is_image_extension(&e.to_string_lossy())) {
            if let Ok(bytes) = fs::read(&path) {
                if let Ok(rel) = path.strip_prefix(base) {
                    let rel_str = rel.to_string_lossy().replace('\\', "/");
                    out.insert(rel_str, bytes);
                }
            }
        }
    }
}

// ── Sync logic ────────────────────────────────────────────────────────────────

// Merges local and remote todos.json by ID, taking the newer updated_at per todo.
async fn merge_todos(
    client: &Client,
    owner: &str,
    repo: &str,
    path: &str,
    gh_sha: &str,
    local_content: &str,
) -> Result<(String, String), String> {
    let (remote_content, _) = gh_get_file(client, owner, repo, path).await?;
    let local_data: TodoData = serde_json::from_str(local_content).map_err(|e| e.to_string())?;
    let remote_data: TodoData = serde_json::from_str(&remote_content).map_err(|e| e.to_string())?;

    let mut by_id: HashMap<String, Todo> =
        remote_data.todos.into_iter().map(|t| (t.id.clone(), t)).collect();
    for todo in local_data.todos {
        match by_id.get(&todo.id) {
            Some(existing) if existing.updated_at >= todo.updated_at => {}
            _ => {
                by_id.insert(todo.id.clone(), todo);
            }
        }
    }

    let merged = TodoData { todos: by_id.into_values().collect(), version: 1 };
    let json = serde_json::to_string_pretty(&merged).map_err(|e| e.to_string())?;
    let new_sha = gh_put_file(client, owner, repo, path, &json, Some(gh_sha)).await?;
    Ok((json, new_sha))
}

async fn do_sync(settings: &Settings) -> SyncResult {
    macro_rules! fail {
        ($msg:literal) => {
            return SyncResult { success: false, message: $msg.to_string(), timestamp: Utc::now() }
        };
        ($fmt:literal, $($arg:tt)*) => {
            return SyncResult { success: false, message: format!($fmt, $($arg)*), timestamp: Utc::now() }
        };
    }

    if settings.repo_path.is_empty() {
        fail!("No local data path configured.");
    }
    if settings.repo_url.is_empty() {
        fail!("No GitHub repository URL configured.");
    }
    if settings.git_token.is_empty() {
        fail!("No GitHub token configured.");
    }

    let (owner, repo) = match parse_github_repo(&settings.repo_url) {
        Some(v) => v,
        None => fail!("Cannot parse GitHub URL: {}", settings.repo_url),
    };

    let repo_path = PathBuf::from(&settings.repo_path);
    if let Err(e) = fs::create_dir_all(&repo_path) {
        fail!("Cannot create data directory: {}", e);
    }

    let client = match make_github_client(&settings.git_token) {
        Ok(c) => c,
        Err(e) => fail!("Cannot create HTTP client: {}", e),
    };

    let github_map = match gh_list_tree(&client, &owner, &repo).await {
        Ok(m) => m,
        Err(e) => fail!("Cannot read GitHub repository: {}", e),
    };
    let manifest = load_manifest(&repo_path);
    let local_files = scan_local_files(&repo_path);
    let local_binary = scan_local_binary_files(&repo_path);

    let mut new_manifest: HashMap<String, String> = HashMap::new();
    let mut errors: Vec<String> = Vec::new();
    let mut uploaded = 0usize;
    let mut downloaded = 0usize;
    let mut deleted_count = 0usize;

    // ── Delete from GitHub: in manifest but no longer present locally ─────────
    for path in manifest.files.keys() {
        // A file is still present locally if it exists as text OR as a binary.
        if !local_files.contains_key(path) && !local_binary.contains_key(path) {
            if let Some(gh_sha) = github_map.get(path) {
                match gh_delete_file(&client, &owner, &repo, path, gh_sha).await {
                    Ok(()) => deleted_count += 1,
                    Err(e) => errors.push(e),
                }
            }
        }
    }

    // ── Process local files ───────────────────────────────────────────────────
    for (path, content) in &local_files {
        let local_sha = github_blob_sha(content.as_bytes());

        match github_map.get(path) {
            Some(gh_sha) if *gh_sha == local_sha => {
                // Local and GitHub are identical — nothing to do.
                new_manifest.insert(path.clone(), gh_sha.clone());
            }
            Some(gh_sha) => {
                // Content differs between local and GitHub.
                let manifest_sha = manifest.files.get(path);
                let github_changed = manifest_sha.map_or(true, |ms| ms != gh_sha);
                let local_changed = manifest_sha.map_or(true, |ms| ms != &local_sha);

                if github_changed && !local_changed {
                    // Only GitHub changed → download remote version.
                    match gh_get_file(&client, &owner, &repo, path).await {
                        Ok((remote_content, sha)) => {
                            let local_path = repo_path.join(path);
                            if let Some(p) = local_path.parent() {
                                fs::create_dir_all(p).ok();
                            }
                            if fs::write(&local_path, &remote_content).is_ok() {
                                new_manifest.insert(path.clone(), sha);
                                downloaded += 1;
                            }
                        }
                        Err(e) => errors.push(e),
                    }
                } else if github_changed && local_changed && path == "todos.json" {
                    // Both sides changed on todos.json → merge by ID.
                    match merge_todos(&client, &owner, &repo, path, gh_sha, content).await {
                        Ok((merged, new_sha)) => {
                            let _ = fs::write(repo_path.join(path), &merged);
                            new_manifest.insert(path.clone(), new_sha);
                            uploaded += 1;
                        }
                        Err(e) => errors.push(e),
                    }
                } else if github_changed && local_changed && path.ends_with(".md") {
                    // Both sides changed on a note → save remote as a conflict copy, upload local.
                    if let Ok((remote_content, _)) = gh_get_file(&client, &owner, &repo, path).await {
                        let conflict_path = format!(
                            "{} (conflict {}).md",
                            path.trim_end_matches(".md"),
                            Utc::now().format("%Y-%m-%d")
                        );
                        let conflict_local = repo_path.join(&conflict_path);
                        if let Some(p) = conflict_local.parent() { fs::create_dir_all(p).ok(); }
                        let _ = fs::write(&conflict_local, &remote_content);
                    }
                    match gh_put_file(&client, &owner, &repo, path, content, Some(gh_sha)).await {
                        Ok(new_sha) => {
                            new_manifest.insert(path.clone(), new_sha);
                            uploaded += 1;
                        }
                        Err(e) => errors.push(e),
                    }
                } else {
                    // Local changed, GitHub unchanged → upload.
                    match gh_put_file(&client, &owner, &repo, path, content, Some(gh_sha)).await {
                        Ok(new_sha) => {
                            new_manifest.insert(path.clone(), new_sha);
                            uploaded += 1;
                        }
                        Err(e) => errors.push(e),
                    }
                }
            }
            None => {
                // File does not exist on GitHub → upload.
                match gh_put_file(&client, &owner, &repo, path, content, None).await {
                    Ok(new_sha) => {
                        new_manifest.insert(path.clone(), new_sha);
                        uploaded += 1;
                    }
                    Err(e) => errors.push(e),
                }
            }
        }
    }

    // ── Download files new on GitHub (not in manifest, not local) ────────────
    for (path, _gh_sha) in &github_map {
        if local_files.contains_key(path) {
            continue; // already handled above
        }
        if manifest.files.contains_key(path) {
            continue; // was deleted locally — already handled in deletion step
        }
        match gh_get_file(&client, &owner, &repo, path).await {
            Ok((content, sha)) => {
                let local_path = repo_path.join(path);
                if let Some(p) = local_path.parent() {
                    fs::create_dir_all(p).ok();
                }
                if fs::write(&local_path, &content).is_ok() {
                    new_manifest.insert(path.clone(), sha);
                    downloaded += 1;
                }
            }
            Err(e) => errors.push(e),
        }
    }

    // ── Binary files (images) ─────────────────────────────────────────────────

    for (path, bytes) in &local_binary {
        let local_sha = github_blob_sha(bytes);
        match github_map.get(path) {
            Some(gh_sha) if *gh_sha == local_sha => {
                new_manifest.insert(path.clone(), gh_sha.clone());
            }
            Some(gh_sha) => {
                let manifest_sha = manifest.files.get(path);
                let local_changed = manifest_sha.map_or(true, |ms| ms != &local_sha);
                if local_changed {
                    match gh_put_binary_file(&client, &owner, &repo, path, bytes, Some(gh_sha)).await {
                        Ok(new_sha) => { new_manifest.insert(path.clone(), new_sha); uploaded += 1; }
                        Err(e) => errors.push(e),
                    }
                } else {
                    match gh_get_binary_file(&client, &owner, &repo, path).await {
                        Ok((remote_bytes, sha)) => {
                            let local_path = repo_path.join(path);
                            if let Some(p) = local_path.parent() { fs::create_dir_all(p).ok(); }
                            if fs::write(&local_path, &remote_bytes).is_ok() {
                                new_manifest.insert(path.clone(), sha);
                                downloaded += 1;
                            }
                        }
                        Err(e) => errors.push(e),
                    }
                }
            }
            None => {
                match gh_put_binary_file(&client, &owner, &repo, path, bytes, None).await {
                    Ok(new_sha) => { new_manifest.insert(path.clone(), new_sha); uploaded += 1; }
                    Err(e) => errors.push(e),
                }
            }
        }
    }

    // Download new binary files from GitHub not present locally
    for (path, _gh_sha) in &github_map {
        if local_binary.contains_key(path) || local_files.contains_key(path) {
            continue;
        }
        if manifest.files.contains_key(path) {
            continue;
        }
        let ext = path.rsplit('.').next().unwrap_or("");
        if !is_image_extension(ext) {
            continue;
        }
        match gh_get_binary_file(&client, &owner, &repo, path).await {
            Ok((bytes, sha)) => {
                let local_path = repo_path.join(path);
                if let Some(p) = local_path.parent() { fs::create_dir_all(p).ok(); }
                if fs::write(&local_path, &bytes).is_ok() {
                    new_manifest.insert(path.clone(), sha);
                    downloaded += 1;
                }
            }
            Err(e) => errors.push(e),
        }
    }

    save_manifest(&repo_path, &SyncManifest { files: new_manifest });

    let message = if errors.is_empty() {
        match (uploaded, downloaded, deleted_count) {
            (0, 0, 0) => "Already up to date.".to_string(),
            _ => format!("Synced. ↑{uploaded} ↓{downloaded} ✕{deleted_count}"),
        }
    } else {
        format!(
            "Partial sync ↑{uploaded} ↓{downloaded}. Error: {}",
            errors.first().unwrap()
        )
    };

    SyncResult { success: errors.is_empty(), message, timestamp: Utc::now() }
}

// ── Tauri commands ────────────────────────────────────────────────────────────

#[tauri::command]
fn get_notes(state: State<Mutex<AppState>>) -> Vec<Note> {
    let state = state.lock().unwrap();
    if state.settings.repo_path.is_empty() {
        return vec![];
    }
    let repo_base = PathBuf::from(&state.settings.repo_path);
    let mut notes = scan_notes(&repo_base);
    notes.sort_by(|a, b| {
        b.pinned.cmp(&a.pinned).then(b.updated_at.cmp(&a.updated_at))
    });
    notes
}

#[tauri::command]
fn save_note(state: State<Mutex<AppState>>, mut note: Note) -> Result<Note, String> {
    let state = state.lock().unwrap();
    if state.settings.repo_path.is_empty() {
        return Err("No repo path configured".to_string());
    }
    let repo_base = PathBuf::from(&state.settings.repo_path);
    note.updated_at = Utc::now();
    if note.id.is_empty() {
        note.id = Uuid::new_v4().to_string();
        note.created_at = Utc::now();
    } else {
        if let Some(old_path) = find_note_file(&repo_base, &note.id) {
            let new_path = note_file_path(&repo_base, &note);
            if old_path != new_path {
                let _ = fs::remove_file(&old_path);
            }
        }
    }
    write_note_file(&repo_base, &note)?;
    let fp = note_file_path(&repo_base, &note);
    if let Ok(rel) = fp.strip_prefix(&repo_base) {
        note.file_path = rel.to_string_lossy().replace('\\', "/");
    }
    Ok(note)
}

#[tauri::command]
fn get_folders(state: State<Mutex<AppState>>) -> Vec<String> {
    let state = state.lock().unwrap();
    if state.settings.repo_path.is_empty() {
        return vec![];
    }
    let repo_base = PathBuf::from(&state.settings.repo_path);
    scan_folders(&repo_base)
}

#[tauri::command]
fn delete_note(state: State<Mutex<AppState>>, id: String) -> Result<(), String> {
    let state = state.lock().unwrap();
    if state.settings.repo_path.is_empty() {
        return Ok(());
    }
    let repo_base = PathBuf::from(&state.settings.repo_path);
    if let Some(path) = find_note_file(&repo_base, &id) {
        fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn get_todos(state: State<Mutex<AppState>>) -> Vec<Todo> {
    let state = state.lock().unwrap();
    let mut todos = load_todos(&state.settings);
    todos.sort_by(|a, b| {
        a.done
            .cmp(&b.done)
            .then(b.priority.cmp(&a.priority))
            .then(b.created_at.cmp(&a.created_at))
    });
    todos
}

#[tauri::command]
fn save_todo(state: State<Mutex<AppState>>, mut todo: Todo) -> Result<Todo, String> {
    let state = state.lock().unwrap();
    todo.updated_at = Utc::now();
    if todo.id.is_empty() {
        todo.id = Uuid::new_v4().to_string();
        todo.created_at = Utc::now();
    }
    // Write or delete the note .md file
    let repo_base = PathBuf::from(&state.settings.repo_path);
    if !repo_base.as_os_str().is_empty() {
        match todo.notes.as_deref() {
            Some(content) if !content.trim().is_empty() => {
                let note_file = task_note_path(&repo_base, &todo.id);
                if let Some(parent) = note_file.parent() {
                    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                }
                fs::write(&note_file, content).map_err(|e| e.to_string())?;
                if let Ok(rel) = note_file.strip_prefix(&repo_base) {
                    todo.note_path = Some(rel.to_string_lossy().replace('\\', "/"));
                }
            }
            _ => {
                let to_delete = todo.note_path.as_ref()
                    .map(|p| repo_base.join(p))
                    .unwrap_or_else(|| task_note_path(&repo_base, &todo.id));
                let _ = fs::remove_file(to_delete);
                todo.note_path = None;
            }
        }
    }
    let mut todos = load_todos(&state.settings);
    match todos.iter_mut().find(|t| t.id == todo.id) {
        Some(existing) => *existing = todo.clone(),
        None => todos.push(todo.clone()),
    }
    save_todos(&state.settings, &todos)?;
    Ok(todo)
}

#[tauri::command]
fn delete_todo(state: State<Mutex<AppState>>, id: String) -> Result<(), String> {
    let state = state.lock().unwrap();
    let mut todos = load_todos(&state.settings);
    let repo_base = PathBuf::from(&state.settings.repo_path);
    if let Some(todo) = todos.iter().find(|t| t.id == id) {
        let note_file = todo.note_path.as_ref()
            .map(|p| repo_base.join(p))
            .unwrap_or_else(|| task_note_path(&repo_base, &id));
        let _ = fs::remove_file(note_file);
    }
    todos.retain(|t| t.id != id);
    save_todos(&state.settings, &todos)
}

#[tauri::command]
fn get_settings(state: State<Mutex<AppState>>) -> Settings {
    state.lock().unwrap().settings.clone()
}

#[tauri::command]
fn save_settings(state: State<Mutex<AppState>>, settings: Settings) -> Result<(), String> {
    let mut state = state.lock().unwrap();
    save_settings_to_path(&settings, &state.settings_path)?;
    migrate_legacy_notes(&settings);
    state.settings = settings;
    Ok(())
}

#[tauri::command]
async fn sync_now(state: State<'_, Mutex<AppState>>) -> Result<SyncResult, String> {
    let (settings, syncing) = {
        let s = state.lock().unwrap();
        (s.settings.clone(), Arc::clone(&s.syncing))
    };
    if syncing.swap(true, Ordering::SeqCst) {
        return Ok(SyncResult { success: false, message: "Sync already in progress.".to_string(), timestamp: Utc::now() });
    }
    let result = do_sync(&settings).await;
    syncing.store(false, Ordering::SeqCst);
    if result.success {
        state.lock().unwrap().last_sync = Some(result.timestamp);
    }
    Ok(result)
}

#[tauri::command]
fn get_last_sync(state: State<Mutex<AppState>>) -> Option<DateTime<Utc>> {
    state.lock().unwrap().last_sync
}

// Read an image from the system clipboard and return it as a base64-encoded PNG.
// Returns None if the clipboard contains no image.
#[tauri::command]
fn read_clipboard_image() -> Result<Option<String>, String> {
    let mut cb = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    match cb.get_image() {
        Ok(img) => {
            let mut png: Vec<u8> = Vec::new();
            let mut enc = png::Encoder::new(std::io::Cursor::new(&mut png), img.width as u32, img.height as u32);
            enc.set_color(png::ColorType::Rgba);
            enc.set_depth(png::BitDepth::Eight);
            let mut w = enc.write_header().map_err(|e| e.to_string())?;
            w.write_image_data(&img.bytes).map_err(|e| e.to_string())?;
            drop(w);
            Ok(Some(B64.encode(&png)))
        }
        Err(_) => Ok(None),
    }
}

#[tauri::command]
fn save_task_note_image(
    state: State<Mutex<AppState>>,
    id: String,
    data_b64: String,
    ext: String,
) -> Result<String, String> {
    let repo_path = state.lock().unwrap().settings.repo_path.clone();
    if repo_path.is_empty() { return Err("No repo path configured".to_string()); }
    let repo_base = Path::new(&repo_path);
    let img_dir = repo_base.join("task-notes").join("img");
    fs::create_dir_all(&img_dir).map_err(|e| e.to_string())?;
    let bytes = B64.decode(data_b64.trim()).map_err(|e| e.to_string())?;
    let safe_ext = if is_image_extension(&ext) { ext } else { "png".to_string() };
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let file_path = img_dir.join(format!("image-{ts}.{safe_ext}"));
    fs::write(&file_path, &bytes).map_err(|e| e.to_string())?;
    let rel = file_path.strip_prefix(repo_base).map_err(|e| e.to_string())?;
    Ok(rel.to_string_lossy().replace('\\', "/"))
}

#[tauri::command]
fn read_file_base64(path: String) -> Result<String, String> {
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    Ok(B64.encode(&bytes))
}

#[tauri::command]
fn find_asset(note_dir: String, src: String) -> Option<String> {
    let direct = Path::new(&note_dir).join(&src);
    if direct.exists() { Some(direct.to_string_lossy().into_owned()) } else { None }
}

// Strip YAML frontmatter from note content so metadata-only changes (e.g. updated_at)
// are not treated as meaningful content differences.
fn strip_note_body(content: &str) -> &str {
    if content.starts_with("---\n") {
        let rest = &content[4..];
        if let Some(end) = rest.find("\n---\n") {
            return &rest[end + 5..];
        }
    }
    content
}

#[tauri::command]
async fn get_note_history(state: State<'_, Mutex<AppState>>, path: String) -> Result<Vec<CommitInfo>, String> {
    let (token, repo_url) = {
        let s = state.lock().unwrap();
        (s.settings.git_token.clone(), s.settings.repo_url.clone())
    };
    let (owner, repo) = parse_github_repo(&repo_url).ok_or("Invalid GitHub URL")?;
    let client = make_github_client(&token)?;
    let url = format!(
        "https://api.github.com/repos/{owner}/{repo}/commits?path={}&per_page=50",
        encode_url_path(&path)
    );
    let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("GitHub API error: HTTP {}", resp.status()));
    }
    let commits_json: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let commits: Vec<CommitInfo> = commits_json.as_array().unwrap_or(&vec![]).iter().filter_map(|c| {
        Some(CommitInfo {
            sha: c["sha"].as_str()?.to_string(),
            date: c["commit"]["author"]["date"].as_str()?.to_string(),
            message: c["commit"]["message"].as_str()?.to_string(),
        })
    }).collect();

    if commits.len() <= 1 {
        return Ok(commits);
    }

    // Fetch content at each commit in parallel, then deduplicate by meaningful body.
    // Docs notes have YAML frontmatter whose updated_at changes every save — we strip
    // it before comparing so metadata-only saves don't appear as new versions.
    let client = Arc::new(client);
    let owner = Arc::new(owner);
    let repo_arc = Arc::new(repo);
    let path_arc = Arc::new(path);

    let handles: Vec<_> = commits.iter().map(|commit| {
        let c = Arc::clone(&client);
        let o = Arc::clone(&owner);
        let r = Arc::clone(&repo_arc);
        let p = Arc::clone(&path_arc);
        let sha = commit.sha.clone();
        tokio::spawn(async move {
            let result = gh_get_file_at_ref(&c, &o, &r, &p, &sha).await;
            (sha, result.ok())
        })
    }).collect();

    let mut sha_to_body: HashMap<String, String> = HashMap::new();
    for handle in handles {
        if let Ok((sha, Some(content))) = handle.await {
            sha_to_body.insert(sha, strip_note_body(&content).trim().to_string());
        }
    }

    // Walk newest-first; emit only commits where body differs from the previous emitted one.
    let mut result = Vec::new();
    let mut prev_body: Option<String> = None;
    for commit in commits {
        if let Some(body) = sha_to_body.get(&commit.sha) {
            if prev_body.as_deref() != Some(body.as_str()) {
                prev_body = Some(body.clone());
                result.push(commit);
            }
        }
    }

    Ok(result)
}

#[tauri::command]
async fn get_note_at_commit(state: State<'_, Mutex<AppState>>, path: String, sha: String) -> Result<String, String> {
    let (token, repo_url) = {
        let s = state.lock().unwrap();
        (s.settings.git_token.clone(), s.settings.repo_url.clone())
    };
    let (owner, repo) = parse_github_repo(&repo_url).ok_or("Invalid GitHub URL")?;
    let client = make_github_client(&token)?;
    gh_get_file_at_ref(&client, &owner, &repo, &path, &sha).await
}

// ── App entry point ───────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // Use Tauri's path resolver so this works correctly on Android
            // (where dirs::config_dir() is not reliable).
            let config_dir = app.path().app_config_dir().unwrap_or_else(|_| {
                dirs::config_dir()
                    .unwrap_or_else(|| PathBuf::from("."))
                    .join("todoto")
            });
            let data_dir = app.path().app_data_dir().unwrap_or_else(|_| {
                dirs::data_dir()
                    .unwrap_or_else(|| PathBuf::from("."))
                    .join("todoto")
            });

            fs::create_dir_all(&config_dir).ok();

            let settings_path = config_dir.join("settings.json");
            let mut settings = load_settings_from_path(&settings_path);

            // Auto-set repo_path on first launch (important for Android where
            // users cannot browse the filesystem).
            if settings.repo_path.is_empty() {
                let default_path = data_dir.join("notes");
                settings.repo_path = default_path.to_string_lossy().into_owned();
                save_settings_to_path(&settings, &settings_path).ok();
            }

            migrate_legacy_notes(&settings);

            let syncing = Arc::new(AtomicBool::new(false));

            if settings.auto_sync && !settings.repo_url.is_empty() {
                let s = settings.clone();
                let flag = Arc::clone(&syncing);
                tauri::async_runtime::spawn(async move {
                    flag.store(true, Ordering::SeqCst);
                    do_sync(&s).await;
                    flag.store(false, Ordering::SeqCst);
                });
            }

            app.manage(Mutex::new(AppState {
                settings,
                settings_path,
                last_sync: None,
                syncing,
            }));

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_notes,
            get_folders,
            save_note,
            delete_note,
            get_todos,
            save_todo,
            delete_todo,
            get_settings,
            save_settings,
            sync_now,
            get_last_sync,
            read_clipboard_image,
            save_task_note_image,
            read_file_base64,
            find_asset,
            get_note_history,
            get_note_at_commit,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
