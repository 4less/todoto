use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use tauri::State;
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

// Todos-only data file (notes are stored as individual .md files)
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TodoData {
    pub todos: Vec<Todo>,
    pub version: u32,
}

// Legacy format — used only for one-time migration
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
    pub git_username: String,
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
    pub last_sync: Option<DateTime<Utc>>,
}

// ── Paths ─────────────────────────────────────────────────────────────────────

fn config_dir() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("todoto")
}

fn settings_path() -> PathBuf {
    config_dir().join("settings.json")
}

fn todos_path(settings: &Settings) -> Option<PathBuf> {
    if settings.repo_path.is_empty() {
        None
    } else {
        Some(PathBuf::from(&settings.repo_path).join("todos.json"))
    }
}

// ── Settings ──────────────────────────────────────────────────────────────────

fn load_settings() -> Settings {
    let path = settings_path();
    if path.exists() {
        fs::read_to_string(&path)
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

fn save_settings_to_disk(settings: &Settings) -> Result<(), String> {
    let path = settings_path();
    fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    let json = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())
}

// ── Todos storage ─────────────────────────────────────────────────────────────

fn load_todos(settings: &Settings) -> Vec<Todo> {
    let Some(path) = todos_path(settings) else { return vec![] };
    if path.exists() {
        fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str::<TodoData>(&s).ok())
            .map(|d| d.todos)
            .unwrap_or_default()
    } else {
        // Try migrating from legacy todoto-data.json
        let legacy_path = PathBuf::from(&settings.repo_path).join("todoto-data.json");
        if legacy_path.exists() {
            let todos = fs::read_to_string(&legacy_path)
                .ok()
                .and_then(|s| serde_json::from_str::<LegacyAppData>(&s).ok())
                .map(|d| d.todos)
                .unwrap_or_default();
            todos
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
    let path = note_file_path(repo_base, note);
    fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
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

    Some(Note {
        id,
        title,
        content: body.to_string(),
        folder,
        created_at,
        updated_at,
        pinned,
        tags,
    })
}

fn scan_notes(repo_base: &Path) -> Vec<Note> {
    let mut notes = Vec::new();
    scan_dir_for_notes(repo_base, repo_base, &mut notes);
    notes
}

fn scan_dir_for_notes(dir: &Path, repo_base: &Path, notes: &mut Vec<Note>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    let mut entries: Vec<_> = entries.flatten().collect();
    entries.sort_by_key(|e| e.path());
    for entry in entries {
        let path = entry.path();
        if path.is_dir() {
            let name = path.file_name().unwrap_or_default().to_string_lossy();
            if !name.starts_with('.') {
                scan_dir_for_notes(&path, repo_base, notes);
            }
        } else if path.extension().map(|e| e == "md").unwrap_or(false) {
            if let Some(note) = parse_note_file(&path, repo_base) {
                notes.push(note);
            }
        }
    }
}

fn find_note_file(repo_base: &Path, id: &str) -> Option<PathBuf> {
    find_note_file_in(repo_base, repo_base, id)
}

fn find_note_file_in(dir: &Path, repo_base: &Path, id: &str) -> Option<PathBuf> {
    let Ok(entries) = fs::read_dir(dir) else {
        return None;
    };
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

// Migrate any notes still inside the legacy todoto-data.json to .md files
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
    // Remove notes from legacy file, keep todos
    legacy.notes.clear();
    if let Ok(json) = serde_json::to_string_pretty(&legacy) {
        let _ = fs::write(&legacy_path, json);
    }
}

// ── Git helpers ───────────────────────────────────────────────────────────────

fn git_cmd(repo_path: &Path, args: &[&str], token: &str) -> Result<String, String> {
    let mut cmd = Command::new("git");
    cmd.args(args).current_dir(repo_path);
    if !token.is_empty() {
        cmd.env("GIT_ASKPASS", "echo")
            .env("GIT_TERMINAL_PROMPT", "0");
    }
    let output = cmd.output().map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

fn inject_token(url: &str, token: &str) -> String {
    if token.is_empty() || url.is_empty() {
        return url.to_string();
    }
    if url.starts_with("https://github.com/") {
        url.replacen(
            "https://github.com/",
            &format!("https://{}@github.com/", token),
            1,
        )
    } else if url.starts_with("https://") {
        url.replacen("https://", &format!("https://{}@", token), 1)
    } else {
        url.to_string()
    }
}

fn set_git_identity(settings: &Settings, repo_path: &Path) {
    let name = if settings.git_username.is_empty() {
        "todoto"
    } else {
        &settings.git_username
    };
    let email = if settings.git_email.is_empty() {
        "todoto@local"
    } else {
        &settings.git_email
    };
    let _ = git_cmd(repo_path, &["config", "user.name", name], &settings.git_token);
    let _ = git_cmd(
        repo_path,
        &["config", "user.email", email],
        &settings.git_token,
    );
}

fn do_sync(settings: &Settings) -> SyncResult {
    let repo_path = if settings.repo_path.is_empty() {
        return SyncResult {
            success: false,
            message: "No repository path configured.".to_string(),
            timestamp: Utc::now(),
        };
    } else {
        PathBuf::from(&settings.repo_path)
    };

    if !repo_path.join(".git").exists() {
        if let Err(e) = fs::create_dir_all(&repo_path) {
            return SyncResult {
                success: false,
                message: format!("Failed to create directory: {e}"),
                timestamp: Utc::now(),
            };
        }
        if !settings.repo_url.is_empty() {
            let url = inject_token(&settings.repo_url, &settings.git_token);
            if let Err(e) = git_cmd(
                &repo_path,
                &["clone", "--depth=1", &url, "."],
                &settings.git_token,
            ) {
                let _ = git_cmd(&repo_path, &["init"], &settings.git_token);
                let _ = git_cmd(
                    &repo_path,
                    &["remote", "add", "origin", &url],
                    &settings.git_token,
                );
                set_git_identity(settings, &repo_path);
                return SyncResult {
                    success: false,
                    message: format!("Clone failed: {e}. Initialized empty repo."),
                    timestamp: Utc::now(),
                };
            }
        } else {
            let _ = git_cmd(&repo_path, &["init"], &settings.git_token);
        }
        set_git_identity(settings, &repo_path);
    }

    set_git_identity(settings, &repo_path);

    if !settings.repo_url.is_empty() {
        let url = inject_token(&settings.repo_url, &settings.git_token);
        let _ = git_cmd(
            &repo_path,
            &["remote", "set-url", "origin", &url],
            &settings.git_token,
        )
        .or_else(|_| {
            git_cmd(
                &repo_path,
                &["remote", "add", "origin", &url],
                &settings.git_token,
            )
        });
    }

    // Step 1: stage ALL local changes first (notes as .md + todos.json)
    let _ = git_cmd(&repo_path, &["add", "-A"], &settings.git_token);

    let has_changes = git_cmd(
        &repo_path,
        &["diff", "--cached", "--stat"],
        &settings.git_token,
    )
    .map(|s| !s.trim().is_empty())
    .unwrap_or(true);

    if has_changes {
        let msg = format!("sync: {}", Utc::now().format("%Y-%m-%d %H:%M UTC"));
        if let Err(e) = git_cmd(&repo_path, &["commit", "-m", &msg], &settings.git_token) {
            return SyncResult {
                success: false,
                message: format!("Commit failed: {e}"),
                timestamp: Utc::now(),
            };
        }
    }

    // Step 2: pull remote changes (rebases local commit on top)
    if !settings.repo_url.is_empty() {
        let _ = git_cmd(
            &repo_path,
            &["pull", "--rebase", "origin", "HEAD"],
            &settings.git_token,
        );
    }

    // Step 3: push
    if !settings.repo_url.is_empty() {
        match git_cmd(
            &repo_path,
            &["push", "--set-upstream", "origin", "HEAD"],
            &settings.git_token,
        ) {
            Ok(_) => SyncResult {
                success: true,
                message: "Synced with GitHub.".to_string(),
                timestamp: Utc::now(),
            },
            Err(e) => SyncResult {
                success: false,
                message: format!("Push failed: {e}"),
                timestamp: Utc::now(),
            },
        }
    } else {
        SyncResult {
            success: true,
            message: if has_changes {
                "Committed locally (no remote configured).".to_string()
            } else {
                "Already up to date.".to_string()
            },
            timestamp: Utc::now(),
        }
    }
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
        b.pinned
            .cmp(&a.pinned)
            .then(b.updated_at.cmp(&a.updated_at))
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
        // If title or folder changed, delete the old file
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
    save_settings_to_disk(&settings)?;
    migrate_legacy_notes(&settings);
    state.lock().unwrap().settings = settings;
    Ok(())
}

#[tauri::command]
fn sync_now(state: State<Mutex<AppState>>) -> SyncResult {
    let settings = state.lock().unwrap().settings.clone();
    let result = do_sync(&settings);
    if result.success {
        state.lock().unwrap().last_sync = Some(result.timestamp);
    }
    result
}

#[tauri::command]
fn get_last_sync(state: State<Mutex<AppState>>) -> Option<DateTime<Utc>> {
    state.lock().unwrap().last_sync
}

#[tauri::command]
fn read_file_base64(path: String) -> Result<String, String> {
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    Ok(to_base64(&bytes))
}

// Find an asset relative to note_dir: tries direct path first,
// then one level of subdirectories. Returns the absolute path if found.
#[tauri::command]
fn find_asset(note_dir: String, src: String) -> Option<String> {
    let base = Path::new(&note_dir);
    let direct = base.join(&src);
    if direct.exists() {
        return Some(direct.to_string_lossy().into_owned());
    }
    if let Ok(entries) = fs::read_dir(base) {
        for entry in entries.flatten() {
            if entry.file_type().map_or(false, |t| t.is_dir()) {
                let candidate = entry.path().join(&src);
                if candidate.exists() {
                    return Some(candidate.to_string_lossy().into_owned());
                }
            }
        }
    }
    None
}

fn to_base64(data: &[u8]) -> String {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = Vec::with_capacity((data.len() + 2) / 3 * 4);
    for c in data.chunks(3) {
        let b = [c[0] as usize, c.get(1).copied().unwrap_or(0) as usize, c.get(2).copied().unwrap_or(0) as usize];
        out.push(T[(b[0] >> 2) & 63]);
        out.push(T[((b[0] << 4) | (b[1] >> 4)) & 63]);
        out.push(if c.len() > 1 { T[((b[1] << 2) | (b[2] >> 6)) & 63] } else { b'=' });
        out.push(if c.len() > 2 { T[b[2] & 63] } else { b'=' });
    }
    String::from_utf8(out).unwrap()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let settings = load_settings();

    // Migrate any notes still in the legacy JSON on startup
    migrate_legacy_notes(&settings);

    if settings.auto_sync && !settings.repo_path.is_empty() {
        let s = settings.clone();
        std::thread::spawn(move || {
            do_sync(&s);
        });
    }

    let state = Mutex::new(AppState {
        settings,
        last_sync: None,
    });

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            get_notes,
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
