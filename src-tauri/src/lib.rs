use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use chrono::{DateTime, Utc};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
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

pub struct AppState {
    pub settings: Settings,
    pub settings_path: PathBuf,
    pub last_sync: Option<DateTime<Utc>>,
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
            sync_interval_seconds: 30,
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

fn todos_path(settings: &Settings) -> Option<PathBuf> {
    if settings.repo_path.is_empty() {
        None
    } else {
        Some(PathBuf::from(&settings.repo_path).join("todos.json"))
    }
}

fn load_todos(settings: &Settings) -> Vec<Todo> {
    let Some(path) = todos_path(settings) else { return vec![] };
    if path.exists() {
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
    }
}

fn save_todos(settings: &Settings, todos: &[Todo]) -> Result<(), String> {
    let path = todos_path(settings).ok_or("No repo path configured")?;
    fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    let data = TodoData { todos: todos.to_vec(), version: 1 };
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

    Some(Note { id, title, content: body.to_string(), folder, created_at, updated_at, pinned, tags })
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
            // Skip hidden dirs and the global image store at the repo root
            if name.starts_with('.') { continue; }
            if path.parent() == Some(repo_base) && name == "img" { continue; }
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
        if path.parent() == Some(repo_base) && name == "img" { continue; }
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
    if let Ok(json) = serde_json::to_string_pretty(manifest) {
        let _ = fs::write(path, json);
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
    path.split('/')
        .map(|seg| seg.replace(' ', "%20"))
        .collect::<Vec<_>>()
        .join("/")
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

// Creates or updates a file on GitHub. Returns the new blob SHA.
async fn gh_put_file(
    client: &Client,
    owner: &str,
    repo: &str,
    path: &str,
    content: &str,
    current_sha: Option<&str>,
) -> Result<String, String> {
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

    let mut new_manifest: HashMap<String, String> = HashMap::new();
    let mut errors: Vec<String> = Vec::new();
    let mut uploaded = 0usize;
    let mut downloaded = 0usize;
    let mut deleted_count = 0usize;

    // ── Delete from GitHub: in manifest but no longer present locally ─────────
    for path in manifest.files.keys() {
        if !local_files.contains_key(path) {
            if let Some(gh_sha) = github_map.get(path) {
                match gh_delete_file(&client, &owner, &repo, path, gh_sha).await {
                    Ok(()) => deleted_count += 1,
                    Err(e) => errors.push(e),
                }
            }
            // Either deleted on GitHub already, or successfully deleted — don't add to new manifest.
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
                } else {
                    // Local changed (or conflict on a note) → local wins, upload.
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
    let local_binary = scan_local_binary_files(&repo_path);

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
    let mut todos = load_todos(&state.settings);
    todo.updated_at = Utc::now();
    if todo.id.is_empty() {
        todo.id = Uuid::new_v4().to_string();
        todo.created_at = Utc::now();
        todos.push(todo.clone());
    } else {
        match todos.iter_mut().find(|t| t.id == todo.id) {
            Some(existing) => *existing = todo.clone(),
            None => todos.push(todo.clone()),
        }
    }
    save_todos(&state.settings, &todos)?;
    Ok(todo)
}

#[tauri::command]
fn delete_todo(state: State<Mutex<AppState>>, id: String) -> Result<(), String> {
    let state = state.lock().unwrap();
    let mut todos = load_todos(&state.settings);
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
    let settings = state.lock().unwrap().settings.clone();
    let result = do_sync(&settings).await;
    if result.success {
        state.lock().unwrap().last_sync = Some(result.timestamp);
    }
    Ok(result)
}

#[tauri::command]
fn get_last_sync(state: State<Mutex<AppState>>) -> Option<DateTime<Utc>> {
    state.lock().unwrap().last_sync
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

            if settings.auto_sync && !settings.repo_url.is_empty() {
                let s = settings.clone();
                tauri::async_runtime::spawn(async move {
                    do_sync(&s).await;
                });
            }

            app.manage(Mutex::new(AppState {
                settings,
                settings_path,
                last_sync: None,
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
            read_file_base64,
            find_asset,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
