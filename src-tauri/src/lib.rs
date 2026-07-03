use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs::{self, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, SystemTime},
};
use tauri::{
    menu::{CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder,
};
use time::{format_description::well_known::Rfc3339, OffsetDateTime};

// 移除硬编码路径，改为运行时检测
const DONE_SETTLE_MS: i128 = 3500;
const SESSION_RUNNING_TTL: Duration = Duration::from_secs(2 * 60);
const MAIN_WINDOW: &str = "main";
const SETTINGS_WINDOW: &str = "settings";
const OPEN_EVENTS: &str = "indicator-open-events";
const SETTINGS_CHANGED: &str = "indicator-settings-changed";

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

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    #[serde(default = "default_language")]
    pub language: String,
    #[serde(default = "default_theme")]
    pub theme: String,
    #[serde(default = "default_true")]
    pub show_main_window_on_launch: bool,
    #[serde(default = "default_true")]
    pub always_on_top: bool,
    #[serde(default = "default_true")]
    pub remember_window_state: bool,
    #[serde(default = "default_true")]
    pub minimize_to_tray: bool,
    #[serde(default = "default_panel_expanded_height")]
    pub panel_expanded_height: u32,
    #[serde(default = "default_path_mode")]
    pub state_dir_mode: String,
    #[serde(default)]
    pub state_dir: String,
    #[serde(default = "default_path_mode")]
    pub codex_sessions_dir_mode: String,
    #[serde(default)]
    pub codex_sessions_dir: String,
    #[serde(default = "default_poll_interval_ms")]
    pub poll_interval_ms: u32,
    #[serde(default = "default_true")]
    pub notify_on_waiting: bool,
    #[serde(default = "default_true")]
    pub notify_on_error: bool,
    #[serde(default = "default_show_done_settle_ms")]
    pub show_done_settle_ms: u32,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SettingsDiagnostics {
    pub settings_file: String,
    pub state_dir: String,
    pub logs_dir: String,
    pub codex_sessions_dir: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SettingsLoadResult {
    pub settings: AppSettings,
    pub load_error: Option<String>,
    pub diagnostics: SettingsDiagnostics,
}

impl Default for AppSettings {
    fn default() -> Self {
        default_settings()
    }
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

fn default_language() -> String {
    "zh-CN".to_string()
}

fn default_theme() -> String {
    "system".to_string()
}

fn default_path_mode() -> String {
    "auto".to_string()
}

fn default_true() -> bool {
    true
}

fn default_panel_expanded_height() -> u32 {
    300
}

fn default_poll_interval_ms() -> u32 {
    500
}

fn default_show_done_settle_ms() -> u32 {
    3500
}

pub fn default_settings() -> AppSettings {
    AppSettings {
        language: default_language(),
        theme: default_theme(),
        show_main_window_on_launch: true,
        always_on_top: true,
        remember_window_state: true,
        minimize_to_tray: true,
        panel_expanded_height: default_panel_expanded_height(),
        state_dir_mode: default_path_mode(),
        state_dir: String::new(),
        codex_sessions_dir_mode: default_path_mode(),
        codex_sessions_dir: String::new(),
        poll_interval_ms: default_poll_interval_ms(),
        notify_on_waiting: true,
        notify_on_error: true,
        show_done_settle_ms: default_show_done_settle_ms(),
    }
}

fn app_data_root() -> PathBuf {
    if let Ok(custom_root) = std::env::var("INDICATOR_APP_DATA_DIR") {
        return PathBuf::from(custom_root);
    }

    if let Some(data_dir) = dirs::data_dir() {
        return data_dir.join("com.indicator.app");
    }

    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

fn project_root() -> PathBuf {
    if let Ok(custom_root) = std::env::var("INDICATOR_STATE_DIR") {
        return PathBuf::from(custom_root);
    }

    let app_root = app_data_root();
    let settings = read_settings_from_dir(&app_root).settings;
    resolve_state_dir(&app_root, &settings)
}

fn settings_path(root: &Path) -> PathBuf {
    root.join("config").join("settings.json")
}

fn resolve_state_dir(app_root: &Path, settings: &AppSettings) -> PathBuf {
    if settings.state_dir_mode == "custom" && !settings.state_dir.trim().is_empty() {
        return PathBuf::from(settings.state_dir.trim());
    }

    app_root.to_path_buf()
}

fn resolve_codex_sessions_dir(settings: &AppSettings) -> PathBuf {
    if settings.codex_sessions_dir_mode == "custom"
        && !settings.codex_sessions_dir.trim().is_empty()
    {
        return PathBuf::from(settings.codex_sessions_dir.trim());
    }

    if let Some(home) = dirs::home_dir() {
        let codex_path = home.join(".codex").join("sessions");
        if codex_path.exists() {
            return codex_path;
        }
    }

    PathBuf::from("__codex_not_found__")
}

fn settings_diagnostics(root: &Path, settings: &AppSettings) -> SettingsDiagnostics {
    let state_dir = resolve_state_dir(root, settings);
    let logs_dir = state_dir.join("logs");
    SettingsDiagnostics {
        settings_file: settings_path(root).display().to_string(),
        state_dir: state_dir.display().to_string(),
        logs_dir: logs_dir.display().to_string(),
        codex_sessions_dir: resolve_codex_sessions_dir(settings).display().to_string(),
    }
}

fn normalize_settings(mut settings: AppSettings) -> AppSettings {
    if !matches!(settings.language.as_str(), "zh-CN" | "en-US") {
        settings.language = default_language();
    }
    if !matches!(settings.theme.as_str(), "system" | "light" | "dark") {
        settings.theme = default_theme();
    }
    if !matches!(settings.state_dir_mode.as_str(), "auto" | "custom") {
        settings.state_dir_mode = default_path_mode();
    }
    if !matches!(settings.codex_sessions_dir_mode.as_str(), "auto" | "custom") {
        settings.codex_sessions_dir_mode = default_path_mode();
    }

    settings.state_dir = settings.state_dir.trim().to_string();
    settings.codex_sessions_dir = settings.codex_sessions_dir.trim().to_string();
    settings.panel_expanded_height = settings.panel_expanded_height.clamp(220, 620);
    settings.poll_interval_ms = settings.poll_interval_ms.clamp(250, 10_000);
    settings.show_done_settle_ms = settings.show_done_settle_ms.clamp(500, 30_000);
    settings
}

pub fn read_settings_from_dir(root: &Path) -> SettingsLoadResult {
    let path = settings_path(root);
    let content = match fs::read_to_string(&path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let settings = default_settings();
            return SettingsLoadResult {
                diagnostics: settings_diagnostics(root, &settings),
                settings,
                load_error: None,
            };
        }
        Err(error) => {
            let settings = default_settings();
            return SettingsLoadResult {
                diagnostics: settings_diagnostics(root, &settings),
                settings,
                load_error: Some(format!("设置文件不可读: {}", error)),
            };
        }
    };

    match serde_json::from_str::<AppSettings>(&content) {
        Ok(settings) => {
            let settings = normalize_settings(settings);
            SettingsLoadResult {
                diagnostics: settings_diagnostics(root, &settings),
                settings,
                load_error: None,
            }
        }
        Err(error) => {
            let settings = default_settings();
            SettingsLoadResult {
                diagnostics: settings_diagnostics(root, &settings),
                settings,
                load_error: Some(format!("设置文件不可读: {}", error)),
            }
        }
    }
}

pub fn save_settings_to_dir(root: &Path, settings: &AppSettings) -> Result<AppSettings, String> {
    let settings = normalize_settings(settings.clone());
    fs::create_dir_all(root.join("config")).map_err(|error| error.to_string())?;
    let content = serde_json::to_string_pretty(&settings).map_err(|error| error.to_string())?;
    fs::write(settings_path(root), content).map_err(|error| error.to_string())?;
    Ok(settings)
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

fn waiting_from_codex_session() -> StatusPayload {
    StatusPayload {
        status: "waiting".to_string(),
        source: "codex".to_string(),
        event: "PermissionRequest".to_string(),
        summary: "Codex 正在等待批准".to_string(),
        detail: String::new(),
        updated_at: now_timestamp(),
        ttl_ms: 0,
    }
}

fn interrupted_from_codex_session() -> StatusPayload {
    StatusPayload {
        status: "interrupted".to_string(),
        source: "codex".to_string(),
        event: "turn_aborted".to_string(),
        summary: "Codex 已中断".to_string(),
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

    match latest_codex_session_status(sessions_root) {
        CodexSessionStatus::Waiting => waiting_from_codex_session(),
        CodexSessionStatus::Interrupted => interrupted_from_codex_session(),
        CodexSessionStatus::Running => running_from_codex_session(),
        CodexSessionStatus::Idle => payload,
    }
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CodexSessionStatus {
    Idle,
    Running,
    Waiting,
    Interrupted,
}

// 会话解析缓存：状态默认每 500ms 轮询一次，而会话 jsonl 是追加写。
// 无缓存时每次轮询都要全量读取并逐行解析整个文件，成本随文件增长线性上升；
// 有缓存后：文件未变化直接复用结果，追加时只解析新增字节，成本只与增量成正比。
struct SessionParseCache {
    path: PathBuf,
    size: u64,
    modified: SystemTime,
    /// 已解析到最后一个完整行行尾的字节偏移（结尾的半行等补全后再解析）
    consumed: u64,
    /// 跨轮询延续的 turn 状态机
    turn: CodexTurnState,
}

static SESSION_PARSE_CACHE: Mutex<Option<SessionParseCache>> = Mutex::new(None);

fn latest_codex_session_status(sessions_root: &Path) -> CodexSessionStatus {
    let Some((path, modified, size)) = latest_codex_session_file(sessions_root) else {
        return CodexSessionStatus::Idle;
    };

    match cached_session_status(&path, modified, size) {
        CodexSessionStatus::Running if !session_file_is_recent(modified) => {
            CodexSessionStatus::Idle
        }
        status => status,
    }
}

fn cached_session_status(path: &Path, modified: SystemTime, size: u64) -> CodexSessionStatus {
    let mut guard = match SESSION_PARSE_CACHE.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };

    if let Some(cache) = guard.as_mut() {
        if cache.path == path {
            // 文件未变化：直接复用上次的状态机结果
            if cache.size == size && cache.modified == modified {
                return turn_state_status(&cache.turn);
            }

            // 只增长：按追加写处理，从上次偏移继续解析新增行
            if size > cache.size {
                if let Some(consumed) =
                    apply_appended_lines(path, cache.consumed, &mut cache.turn)
                {
                    cache.consumed = consumed;
                    cache.size = size;
                    cache.modified = modified;
                    return turn_state_status(&cache.turn);
                }
            }
        }
    }

    // 新文件、被截断/重写或增量读取失败：全量重建缓存
    let Ok(content) = fs::read_to_string(path) else {
        *guard = None;
        return CodexSessionStatus::Idle;
    };

    let mut turn = CodexTurnState::default();
    apply_session_content(&content, &mut turn);
    let status = turn_state_status(&turn);
    // 偏移只推进到最后一个完整行的行尾；结尾的半行等写完后随下次增量一起解析
    let consumed = content
        .as_bytes()
        .iter()
        .rposition(|&byte| byte == b'\n')
        .map(|index| index + 1)
        .unwrap_or(0) as u64;
    *guard = Some(SessionParseCache {
        path: path.to_path_buf(),
        size,
        modified,
        consumed,
        turn,
    });
    status
}

// 从 consumed 偏移读取新增内容并应用到状态机；返回新的已消费偏移。
// 只解析完整行——写到一半的行留到下次轮询补全后再解析。
fn apply_appended_lines(path: &Path, consumed: u64, turn: &mut CodexTurnState) -> Option<u64> {
    let mut file = fs::File::open(path).ok()?;
    file.seek(SeekFrom::Start(consumed)).ok()?;
    let mut buffer = Vec::new();
    file.read_to_end(&mut buffer).ok()?;

    // 新增内容里没有换行符：还是半行，什么都不消费
    let Some(last_newline) = buffer.iter().rposition(|&byte| byte == b'\n') else {
        return Some(consumed);
    };

    let complete = &buffer[..=last_newline];
    apply_session_content(&String::from_utf8_lossy(complete), turn);
    Some(consumed + complete.len() as u64)
}

fn session_file_is_recent(modified: SystemTime) -> bool {
    match SystemTime::now().duration_since(modified) {
        Ok(age) => age <= SESSION_RUNNING_TTL,
        Err(_) => true,
    }
}

fn latest_codex_session_file(sessions_root: &Path) -> Option<(PathBuf, SystemTime, u64)> {
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
        .max_by_key(|(_, modified, _)| *modified)
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

// 返回值带上文件大小，供解析缓存判断"未变化 / 追加 / 截断"
fn latest_jsonl_in_dir(dir: PathBuf) -> Option<(PathBuf, SystemTime, u64)> {
    let entries = fs::read_dir(dir).ok()?;
    entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|ext| ext.to_str()) == Some("jsonl"))
        .filter_map(|path| {
            let metadata = fs::metadata(&path).ok()?;
            let modified = metadata.modified().ok()?;
            Some((path, modified, metadata.len()))
        })
        .max_by_key(|(_, modified, _)| *modified)
}

#[derive(Default)]
struct CodexTurnState {
    turn_id: Option<String>,
    started: bool,
    activity: bool,
    final_message: bool,
    completed: bool,
    waiting: bool,
    waiting_call_id: Option<String>,
    interrupted: bool,
}

// 遍历事件行，把内容应用到（可跨轮询延续的）turn 状态机上
fn apply_session_content(content: &str, turn: &mut CodexTurnState) {
    for line in content.lines() {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let Some(turn_id) = extract_turn_id(&value) else {
            continue;
        };

        // 当检测到新的 turn_id，重置状态
        if turn.turn_id.as_deref() != Some(turn_id.as_str()) {
            *turn = CodexTurnState {
                turn_id: Some(turn_id),
                ..CodexTurnState::default()
            };
        }

        apply_session_event(&value, turn);
    }
}

// 状态判断优先级（从高到低）：
// 1. 无 turn 或已完成/最终消息 -> Idle
// 2. 已中断 -> Interrupted
// 3. 等待批准 -> Waiting
// 4. 有活动且未完成 -> Running
// 5. 其他情况 -> Idle
fn turn_state_status(turn: &CodexTurnState) -> CodexSessionStatus {
    if turn.turn_id.is_none() || turn.final_message || turn.completed {
        CodexSessionStatus::Idle
    } else if turn.interrupted {
        CodexSessionStatus::Interrupted
    } else if turn.waiting {
        CodexSessionStatus::Waiting
    } else if turn.started || turn.activity {
        CodexSessionStatus::Running
    } else {
        CodexSessionStatus::Idle
    }
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
        // 中断状态最优先，且不可被其他状态覆盖
        if is_interrupted_event(payload_type) {
            turn.interrupted = true;
            turn.waiting = false;  // 清除等待状态
            turn.activity = false; // 清除活动状态
            return;
        }

        // 完成状态会清除活动标记
        if payload_type == "task_complete" {
            turn.completed = true;
            turn.activity = false; // 任务完成后不再有活动
            return;
        }

        // 最终消息标记完成
        if payload_type == "agent_message" && string_at(value, &["payload", "phase"]) == Some("final_answer") {
            turn.final_message = true;
            turn.activity = false; // 已发送最终答案，活动结束
            return;
        }

        // 权限请求只在未中断时生效
        if !turn.interrupted && is_permission_request_event(value, payload_type) {
            turn.waiting = true;
            return;
        }

        // 任务开始
        if payload_type == "task_started" {
            turn.started = true;
            turn.activity = true;
        }

        return;
    }

    if outer_type != "response_item" {
        return;
    }

    // 如果已经中断或完成，不再处理新的活动
    if turn.interrupted || turn.completed || turn.final_message {
        return;
    }

    match payload_type {
        "reasoning" => turn.activity = true,
        "function_call" | "custom_tool_call" => {
            turn.activity = true;
            // 检查是否需要用户交互
            if contains_required_escalation(value) || is_user_interaction_tool(value) {
                turn.waiting = true;
                turn.waiting_call_id = extract_call_id(value).map(str::to_string);
            }
        }
        "function_call_output" | "custom_tool_call_output" => {
            turn.activity = true;
            clear_waiting_call_if_resolved(value, turn);
        }
        "message"
            if string_at(value, &["payload", "role"]) == Some("assistant")
                && string_at(value, &["payload", "phase"]) == Some("final_answer") =>
        {
            turn.final_message = true;
            turn.activity = false; // 最终消息意味着活动结束
        }
        _ => {}
    }
}

fn is_interrupted_event(payload_type: &str) -> bool {
    matches!(
        payload_type,
        "turn_aborted"
            | "turn_interrupted"
            | "interrupted"
            | "user_interrupted"
            | "user-interrupted"
    )
}

fn is_permission_request_event(value: &Value, payload_type: &str) -> bool {
    matches!(
        payload_type,
        "PermissionRequest" | "permission_request" | "permission-request" | "approval_request"
    ) || string_at(value, &["payload", "hook_event_name"]) == Some("PermissionRequest")
        || string_at(value, &["payload", "hook-event-name"]) == Some("PermissionRequest")
}

fn extract_call_id(value: &Value) -> Option<&str> {
    string_at(value, &["payload", "call_id"])
        .or_else(|| string_at(value, &["payload", "id"]))
        .or_else(|| string_at(value, &["payload", "tool_call_id"]))
}

fn clear_waiting_call_if_resolved(value: &Value, turn: &mut CodexTurnState) {
    if !turn.waiting {
        return;
    }

    match (turn.waiting_call_id.as_deref(), extract_call_id(value)) {
        (None, _) => turn.waiting = false,
        (Some(waiting_id), Some(output_id)) if waiting_id == output_id => {
            turn.waiting = false;
            turn.waiting_call_id = None;
        }
        _ => {}
    }
}

fn contains_required_escalation(value: &Value) -> bool {
    match value {
        Value::Object(map) => map.iter().any(|(key, child)| {
            if key == "sandbox_permissions" && child.as_str() == Some("require_escalated") {
                return true;
            }

            if key == "arguments" {
                if let Some(text) = child.as_str() {
                    if text.contains("sandbox_permissions") && text.contains("require_escalated") {
                        return serde_json::from_str::<Value>(text)
                            .map(|parsed| contains_required_escalation(&parsed))
                            .unwrap_or(true);
                    }
                }
            }

            contains_required_escalation(child)
        }),
        Value::Array(items) => items.iter().any(contains_required_escalation),
        _ => false,
    }
}

// 检测需要用户交互的工具调用
// 用于识别 AskUserQuestion 等需要用户输入的工具
fn is_user_interaction_tool(value: &Value) -> bool {
    // 检查工具名称是否为 AskUserQuestion
    if let Some(tool_name) = string_at(value, &["payload", "name"]) {
        if tool_name == "AskUserQuestion" {
            return true;
        }
    }

    // 也检查 function_name 字段（某些版本可能使用这个字段）
    if let Some(function_name) = string_at(value, &["payload", "function_name"]) {
        if function_name == "AskUserQuestion" {
            return true;
        }
    }

    false
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

// 状态轮询热路径：一次调用解析出两个扫描根目录。
// 之前 project_root() 与 codex_sessions_root() 各自读取并解析一遍 settings.json，
// 每次轮询多出两次磁盘读取；这里合并为最多读一次。
fn status_scan_roots() -> (PathBuf, PathBuf) {
    let env_state = std::env::var("INDICATOR_STATE_DIR").ok().map(PathBuf::from);
    let env_sessions = std::env::var("CODEX_SESSIONS_DIR").ok().map(PathBuf::from);

    // 两个目录都被环境变量覆盖时，无需读设置文件
    if let (Some(state), Some(sessions)) = (env_state.as_ref(), env_sessions.as_ref()) {
        return (state.clone(), sessions.clone());
    }

    let app_root = app_data_root();
    let settings = read_settings_from_dir(&app_root).settings;
    (
        env_state.unwrap_or_else(|| resolve_state_dir(&app_root, &settings)),
        env_sessions.unwrap_or_else(|| resolve_codex_sessions_dir(&settings)),
    )
}

// async：让文件扫描与解析跑在 tauri 异步线程池，避免同步命令阻塞主线程导致 UI 卡顿
#[tauri::command]
async fn get_status() -> StatusPayload {
    let (state_root, sessions_root) = status_scan_roots();
    read_effective_status_from_dirs(&state_root, &sessions_root)
}

#[tauri::command]
async fn get_recent_events(limit: Option<usize>) -> Vec<EventPayload> {
    read_recent_events_from_dir(&project_root(), limit.unwrap_or(20))
}

#[tauri::command]
fn get_settings() -> SettingsLoadResult {
    read_settings_from_dir(&app_data_root())
}

#[tauri::command]
fn save_settings(app: AppHandle, settings: AppSettings) -> Result<SettingsLoadResult, String> {
    let app_root = app_data_root();
    let settings = save_settings_to_dir(&app_root, &settings)?;
    apply_runtime_settings(&app, &settings);
    let result = read_settings_from_dir(&app_root);
    let _ = app.emit(SETTINGS_CHANGED, &result.settings);
    Ok(result)
}

#[tauri::command]
fn reset_settings(app: AppHandle) -> Result<SettingsLoadResult, String> {
    let app_root = app_data_root();
    let settings = save_settings_to_dir(&app_root, &default_settings())?;
    apply_runtime_settings(&app, &settings);
    let result = read_settings_from_dir(&app_root);
    let _ = app.emit(SETTINGS_CHANGED, &result.settings);
    Ok(result)
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
fn clear_recent_events() -> Result<(), String> {
    let root = project_root();
    ensure_project_dirs(&root)?;
    match fs::remove_file(events_path(&root)) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
async fn open_settings_window(app: AppHandle) -> Result<(), String> {
    open_settings_window_for_app(&app)
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
fn set_panel_open(
    app: AppHandle,
    open: bool,
    panel_expanded_height: Option<f64>,
) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let expanded_height = panel_expanded_height
            .unwrap_or(default_panel_expanded_height() as f64)
            .clamp(220.0, 620.0);
        let height = if open { expanded_height } else { 72.0 };
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

fn apply_runtime_settings(app: &AppHandle, settings: &AppSettings) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.set_always_on_top(settings.always_on_top);
    }
}

fn open_settings_window_for_app(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(SETTINGS_WINDOW) {
        window.show().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
        return Ok(());
    }

    WebviewWindowBuilder::new(app, SETTINGS_WINDOW, WebviewUrl::App("index.html".into()))
        .title("设置")
        .inner_size(760.0, 620.0)
        .min_inner_size(620.0, 480.0)
        .resizable(true)
        .decorations(true)
        .skip_taskbar(false)
        .center()
        .build()
        .map_err(|error| error.to_string())?;
    Ok(())
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
    let settings = read_settings_from_dir(&app_data_root()).settings;
    let show_hide = MenuItemBuilder::with_id("show_hide", "显示/隐藏").build(app)?;
    let settings_item = MenuItemBuilder::with_id("settings", "设置").build(app)?;
    let always_top = CheckMenuItemBuilder::with_id("always_top", "窗口置顶")
        .checked(settings.always_on_top)
        .build(app)?;
    let open_state = MenuItemBuilder::with_id("open_state", "打开状态目录").build(app)?;
    let open_logs = MenuItemBuilder::with_id("open_logs", "打开日志目录").build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "退出").build(app)?;
    let menu = MenuBuilder::new(app)
        .item(&show_hide)
        .item(&settings_item)
        .item(&always_top)
        .separator()
        .item(&open_state)
        .item(&open_logs)
        .separator()
        .item(&quit)
        .build()?;

    let always_top_for_menu = always_top.clone();
    let mut tray = TrayIconBuilder::with_id("indicator")
        .menu(&menu)
        .tooltip("AI 状态指示器")
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "show_hide" => toggle_main_window(app),
            "settings" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = open_settings_window_for_app(&app);
                });
            }
            "always_top" => {
                let checked = always_top_for_menu.is_checked().unwrap_or(true);
                let _ = set_always_on_top(app.clone(), checked);
            }
            "open_state" => open_dir(&project_root(), "state"),
            "open_logs" => open_dir(&project_root(), "logs"),
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
            let settings = read_settings_from_dir(&app_data_root()).settings;
            let root = project_root();
            if let Err(error) = ensure_project_dirs(&root) {
                append_log(&root, &format!("初始化目录失败: {}", error));
            }
            apply_runtime_settings(app.handle(), &settings);
            if !settings.show_main_window_on_launch {
                if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
                    let _ = window.hide();
                }
            }
            append_log(&root, "indicator started");
            setup_tray(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_status,
            get_recent_events,
            get_settings,
            save_settings,
            reset_settings,
            open_state_dir,
            open_logs_dir,
            clear_recent_events,
            open_settings_window,
            set_always_on_top,
            hide_window,
            set_panel_open,
            quit_app
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
