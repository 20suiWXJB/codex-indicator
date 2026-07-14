use dock::{detect_dock_edge, dock_geometry, DockEdge, DockMode, DockState, Rect, PILL_H, PILL_W};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{LazyLock, Mutex},
    time::{Duration, SystemTime},
};
use tauri::{
    menu::{CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, Monitor, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};
use time::{format_description::well_known::Rfc3339, OffsetDateTime};

pub mod dock;

// 移除硬编码路径，改为运行时检测
const DONE_SETTLE_MS: i128 = 3500;
const DEFAULT_SESSION_RUNNING_TTL: Duration = Duration::from_secs(2 * 60);
const DEFAULT_ACTIVE_SESSION_TTL: Duration = Duration::from_secs(10 * 60);
const MAIN_WINDOW: &str = "main";
const SETTINGS_WINDOW: &str = "settings";
const OPEN_EVENTS: &str = "indicator-open-events";
const SETTINGS_CHANGED: &str = "indicator-settings-changed";
const NATIVE_DRAG_RELEASE_POLL_INTERVAL: Duration = Duration::from_millis(20);
const NATIVE_DRAG_RELEASE_SETTLE_DELAY: Duration = Duration::from_millis(50);
const NATIVE_DRAG_RELEASE_MAX_POLLS: usize = 1_500;
static CURRENT_DOCK_MODE: LazyLock<Mutex<Option<DockMode>>> = LazyLock::new(|| Mutex::new(None));

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

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InstanceStatus {
    pub id: String,
    pub label: String,
    pub cwd: String,
    pub status: String,
    pub summary: String,
    pub detail: String,
    pub updated_at: String,
    pub ttl_ms: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MultiStatusPayload {
    pub aggregate: StatusPayload,
    pub instances: Vec<InstanceStatus>,
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
    #[serde(default)]
    pub instance: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub cwd: String,
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
    #[serde(default = "default_true")]
    pub edge_dock_enabled: bool,
    #[serde(default = "default_dock_hide_delay_ms")]
    pub dock_hide_delay_ms: u32,
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
    #[serde(default = "default_instance_active_window_minutes")]
    pub instance_active_window_minutes: u32,
    #[serde(default = "default_session_running_ttl_seconds")]
    pub session_running_ttl_seconds: u32,
    #[serde(default = "default_true")]
    pub show_instance_list: bool,
    #[serde(default = "default_true")]
    pub event_instance_prefix: bool,
    #[serde(default = "default_true")]
    pub notify_on_waiting: bool,
    #[serde(default = "default_true")]
    pub notify_on_error: bool,
    #[serde(default = "default_show_done_settle_ms")]
    pub show_done_settle_ms: u32,
    #[serde(default = "default_true")]
    pub running_breath_enabled: bool,
    #[serde(default = "default_running_breath_period_ms")]
    pub running_breath_period_ms: u32,
    #[serde(default = "default_true")]
    pub status_blink_enabled: bool,
    #[serde(default = "default_status_blink_count")]
    pub status_blink_count: u32,
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

fn default_dock_hide_delay_ms() -> u32 {
    600
}

fn default_poll_interval_ms() -> u32 {
    500
}

fn default_instance_active_window_minutes() -> u32 {
    10
}

fn default_session_running_ttl_seconds() -> u32 {
    120
}

fn default_show_done_settle_ms() -> u32 {
    3500
}

fn default_running_breath_period_ms() -> u32 {
    2400
}

fn default_status_blink_count() -> u32 {
    3
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
        edge_dock_enabled: true,
        dock_hide_delay_ms: default_dock_hide_delay_ms(),
        state_dir_mode: default_path_mode(),
        state_dir: String::new(),
        codex_sessions_dir_mode: default_path_mode(),
        codex_sessions_dir: String::new(),
        poll_interval_ms: default_poll_interval_ms(),
        instance_active_window_minutes: default_instance_active_window_minutes(),
        session_running_ttl_seconds: default_session_running_ttl_seconds(),
        show_instance_list: true,
        event_instance_prefix: true,
        notify_on_waiting: true,
        notify_on_error: true,
        show_done_settle_ms: default_show_done_settle_ms(),
        running_breath_enabled: true,
        running_breath_period_ms: default_running_breath_period_ms(),
        status_blink_enabled: true,
        status_blink_count: default_status_blink_count(),
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

fn dock_state_path() -> PathBuf {
    app_data_root().join("config").join("dock-state.json")
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
    settings.dock_hide_delay_ms = settings.dock_hide_delay_ms.clamp(200, 3_000);
    settings.poll_interval_ms = settings.poll_interval_ms.clamp(250, 10_000);
    settings.instance_active_window_minutes = settings.instance_active_window_minutes.clamp(1, 60);
    settings.session_running_ttl_seconds = settings.session_running_ttl_seconds.clamp(30, 1_800);
    settings.show_done_settle_ms = settings.show_done_settle_ms.clamp(500, 30_000);
    settings.running_breath_period_ms = settings.running_breath_period_ms.clamp(800, 6_000);
    settings.status_blink_count = settings.status_blink_count.clamp(1, 10);
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

fn waiting_from_codex_session(kind: WaitKind) -> StatusPayload {
    let (event, summary) = match kind {
        WaitKind::Approval => ("PermissionRequest", "Codex 正在等待批准"),
        WaitKind::Question => ("Question", "Codex 正在等你选择选项"),
    };
    StatusPayload {
        status: "waiting".to_string(),
        source: "codex".to_string(),
        event: event.to_string(),
        summary: summary.to_string(),
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

fn wait_for_drag_release_with<P, S>(mut is_pressed: P, mut sleep: S, max_polls: usize) -> bool
where
    P: FnMut() -> bool,
    S: FnMut(Duration),
{
    for _ in 0..max_polls {
        if !is_pressed() {
            sleep(NATIVE_DRAG_RELEASE_SETTLE_DELAY);
            return true;
        }
        sleep(NATIVE_DRAG_RELEASE_POLL_INTERVAL);
    }
    false
}

#[cfg(target_os = "windows")]
fn wait_for_native_drag_release_inner() -> Result<(), String> {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};

    let released = wait_for_drag_release_with(
        || unsafe { GetAsyncKeyState(VK_LBUTTON as i32) < 0 },
        std::thread::sleep,
        NATIVE_DRAG_RELEASE_MAX_POLLS,
    );
    if released {
        Ok(())
    } else {
        Err("等待鼠标左键松开超时".to_string())
    }
}

#[cfg(not(target_os = "windows"))]
fn wait_for_native_drag_release_inner() -> Result<(), String> {
    Err("当前平台不支持原生拖动松手检测".to_string())
}

#[cfg(test)]
mod native_drag_release_tests {
    use super::*;
    use std::collections::VecDeque;

    #[test]
    fn returns_after_immediate_release_and_settle_delay() {
        let mut sleeps = Vec::new();
        let released = wait_for_drag_release_with(|| false, |delay| sleeps.push(delay), 3);

        assert!(released);
        assert_eq!(sleeps, vec![NATIVE_DRAG_RELEASE_SETTLE_DELAY]);
    }

    #[test]
    fn polls_while_pressed_then_waits_for_position_to_settle() {
        let mut states = VecDeque::from([true, true, false]);
        let mut sleeps = Vec::new();
        let released = wait_for_drag_release_with(
            || states.pop_front().unwrap_or(false),
            |delay| sleeps.push(delay),
            5,
        );

        assert!(released);
        assert_eq!(
            sleeps,
            vec![
                NATIVE_DRAG_RELEASE_POLL_INTERVAL,
                NATIVE_DRAG_RELEASE_POLL_INTERVAL,
                NATIVE_DRAG_RELEASE_SETTLE_DELAY,
            ]
        );
    }

    #[test]
    fn returns_timeout_after_poll_limit() {
        let mut sleeps = Vec::new();
        let released = wait_for_drag_release_with(|| true, |delay| sleeps.push(delay), 3);

        assert!(!released);
        assert_eq!(sleeps, vec![NATIVE_DRAG_RELEASE_POLL_INTERVAL; 3]);
    }

    #[test]
    fn reports_platform_support() {
        assert_eq!(
            is_native_drag_release_supported(),
            cfg!(target_os = "windows")
        );
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn unsupported_platform_returns_fallback_error() {
        assert!(wait_for_native_drag_release_inner().is_err());
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
    read_effective_statuses_from_dirs(root, sessions_root).aggregate
}

pub fn read_effective_statuses_from_dirs(root: &Path, sessions_root: &Path) -> MultiStatusPayload {
    read_effective_statuses_from_dirs_with_ttl(
        root,
        sessions_root,
        DEFAULT_ACTIVE_SESSION_TTL,
        DEFAULT_SESSION_RUNNING_TTL,
    )
}

pub fn read_effective_statuses_from_dirs_with_ttl(
    root: &Path,
    sessions_root: &Path,
    active_ttl: Duration,
    running_ttl: Duration,
) -> MultiStatusPayload {
    let payload = read_status_from_dir(root);
    let mut instances = active_codex_session_instances(sessions_root, active_ttl, running_ttl);
    let bridge_statuses = read_bridge_status_files(root, active_ttl);
    apply_bridge_statuses(&mut instances, &bridge_statuses);

    let instance_aggregate = aggregate_instance_statuses(&instances);
    let aggregate = if instances.len() > 1 {
        instance_aggregate
    } else if is_priority_status(&payload.status) || is_fresh_done(&payload) {
        payload
    } else if instance_aggregate.status == "idle" {
        payload
    } else {
        instance_aggregate
    };

    MultiStatusPayload {
        aggregate,
        instances,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
enum WaitKind {
    /// 等待用户批准权限（如沙箱升级请求）
    #[default]
    Approval,
    /// 等待用户回答问题（如 Codex 计划模式提问 / Claude Code AskUserQuestion）
    Question,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CodexSessionStatus {
    Idle,
    Running,
    Waiting(WaitKind),
    Interrupted,
}

// 会话解析缓存：状态默认每 500ms 轮询一次，而会话 jsonl 是追加写。
// 无缓存时每次轮询都要全量读取并逐行解析整个文件，成本随文件增长线性上升；
// 有缓存后：文件未变化直接复用结果，追加时只解析新增字节，成本只与增量成正比。
struct SessionParseCache {
    size: u64,
    modified: SystemTime,
    id: String,
    label: String,
    cwd: String,
    /// 已解析到最后一个完整行行尾的字节偏移（结尾的半行等补全后再解析）
    consumed: u64,
    /// 跨轮询延续的 turn 状态机
    turn: CodexTurnState,
}

#[derive(Debug, Clone)]
struct SessionStatusSnapshot {
    id: String,
    label: String,
    cwd: String,
    status: CodexSessionStatus,
    modified: SystemTime,
}

static SESSION_PARSE_CACHE: LazyLock<Mutex<HashMap<PathBuf, SessionParseCache>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn active_codex_session_instances(
    sessions_root: &Path,
    active_ttl: Duration,
    running_ttl: Duration,
) -> Vec<InstanceStatus> {
    let files = active_codex_session_files(sessions_root, active_ttl);
    let active_paths = files
        .iter()
        .map(|(path, _, _)| path.clone())
        .collect::<Vec<_>>();
    prune_inactive_session_caches(&active_paths);

    let mut snapshots = files
        .into_iter()
        .filter_map(|(path, modified, size)| {
            cached_session_snapshot(&path, modified, size, running_ttl)
        })
        .collect::<Vec<_>>();
    snapshots.sort_by(|left, right| right.modified.cmp(&left.modified));

    snapshots
        .into_iter()
        .map(|snapshot| {
            let payload = payload_from_session_status(snapshot.status, snapshot.modified);
            InstanceStatus {
                id: snapshot.id,
                label: snapshot.label,
                cwd: snapshot.cwd,
                status: payload.status,
                summary: payload.summary,
                detail: payload.detail,
                updated_at: system_time_timestamp(snapshot.modified),
                ttl_ms: 0,
            }
        })
        .collect()
}

fn cached_session_snapshot(
    path: &Path,
    modified: SystemTime,
    size: u64,
    running_ttl: Duration,
) -> Option<SessionStatusSnapshot> {
    let mut guard = match SESSION_PARSE_CACHE.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };

    if let Some(cache) = guard.get_mut(path) {
        // 文件未变化：直接复用上次的状态机结果
        if cache.size == size && cache.modified == modified {
            return Some(snapshot_from_cache(cache, running_ttl));
        }

        // 只增长：按追加写处理，从上次偏移继续解析新增行
        if size > cache.size {
            if let Some(consumed) = apply_appended_lines(path, cache.consumed, &mut cache.turn) {
                cache.consumed = consumed;
                cache.size = size;
                cache.modified = modified;
                return Some(snapshot_from_cache(cache, running_ttl));
            }
        }
    }

    // 新文件、被截断/重写或增量读取失败：全量重建缓存
    let Ok(content) = fs::read_to_string(path) else {
        guard.remove(path);
        return None;
    };

    let (id, label, cwd) = parse_session_identity(path, &content);
    let mut turn = CodexTurnState::default();
    apply_session_content(&content, &mut turn);
    // 偏移只推进到最后一个完整行的行尾；结尾的半行等写完后随下次增量一起解析
    let consumed = content
        .as_bytes()
        .iter()
        .rposition(|&byte| byte == b'\n')
        .map(|index| index + 1)
        .unwrap_or(0) as u64;
    let cache = SessionParseCache {
        size,
        modified,
        id,
        label,
        cwd,
        consumed,
        turn,
    };
    let snapshot = snapshot_from_cache(&cache, running_ttl);
    guard.insert(path.to_path_buf(), cache);
    Some(snapshot)
}

fn snapshot_from_cache(
    cache: &SessionParseCache,
    running_ttl: Duration,
) -> SessionStatusSnapshot {
    let mut status = turn_state_status(&cache.turn);
    if matches!(status, CodexSessionStatus::Running)
        && !session_file_is_recent(cache.modified, running_ttl)
    {
        status = CodexSessionStatus::Idle;
    }

    SessionStatusSnapshot {
        id: cache.id.clone(),
        label: cache.label.clone(),
        cwd: cache.cwd.clone(),
        status,
        modified: cache.modified,
    }
}

fn prune_inactive_session_caches(active_paths: &[PathBuf]) {
    let mut guard = match SESSION_PARSE_CACHE.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    guard.retain(|path, _| active_paths.contains(path));
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

fn session_file_is_recent(modified: SystemTime, running_ttl: Duration) -> bool {
    match SystemTime::now().duration_since(modified) {
        Ok(age) => age <= running_ttl,
        Err(_) => true,
    }
}

fn session_file_is_active(modified: SystemTime, active_ttl: Duration) -> bool {
    match SystemTime::now().duration_since(modified) {
        Ok(age) => age <= active_ttl,
        Err(_) => true,
    }
}

fn active_codex_session_files(
    sessions_root: &Path,
    active_ttl: Duration,
) -> Vec<(PathBuf, SystemTime, u64)> {
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
        .flat_map(jsonl_files_in_dir)
        .filter(|(_, modified, _)| session_file_is_active(*modified, active_ttl))
        .collect()
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
fn jsonl_files_in_dir(dir: PathBuf) -> Vec<(PathBuf, SystemTime, u64)> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };

    entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|ext| ext.to_str()) == Some("jsonl"))
        .filter_map(|path| {
            let metadata = fs::metadata(&path).ok()?;
            let modified = metadata.modified().ok()?;
            Some((path, modified, metadata.len()))
        })
        .collect()
}

fn parse_session_identity(path: &Path, content: &str) -> (String, String, String) {
    let fallback_id = uuid_from_filename(path).unwrap_or_else(|| {
        path.file_stem()
            .and_then(|stem| stem.to_str())
            .unwrap_or("codex-session")
            .to_string()
    });
    let Some(first_line) = content.lines().next() else {
        let label = fallback_label(path, &fallback_id);
        return (fallback_id, label, String::new());
    };
    let Ok(value) = serde_json::from_str::<Value>(first_line) else {
        let label = fallback_label(path, &fallback_id);
        return (fallback_id, label, String::new());
    };

    let cwd = string_at(&value, &["payload", "cwd"])
        .unwrap_or_default()
        .trim()
        .to_string();
    let id = string_at(&value, &["payload", "id"])
        .or_else(|| string_at(&value, &["payload", "session_id"]))
        .or_else(|| string_at(&value, &["payload", "thread_id"]))
        .map(str::to_string)
        .unwrap_or(fallback_id);
    let label = label_from_cwd(&cwd).unwrap_or_else(|| fallback_label(path, &id));
    (id, label, cwd)
}

fn uuid_from_filename(path: &Path) -> Option<String> {
    let stem = path.file_stem()?.to_str()?;
    for start in 0..stem.len().saturating_sub(35) {
        let candidate = stem.get(start..start + 36)?;
        if is_uuid_like(candidate) {
            return Some(candidate.to_string());
        }
    }
    None
}

fn is_uuid_like(value: &str) -> bool {
    value.len() == 36
        && value.chars().enumerate().all(|(index, ch)| match index {
            8 | 13 | 18 | 23 => ch == '-',
            _ => ch.is_ascii_hexdigit(),
        })
}

fn label_from_cwd(cwd: &str) -> Option<String> {
    cwd.trim()
        .trim_end_matches(['\\', '/'])
        .rsplit(['\\', '/'])
        .find(|part| !part.is_empty())
        .map(str::to_string)
}

fn fallback_label(path: &Path, id: &str) -> String {
    path.file_stem()
        .and_then(|stem| stem.to_str())
        .map(str::to_string)
        .unwrap_or_else(|| id.to_string())
}

fn payload_from_session_status(status: CodexSessionStatus, modified: SystemTime) -> StatusPayload {
    let mut payload = match status {
        CodexSessionStatus::Waiting(kind) => waiting_from_codex_session(kind),
        CodexSessionStatus::Interrupted => interrupted_from_codex_session(),
        CodexSessionStatus::Running => running_from_codex_session(),
        CodexSessionStatus::Idle => idle_with_summary("无活动"),
    };
    payload.updated_at = system_time_timestamp(modified);
    payload
}

fn system_time_timestamp(time: SystemTime) -> String {
    OffsetDateTime::from(time)
        .format(&Rfc3339)
        .unwrap_or_else(|_| now_timestamp())
}

fn aggregate_instance_statuses(instances: &[InstanceStatus]) -> StatusPayload {
    if instances.is_empty() {
        return idle_with_summary("无活动");
    }
    if instances.len() == 1 {
        let instance = &instances[0];
        return StatusPayload {
            status: instance.status.clone(),
            source: "codex".to_string(),
            event: String::new(),
            summary: instance.summary.clone(),
            detail: instance.detail.clone(),
            updated_at: instance.updated_at.clone(),
            ttl_ms: 0,
        };
    }

    let status = ["waiting", "error", "interrupted", "running", "done", "idle"]
        .into_iter()
        .find(|status| instances.iter().any(|instance| instance.status == *status))
        .unwrap_or("idle");

    StatusPayload {
        status: status.to_string(),
        source: "codex".to_string(),
        event: String::new(),
        summary: aggregate_summary(instances),
        detail: String::new(),
        updated_at: now_timestamp(),
        ttl_ms: 0,
    }
}

fn aggregate_summary(instances: &[InstanceStatus]) -> String {
    let mut parts = Vec::new();
    for (status, label) in [
        ("running", "运行"),
        ("waiting", "等待"),
        ("error", "错误"),
        ("interrupted", "中断"),
        ("done", "完成"),
    ] {
        let count = instances
            .iter()
            .filter(|instance| instance.status == status)
            .count();
        if count > 0 {
            parts.push(format!("{count}{label}"));
        }
    }

    if parts.is_empty() {
        "无活动".to_string()
    } else {
        parts.join(" ")
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BridgeStatusFile {
    #[serde(flatten)]
    payload: StatusPayload,
    #[serde(default)]
    instance: String,
    #[serde(default)]
    id: String,
    #[serde(default)]
    cwd: String,
}

fn read_bridge_status_files(root: &Path, active_ttl: Duration) -> Vec<BridgeStatusFile> {
    let dir = root.join("state").join("status");
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };

    entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|ext| ext.to_str()) == Some("json"))
        .filter_map(|path| {
            let content = fs::read_to_string(&path).ok()?;
            let status = serde_json::from_str::<BridgeStatusFile>(&content).ok()?;
            if is_known_status(&status.payload.status)
                && bridge_status_is_active(&status.payload, active_ttl)
            {
                Some(status)
            } else {
                let _ = fs::remove_file(path);
                None
            }
        })
        .collect()
}

fn bridge_status_is_active(payload: &StatusPayload, active_ttl: Duration) -> bool {
    let Ok(updated_at) = OffsetDateTime::parse(&payload.updated_at, &Rfc3339) else {
        return true;
    };
    let age = OffsetDateTime::now_utc() - updated_at;
    let age_ms = age.whole_milliseconds();
    (0..=active_ttl.as_millis() as i128).contains(&age_ms)
}

fn apply_bridge_statuses(instances: &mut [InstanceStatus], bridge_statuses: &[BridgeStatusFile]) {
    for instance in instances {
        let Some(status) = bridge_statuses
            .iter()
            .filter(|status| bridge_matches_instance(status, instance))
            .max_by_key(|status| bridge_status_timestamp(&status.payload))
        else {
            continue;
        };

        if is_priority_status(&status.payload.status) || is_fresh_done(&status.payload) {
            instance.status = status.payload.status.clone();
            instance.summary = status.payload.summary.clone();
            instance.detail = status.payload.detail.clone();
            instance.updated_at = status.payload.updated_at.clone();
        }
    }
}

fn bridge_status_timestamp(payload: &StatusPayload) -> i128 {
    OffsetDateTime::parse(&payload.updated_at, &Rfc3339)
        .map(|value| value.unix_timestamp_nanos())
        .unwrap_or(i128::MIN)
}

fn bridge_matches_instance(status: &BridgeStatusFile, instance: &InstanceStatus) -> bool {
    let instance_key = status.instance.trim();
    let id = status.id.trim();
    let cwd = status.cwd.trim();

    (!instance_key.is_empty() && instance_key == instance.id)
        || (!id.is_empty() && id == instance.id)
        || (!cwd.is_empty() && cwd == instance.cwd)
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
    /// 等待类型：区分"批准"和"提问"
    waiting_kind: WaitKind,
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
        CodexSessionStatus::Waiting(turn.waiting_kind)
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
            turn.waiting = false; // 清除等待状态
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
        if payload_type == "agent_message"
            && string_at(value, &["payload", "phase"]) == Some("final_answer")
        {
            turn.final_message = true;
            turn.activity = false; // 已发送最终答案，活动结束
            return;
        }

        // 权限请求只在未中断时生效
        if !turn.interrupted && is_permission_request_event(value, payload_type) {
            turn.waiting = true;
            turn.waiting_kind = WaitKind::Approval;
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
                // 区分等待类型：用户交互工具 → 提问，纯权限升级 → 批准
                turn.waiting_kind = if is_user_interaction_tool(value) {
                    WaitKind::Question
                } else {
                    WaitKind::Approval
                };
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

// 需要用户交互的工具名白名单：
// - request_user_input: Codex CLI 计划模式提问（真实 jsonl 中确认的名字）
// - AskUserQuestion:    Claude Code 的提问工具（保留兼容）
fn is_user_interaction_tool(value: &Value) -> bool {
    const INTERACTION_TOOLS: [&str; 2] = ["request_user_input", "AskUserQuestion"];

    for field in [&["payload", "name"], &["payload", "function_name"]] {
        if let Some(name) = string_at(value, field) {
            if INTERACTION_TOOLS.contains(&name) {
                return true;
            }
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
fn status_scan_roots() -> (PathBuf, PathBuf, AppSettings) {
    let env_state = std::env::var("INDICATOR_STATE_DIR").ok().map(PathBuf::from);
    let env_sessions = std::env::var("CODEX_SESSIONS_DIR").ok().map(PathBuf::from);

    let app_root = app_data_root();
    let settings = read_settings_from_dir(&app_root).settings;
    (
        env_state.unwrap_or_else(|| resolve_state_dir(&app_root, &settings)),
        env_sessions.unwrap_or_else(|| resolve_codex_sessions_dir(&settings)),
        settings,
    )
}

fn active_window_ttl(settings: &AppSettings) -> Duration {
    Duration::from_secs(u64::from(settings.instance_active_window_minutes.clamp(1, 60)) * 60)
}

fn running_ttl(settings: &AppSettings) -> Duration {
    Duration::from_secs(u64::from(settings.session_running_ttl_seconds.clamp(30, 1_800)))
}

fn read_dock_state() -> Option<DockState> {
    let content = fs::read_to_string(dock_state_path()).ok()?;
    let state = serde_json::from_str::<DockState>(&content).ok()?;
    if state.cross.is_finite() {
        Some(state)
    } else {
        None
    }
}

fn write_dock_state(state: &DockState) -> Result<(), String> {
    let path = dock_state_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let content = serde_json::to_string_pretty(state).map_err(|error| error.to_string())?;
    fs::write(path, content).map_err(|error| error.to_string())
}

fn remove_dock_state() -> Result<(), String> {
    match fs::remove_file(dock_state_path()) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

fn monitor_for_window(window: &WebviewWindow) -> Result<Monitor, String> {
    if let Some(monitor) = window.current_monitor().map_err(|error| error.to_string())? {
        return Ok(monitor);
    }
    if let Some(monitor) = window.primary_monitor().map_err(|error| error.to_string())? {
        return Ok(monitor);
    }
    Err("无法获取显示器信息".to_string())
}

fn monitor_for_state(window: &WebviewWindow, state: &DockState) -> Result<Monitor, String> {
    if let Some(name) = state.monitor.as_deref() {
        let monitors = window
            .available_monitors()
            .map_err(|error| error.to_string())?;
        if let Some(monitor) = monitors
            .into_iter()
            .find(|monitor| monitor.name().map(String::as_str) == Some(name))
        {
            return Ok(monitor);
        }
    }
    if let Some(monitor) = window.primary_monitor().map_err(|error| error.to_string())? {
        return Ok(monitor);
    }
    monitor_for_window(window)
}

fn monitor_work_rect(monitor: &Monitor) -> Rect {
    let scale = monitor.scale_factor();
    let work = monitor.work_area();
    Rect {
        x: f64::from(work.position.x) / scale,
        y: f64::from(work.position.y) / scale,
        w: f64::from(work.size.width) / scale,
        h: f64::from(work.size.height) / scale,
    }
}

fn window_rect(window: &WebviewWindow, monitor: &Monitor) -> Result<Rect, String> {
    let scale = monitor.scale_factor();
    let position = window.outer_position().map_err(|error| error.to_string())?;
    let size = window.outer_size().map_err(|error| error.to_string())?;
    Ok(Rect {
        x: f64::from(position.x) / scale,
        y: f64::from(position.y) / scale,
        w: f64::from(size.width) / scale,
        h: f64::from(size.height) / scale,
    })
}

fn rects_close(left: Rect, right: Rect) -> bool {
    const EPSILON: f64 = 0.5;
    (left.x - right.x).abs() <= EPSILON
        && (left.y - right.y).abs() <= EPSILON
        && (left.w - right.w).abs() <= EPSILON
        && (left.h - right.h).abs() <= EPSILON
}

fn apply_window_rect(window: &WebviewWindow, rect: Rect, monitor: &Monitor) -> Result<(), String> {
    if let Ok(current) = window_rect(window, monitor) {
        if rects_close(current, rect) {
            return Ok(());
        }
    }

    window
        .set_size(tauri::LogicalSize::new(rect.w, rect.h))
        .map_err(|error| error.to_string())?;
    window
        .set_position(tauri::LogicalPosition::new(rect.x, rect.y))
        .map_err(|error| error.to_string())
}

fn normalized_panel_height(panel_expanded_height: Option<f64>) -> f64 {
    panel_expanded_height
        .unwrap_or(default_panel_expanded_height() as f64)
        .clamp(220.0, 620.0)
}

fn normalized_dock_peek_height(panel_expanded_height: Option<f64>) -> f64 {
    panel_expanded_height.unwrap_or(PILL_H).clamp(PILL_H, 620.0)
}

fn apply_dock_mode(
    window: &WebviewWindow,
    state: &DockState,
    mode: DockMode,
    panel_expanded_height: Option<f64>,
) -> Result<(), String> {
    let monitor = monitor_for_state(window, state)?;
    let work = monitor_work_rect(&monitor);
    let height = match mode {
        DockMode::Hidden => PILL_H,
        DockMode::Peek => normalized_dock_peek_height(panel_expanded_height),
    };
    let rect = dock_geometry(state.edge, mode, state.cross, work, height);
    apply_window_rect(window, rect, &monitor)?;
    if let Ok(mut current) = CURRENT_DOCK_MODE.lock() {
        *current = Some(mode);
    }
    append_log(
        &project_root(),
        &format!(
            "dock mode={} edge={}",
            dock_mode_name(mode),
            dock_edge_name(state.edge)
        ),
    );
    Ok(())
}

fn undock_window_inner(app: &AppHandle) -> Result<(), String> {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        let _ = remove_dock_state();
        if let Ok(mut current) = CURRENT_DOCK_MODE.lock() {
            *current = None;
        }
        append_log(&project_root(), "dock mode=undock");
        return Ok(());
    };

    let state = read_dock_state();
    if let Some(state) = state.as_ref() {
        let monitor = monitor_for_state(&window, state)?;
        let work = monitor_work_rect(&monitor);
        let cross_max = work.h - PILL_H;
        let long_max = work.w - PILL_W;
        let rect = match state.edge {
            DockEdge::Left => Rect {
                x: work.x + dock::BEAD_THICKNESS,
                y: state.cross.max(work.y).min(work.y + cross_max),
                w: PILL_W,
                h: PILL_H,
            },
            DockEdge::Right => Rect {
                x: work.x + work.w - PILL_W - dock::BEAD_THICKNESS,
                y: state.cross.max(work.y).min(work.y + cross_max),
                w: PILL_W,
                h: PILL_H,
            },
            DockEdge::Top => Rect {
                x: state.cross.max(work.x).min(work.x + long_max),
                y: work.y + dock::BEAD_THICKNESS,
                w: PILL_W,
                h: PILL_H,
            },
        };
        apply_window_rect(&window, rect, &monitor)?;
    } else {
        window
            .set_size(tauri::LogicalSize::new(PILL_W, PILL_H))
            .map_err(|error| error.to_string())?;
    }

    remove_dock_state()?;
    if let Ok(mut current) = CURRENT_DOCK_MODE.lock() {
        *current = None;
    }
    append_log(&project_root(), "dock mode=undock");
    Ok(())
}

fn dock_edge_name(edge: DockEdge) -> &'static str {
    match edge {
        DockEdge::Left => "left",
        DockEdge::Right => "right",
        DockEdge::Top => "top",
    }
}

fn dock_mode_name(mode: DockMode) -> &'static str {
    match mode {
        DockMode::Hidden => "hidden",
        DockMode::Peek => "peek",
    }
}

fn restore_initial_main_geometry(app: &AppHandle) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        return;
    };

    if let Some(state) = read_dock_state() {
        let _ = apply_dock_mode(&window, &state, DockMode::Hidden, None);
    } else {
        let _ = window.set_size(tauri::LogicalSize::new(PILL_W, PILL_H));
        if let Ok(mut current) = CURRENT_DOCK_MODE.lock() {
            *current = None;
        }
    }
}

// async：让文件扫描与解析跑在 tauri 异步线程池，避免同步命令阻塞主线程导致 UI 卡顿
#[tauri::command]
async fn get_status() -> StatusPayload {
    let (state_root, sessions_root, settings) = status_scan_roots();
    read_effective_statuses_from_dirs_with_ttl(
        &state_root,
        &sessions_root,
        active_window_ttl(&settings),
        running_ttl(&settings),
    )
    .aggregate
}

#[tauri::command]
async fn get_statuses() -> MultiStatusPayload {
    let (state_root, sessions_root, settings) = status_scan_roots();
    read_effective_statuses_from_dirs_with_ttl(
        &state_root,
        &sessions_root,
        active_window_ttl(&settings),
        running_ttl(&settings),
    )
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
        let is_peek = CURRENT_DOCK_MODE
            .lock()
            .map(|current| *current == Some(DockMode::Peek))
            .unwrap_or(false);
        if is_peek {
            let state = read_dock_state().ok_or_else(|| "没有可恢复的贴边状态".to_string())?;
            let height = if open {
                panel_expanded_height
            } else {
                Some(PILL_H)
            };
            apply_dock_mode(&window, &state, DockMode::Peek, height)?;
        } else {
            let expanded_height = normalized_panel_height(panel_expanded_height);
            let height = if open { expanded_height } else { PILL_H };
            window
                .set_size(tauri::LogicalSize::new(PILL_W, height))
                .map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
fn dock_check(app: AppHandle, panel_expanded_height: Option<f64>) -> Result<Option<DockEdge>, String> {
    let _ = panel_expanded_height;
    let settings = read_settings_from_dir(&app_data_root()).settings;
    if !settings.edge_dock_enabled {
        return Ok(None);
    }

    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        return Ok(None);
    };
    let had_dock_state = read_dock_state().is_some();
    let monitor = monitor_for_window(&window)?;
    let work = monitor_work_rect(&monitor);
    let win = window_rect(&window, &monitor)?;
    let edge = detect_dock_edge(win, work);
    append_log(
        &project_root(),
        &format!(
            "dock_check window=({:.1},{:.1},{:.1},{:.1}) work=({:.1},{:.1},{:.1},{:.1}) edge={}",
            win.x,
            win.y,
            win.w,
            win.h,
            work.x,
            work.y,
            work.w,
            work.h,
            edge.map(dock_edge_name).unwrap_or("none")
        ),
    );

    if let Some(edge) = edge {
        let cross = match edge {
            DockEdge::Left | DockEdge::Right => win.y,
            DockEdge::Top => win.x,
        };
        let state = DockState {
            edge,
            cross,
            monitor: monitor.name().cloned(),
        };
        write_dock_state(&state)?;
        Ok(Some(edge))
    } else {
        if had_dock_state {
            remove_dock_state()?;
        }
        Ok(None)
    }
}

#[tauri::command]
fn set_dock_mode(
    app: AppHandle,
    mode: DockMode,
    panel_expanded_height: Option<f64>,
) -> Result<(), String> {
    let state = read_dock_state().ok_or_else(|| "没有可恢复的贴边状态".to_string())?;
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        apply_dock_mode(&window, &state, mode, panel_expanded_height)?;
    }
    Ok(())
}

#[tauri::command]
fn undock_window(app: AppHandle) -> Result<(), String> {
    undock_window_inner(&app)
}

#[tauri::command]
fn get_dock_state() -> Option<DockState> {
    read_dock_state()
}

#[tauri::command]
fn is_native_drag_release_supported() -> bool {
    cfg!(target_os = "windows")
}

#[tauri::command]
async fn wait_for_native_drag_release() -> Result<(), String> {
    let root = project_root();
    append_log(&root, "native drag release monitor started");
    let result =
        match tauri::async_runtime::spawn_blocking(wait_for_native_drag_release_inner).await {
            Ok(result) => result,
            Err(error) => Err(format!("原生拖动松手检测任务失败: {error}")),
        };
    match &result {
        Ok(()) => append_log(&root, "native drag left button released"),
        Err(error) => append_log(
            &root,
            &format!("native drag release monitor failed: {error}"),
        ),
    }
    result
}

#[tauri::command]
fn report_dock_error(message: String) {
    append_log(&project_root(), &format!("dock error: {message}"));
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

fn apply_runtime_settings(app: &AppHandle, settings: &AppSettings) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.set_always_on_top(settings.always_on_top);
    }
    if !settings.edge_dock_enabled && read_dock_state().is_some() {
        let _ = undock_window_inner(app);
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
        if let Some(state) = read_dock_state() {
            let _ = apply_dock_mode(&window, &state, DockMode::Peek, None);
        }
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
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(tauri_plugin_window_state::StateFlags::POSITION)
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let settings = read_settings_from_dir(&app_data_root()).settings;
            let root = project_root();
            if let Err(error) = ensure_project_dirs(&root) {
                append_log(&root, &format!("初始化目录失败: {}", error));
            }
            apply_runtime_settings(app.handle(), &settings);
            restore_initial_main_geometry(app.handle());
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
            get_statuses,
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
            dock_check,
            set_dock_mode,
            undock_window,
            get_dock_state,
            is_native_drag_release_supported,
            wait_for_native_drag_release,
            report_dock_error,
            quit_app
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
