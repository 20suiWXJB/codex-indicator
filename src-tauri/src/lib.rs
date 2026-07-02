use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};
use tauri::{
    menu::{CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager,
};
use time::{format_description::well_known::Rfc3339, OffsetDateTime};

const PROJECT_ROOT: &str = r"D:\Code\Tauri\indicator";
const CODEX_SESSIONS_ROOT: &str = r"C:\Users\1\.codex\sessions";
const DONE_SETTLE_MS: i128 = 3500;
const MAIN_WINDOW: &str = "main";
const OPEN_EVENTS: &str = "indicator-open-events";

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusPayload {
    #[serde(default = "default_idle_status")]
    pub status: String,
    #[serde(default = "default_source")]
    pub source: String,
    #[serde(default)]
    pub event: String,
    #[serde(default = "default_idle_summary")]
    pub summary: String,
    #[serde(default)]
    pub detail: String,
    #[serde(default = "now_timestamp")]
    pub updated_at: String,
    #[serde(default)]
    pub ttl_ms: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventPayload {
    #[serde(default = "default_idle_status")]
    pub status: String,
    #[serde(default = "default_source")]
    pub source: String,
    #[serde(default)]
    pub event: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub detail: String,
    #[serde(default = "now_timestamp")]
    pub created_at: String,
}

fn default_idle_status() -> String {
    "idle".to_string()
}

fn default_source() -> String {
    "indicator".to_string()
}

fn default_idle_summary() -> String {
    "无活动".to_string()
}

fn project_root() -> PathBuf {
    PathBuf::from(PROJECT_ROOT)
}

fn codex_sessions_root() -> PathBuf {
    PathBuf::from(CODEX_SESSIONS_ROOT)
}

fn state_path(root: &Path) -> PathBuf {
    root.join("state").join("status.json")
}

fn events_path(root: &Path) -> PathBuf {
    root.join("state").join("events.jsonl")
}

fn logs_path(root: &Path) -> PathBuf {
    root.join("logs").join("indicator.log")
}

fn now_timestamp() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

fn is_known_status(status: &str) -> bool {
    matches!(
        status,
        "waiting" | "running" | "done" | "error" | "interrupted" | "idle"
    )
}

fn is_priority_status(status: &str) -> bool {
    matches!(status, "waiting" | "error" | "interrupted")
}

fn idle_with_summary(summary: impl Into<String>) -> StatusPayload {
    StatusPayload {
        status: default_idle_status(),
        source: default_source(),
        event: String::new(),
        summary: summary.into(),
        detail: String::new(),
        updated_at: now_timestamp(),
        ttl_ms: 0,
    }
}

fn running_from_codex_session() -> StatusPayload {
    StatusPayload {
        status: "running".to_string(),
        source: "codex".to_string(),
        event: String::new(),
        summary: "Codex 运行中".to_string(),
        detail: String::new(),
        updated_at: now_timestamp(),
        ttl_ms: 0,
    }
}

fn append_log(root: &Path, message: &str) {
    let _ = fs::create_dir_all(root.join("logs"));
    if let Ok(mut file) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(logs_path(root))
    {
        let _ = writeln!(file, "[{}] {}", now_timestamp(), message);
    }
}

fn ensure_project_dirs(root: &Path) -> Result<(), String> {
    fs::create_dir_all(root.join("state")).map_err(|error| error.to_string())?;
    fs::create_dir_all(root.join("logs")).map_err(|error| error.to_string())?;
    Ok(())
}

pub fn read_status_from_dir(root: &Path) -> StatusPayload {
    let path = state_path(root);
    let content = match fs::read_to_string(&path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return idle_with_summary("无活动");
        }
        Err(error) => {
            let summary = format!("状态文件不可读: {}", error);
            append_log(root, &summary);
            return idle_with_summary(summary);
        }
    };

    match serde_json::from_str::<StatusPayload>(&content) {
        Ok(payload) if is_known_status(&payload.status) => payload,
        Ok(payload) => {
            let summary = format!("未知状态: {}", payload.status);
            append_log(root, &summary);
            idle_with_summary(summary)
        }
        Err(error) => {
            let summary = format!("状态文件不可读: {}", error);
            append_log(root, &summary);
            idle_with_summary(summary)
        }
    }
}

pub fn read_effective_status_from_dirs(root: &Path, sessions_root: &Path) -> StatusPayload {
    let payload = read_status_from_dir(root);
    if is_priority_status(&payload.status) || is_fresh_done(&payload) {
        return payload;
    }

    if latest_codex_session_is_running(sessions_root) {
        return running_from_codex_session();
    }

    payload
}

fn is_fresh_done(payload: &StatusPayload) -> bool {
    if payload.status != "done" {
        return false;
    }

    let Ok(updated_at) = OffsetDateTime::parse(&payload.updated_at, &Rfc3339) else {
        return false;
    };
    let age = OffsetDateTime::now_utc() - updated_at;
    let age_ms = age.whole_milliseconds();
    (0..DONE_SETTLE_MS).contains(&age_ms)
}

fn latest_codex_session_is_running(sessions_root: &Path) -> bool {
    let Some(path) = latest_codex_session_file(sessions_root) else {
        return false;
    };
    let Ok(content) = fs::read_to_string(path) else {
        return false;
    };

    session_content_has_unfinished_turn(&content)
}

fn latest_codex_session_file(sessions_root: &Path) -> Option<PathBuf> {
    let mut day_dirs = Vec::new();
    for year in read_numeric_dirs(sessions_root) {
        for month in read_numeric_dirs(&year) {
            for day in read_numeric_dirs(&month) {
                day_dirs.push(day);
            }
        }
    }

    day_dirs.sort();
    day_dirs.reverse();

    day_dirs
        .into_iter()
        .take(3)
        .filter_map(latest_jsonl_in_dir)
        .max_by_key(|(_, modified)| *modified)
        .map(|(path, _)| path)
}

fn read_numeric_dirs(path: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(path) else {
        return Vec::new();
    };

    let mut dirs = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.chars().all(|ch| ch.is_ascii_digit()))
        })
        .collect::<Vec<_>>();
    dirs.sort();
    dirs
}

fn latest_jsonl_in_dir(dir: PathBuf) -> Option<(PathBuf, std::time::SystemTime)> {
    let entries = fs::read_dir(dir).ok()?;
    entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|ext| ext.to_str()) == Some("jsonl"))
        .filter_map(|path| {
            let modified = fs::metadata(&path).ok()?.modified().ok()?;
            Some((path, modified))
        })
        .max_by_key(|(_, modified)| *modified)
}

#[derive(Default)]
struct CodexTurnState {
    turn_id: Option<String>,
    started: bool,
    activity: bool,
    final_message: bool,
    completed: bool,
}

fn session_content_has_unfinished_turn(content: &str) -> bool {
    let mut turn = CodexTurnState::default();

    for line in content.lines() {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let Some(turn_id) = extract_turn_id(&value) else {
            continue;
        };

        if turn.turn_id.as_deref() != Some(turn_id.as_str()) {
            turn = CodexTurnState {
                turn_id: Some(turn_id),
                ..CodexTurnState::default()
            };
        }

        apply_session_event(&value, &mut turn);
    }

    turn.turn_id.is_some()
        && (turn.started || turn.activity)
        && !turn.final_message
        && !turn.completed
}

fn extract_turn_id(value: &Value) -> Option<String> {
    string_at(value, &["payload", "turn_id"])
        .or_else(|| {
            string_at(
                value,
                &[
                    "payload",
                    "internal_chat_message_metadata_passthrough",
                    "turn_id",
                ],
            )
        })
        .map(str::to_string)
}

fn apply_session_event(value: &Value, turn: &mut CodexTurnState) {
    let outer_type = string_at(value, &["type"]).unwrap_or_default();
    let payload_type = string_at(value, &["payload", "type"]).unwrap_or_default();

    if outer_type == "event_msg" {
        match payload_type {
            "task_started" => {
                turn.started = true;
                turn.activity = true;
            }
            "task_complete" => turn.completed = true,
            "agent_message" if string_at(value, &["payload", "phase"]) == Some("final_answer") => {
                turn.final_message = true;
            }
            _ => {}
        }
        return;
    }

    if outer_type != "response_item" {
        return;
    }

    match payload_type {
        "reasoning"
        | "function_call"
        | "function_call_output"
        | "custom_tool_call"
        | "custom_tool_call_output" => turn.activity = true,
        "message"
            if string_at(value, &["payload", "role"]) == Some("assistant")
                && string_at(value, &["payload", "phase"]) == Some("final_answer") =>
        {
            turn.final_message = true;
        }
        _ => {}
    }
}

fn string_at<'a>(value: &'a Value, path: &[&str]) -> Option<&'a str> {
    let mut current = value;
    for key in path {
        current = current.get(*key)?;
    }
    current.as_str()
}

pub fn read_recent_events_from_dir(root: &Path, limit: usize) -> Vec<EventPayload> {
    let path = events_path(root);
    let content = match fs::read_to_string(&path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Vec::new(),
        Err(error) => {
            append_log(root, &format!("事件文件不可读: {}", error));
            return Vec::new();
        }
    };

    content
        .lines()
        .rev()
        .filter_map(|line| serde_json::from_str::<EventPayload>(line).ok())
        .filter(|event| is_known_status(&event.status))
        .take(limit.min(100))
        .collect()
}

#[tauri::command]
fn get_status() -> StatusPayload {
    read_effective_status_from_dirs(&project_root(), &codex_sessions_root())
}

#[tauri::command]
fn get_recent_events(limit: Option<usize>) -> Vec<EventPayload> {
    read_recent_events_from_dir(&project_root(), limit.unwrap_or(20))
}

#[tauri::command]
fn open_state_dir() -> Result<(), String> {
    let root = project_root();
    ensure_project_dirs(&root)?;
    tauri_plugin_opener::open_path(root.join("state"), None::<&str>)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn open_logs_dir() -> Result<(), String> {
    let root = project_root();
    ensure_project_dirs(&root)?;
    tauri_plugin_opener::open_path(root.join("logs"), None::<&str>)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn set_always_on_top(app: AppHandle, enabled: bool) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        window
            .set_always_on_top(enabled)
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn hide_window(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        window.hide().map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn set_panel_open(app: AppHandle, open: bool) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let height = if open { 300.0 } else { 72.0 };
        window
            .set_size(tauri::LogicalSize::new(220.0, height))
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.show();
        let _ = window.set_focus();
        let _ = app.emit_to(MAIN_WINDOW, OPEN_EVENTS, ());
    }
}

fn toggle_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        match window.is_visible() {
            Ok(true) => {
                let _ = window.hide();
            }
            _ => show_main_window(app),
        }
    }
}

fn open_dir(root: &Path, name: &str) {
    let path = root.join(name);
    if let Err(error) = ensure_project_dirs(root).and_then(|_| {
        tauri_plugin_opener::open_path(&path, None::<&str>).map_err(|e| e.to_string())
    }) {
        append_log(root, &format!("打开目录失败 {}: {}", path.display(), error));
    }
}

fn setup_tray(app: &mut tauri::App) -> tauri::Result<()> {
    let show_hide = MenuItemBuilder::with_id("show_hide", "显示/隐藏").build(app)?;
    let always_top = CheckMenuItemBuilder::with_id("always_top", "窗口置顶")
        .checked(true)
        .build(app)?;
    let open_state = MenuItemBuilder::with_id("open_state", "打开状态目录").build(app)?;
    let open_logs = MenuItemBuilder::with_id("open_logs", "打开日志目录").build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "退出").build(app)?;
    let menu = MenuBuilder::new(app)
        .item(&show_hide)
        .item(&always_top)
        .separator()
        .item(&open_state)
        .item(&open_logs)
        .separator()
        .item(&quit)
        .build()?;

    let root = project_root();
    let always_top_for_menu = always_top.clone();
    let mut tray = TrayIconBuilder::with_id("indicator")
        .menu(&menu)
        .tooltip("AI 状态指示器")
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "show_hide" => toggle_main_window(app),
            "always_top" => {
                let checked = always_top_for_menu.is_checked().unwrap_or(true);
                let _ = set_always_on_top(app.clone(), checked);
            }
            "open_state" => open_dir(&root, "state"),
            "open_logs" => open_dir(&root, "logs"),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| match event {
            TrayIconEvent::DoubleClick {
                button: MouseButton::Left,
                ..
            } => show_main_window(tray.app_handle()),
            _ => {}
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        tray = tray.icon(icon);
    }

    tray.build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::new().build())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let root = project_root();
            if let Err(error) = ensure_project_dirs(&root) {
                append_log(&root, &format!("初始化目录失败: {}", error));
            }
            append_log(&root, "indicator started");
            setup_tray(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_status,
            get_recent_events,
            open_state_dir,
            open_logs_dir,
            set_always_on_top,
            hide_window,
            set_panel_open,
            quit_app
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
