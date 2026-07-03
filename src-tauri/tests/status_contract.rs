use indicator_lib::{
    read_effective_status_from_dirs, read_recent_events_from_dir, read_status_from_dir,
};
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use time::{format_description::well_known::Rfc3339, OffsetDateTime};

fn temp_state_dir(name: &str) -> PathBuf {
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock")
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("indicator-{name}-{suffix}"));
    fs::create_dir_all(dir.join("state")).expect("create temp state dir");
    dir
}

fn temp_sessions_dir(name: &str) -> PathBuf {
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock")
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("indicator-sessions-{name}-{suffix}"));
    fs::create_dir_all(dir.join("2026").join("07").join("02")).expect("create sessions dir");
    dir
}

fn write_session(root: &PathBuf, name: &str, content: &str) -> PathBuf {
    let path = root.join("2026").join("07").join("02").join(name);
    fs::write(&path, content).expect("write session");
    path
}

fn set_session_modified(path: &PathBuf, modified: SystemTime) {
    let file = fs::File::options()
        .write(true)
        .open(path)
        .expect("open session for mtime");
    file.set_times(fs::FileTimes::new().set_modified(modified))
        .expect("set session mtime");
}

fn current_rfc3339() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .expect("format timestamp")
}

#[test]
fn reads_status_json_from_state_dir() {
    let root = temp_state_dir("status");
    fs::write(
        root.join("state/status.json"),
        r#"{"status":"waiting","source":"codex","event":"PermissionRequest","summary":"Codex waiting","detail":"powershell.exe","updatedAt":"2026-07-02T16:50:00+08:00","ttlMs":0}"#,
    )
    .expect("write status");

    let payload = read_status_from_dir(&root);

    assert_eq!(payload.status, "waiting");
    assert_eq!(payload.source, "codex");
    assert_eq!(payload.event, "PermissionRequest");
    assert_eq!(payload.summary, "Codex waiting");
    assert_eq!(payload.detail, "powershell.exe");
}

#[test]
fn damaged_status_json_returns_idle_summary() {
    let root = temp_state_dir("damaged");
    fs::write(root.join("state/status.json"), "{not json").expect("write damaged status");

    let payload = read_status_from_dir(&root);

    assert_eq!(payload.status, "idle");
    assert_eq!(payload.source, "indicator");
    assert!(payload.summary.contains("状态文件不可读"));
}

#[test]
fn reads_recent_events_in_newest_first_order_and_skips_bad_lines() {
    let root = temp_state_dir("events");
    fs::write(
        root.join("state/events.jsonl"),
        [
            r#"{"status":"waiting","source":"codex","event":"PermissionRequest","summary":"one","detail":"","createdAt":"2026-07-02T16:00:00+08:00"}"#,
            "{bad json",
            r#"{"status":"done","source":"codex","event":"Stop","summary":"two","detail":"","createdAt":"2026-07-02T16:01:00+08:00"}"#,
            r#"{"status":"error","source":"codex","event":"Error","summary":"three","detail":"","createdAt":"2026-07-02T16:02:00+08:00"}"#,
        ]
        .join("\n"),
    )
    .expect("write events");

    let events = read_recent_events_from_dir(&root, 2);

    assert_eq!(events.len(), 2);
    assert_eq!(events[0].summary, "three");
    assert_eq!(events[1].summary, "two");
}

#[test]
fn waiting_status_file_has_priority_over_running_session() {
    let root = temp_state_dir("waiting-priority");
    fs::write(
        root.join("state/status.json"),
        r#"{"status":"waiting","source":"codex","event":"PermissionRequest","summary":"Codex waiting","detail":"","updatedAt":"2026-07-02T16:50:00+08:00","ttlMs":0}"#,
    )
    .expect("write status");
    let sessions = temp_sessions_dir("waiting-priority");
    write_session(
        &sessions,
        "rollout-active.jsonl",
        r#"{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-active"}}"#,
    );

    let payload = read_effective_status_from_dirs(&root, &sessions);

    assert_eq!(payload.status, "waiting");
}

#[test]
fn fresh_done_status_file_has_priority_over_running_session() {
    let root = temp_state_dir("fresh-done");
    fs::write(
        root.join("state/status.json"),
        format!(
            r#"{{"status":"done","source":"codex","event":"Stop","summary":"Codex done","detail":"","updatedAt":"{}","ttlMs":0}}"#,
            current_rfc3339()
        ),
    )
    .expect("write status");
    let sessions = temp_sessions_dir("fresh-done");
    write_session(
        &sessions,
        "rollout-active.jsonl",
        r#"{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-active"}}"#,
    );

    let payload = read_effective_status_from_dirs(&root, &sessions);

    assert_eq!(payload.status, "done");
}

#[test]
fn expired_done_status_uses_latest_unfinished_codex_turn() {
    let root = temp_state_dir("running");
    fs::write(
        root.join("state/status.json"),
        r#"{"status":"done","source":"codex","event":"Stop","summary":"Codex done","detail":"","updatedAt":"1970-01-01T00:00:00Z","ttlMs":0}"#,
    )
    .expect("write status");
    let sessions = temp_sessions_dir("running");
    write_session(
        &sessions,
        "rollout-active.jsonl",
        [
            r#"{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-active"}}"#,
            r#"{"type":"response_item","payload":{"type":"reasoning","internal_chat_message_metadata_passthrough":{"turn_id":"turn-active"}}}"#,
            r#"{"type":"response_item","payload":{"type":"function_call","internal_chat_message_metadata_passthrough":{"turn_id":"turn-active"}}}"#,
        ]
        .join("\n")
        .as_str(),
    );

    let payload = read_effective_status_from_dirs(&root, &sessions);

    assert_eq!(payload.status, "running");
    assert_eq!(payload.source, "codex");
    assert_eq!(payload.summary, "Codex 运行中");
}

#[test]
fn fresh_unfinished_codex_session_reports_running() {
    let root = temp_state_dir("fresh-running");
    let sessions = temp_sessions_dir("fresh-running");
    write_session(
        &sessions,
        "rollout-active.jsonl",
        [
            r#"{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-active"}}"#,
            r#"{"type":"response_item","payload":{"type":"reasoning","internal_chat_message_metadata_passthrough":{"turn_id":"turn-active"}}}"#,
        ]
        .join("\n")
        .as_str(),
    );

    let payload = read_effective_status_from_dirs(&root, &sessions);

    assert_eq!(payload.status, "running");
}

#[test]
fn stale_unfinished_codex_session_falls_back_to_idle() {
    let root = temp_state_dir("stale-running");
    let sessions = temp_sessions_dir("stale-running");
    let session_path = write_session(
        &sessions,
        "rollout-stale.jsonl",
        [
            r#"{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-stale"}}"#,
            r#"{"type":"response_item","payload":{"type":"reasoning","internal_chat_message_metadata_passthrough":{"turn_id":"turn-stale"}}}"#,
        ]
        .join("\n")
        .as_str(),
    );
    set_session_modified(
        &session_path,
        SystemTime::now() - Duration::from_secs(2 * 60 + 1),
    );

    let payload = read_effective_status_from_dirs(&root, &sessions);

    assert_eq!(payload.status, "idle");
}

#[test]
fn approval_request_in_codex_session_reports_waiting() {
    let root = temp_state_dir("approval-waiting");
    let sessions = temp_sessions_dir("approval-waiting");
    let approval_call = serde_json::json!({
        "type": "response_item",
        "payload": {
            "type": "function_call",
            "call_id": "call-approval",
            "name": "functions.shell_command",
            "arguments": "{\"command\":\"cargo test\",\"sandbox_permissions\":\"require_escalated\"}",
            "internal_chat_message_metadata_passthrough": {
                "turn_id": "turn-waiting"
            }
        }
    })
    .to_string();
    write_session(
        &sessions,
        "rollout-waiting.jsonl",
        [
            r#"{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-waiting"}}"#,
            approval_call.as_str(),
        ]
        .join("\n")
        .as_str(),
    );

    let payload = read_effective_status_from_dirs(&root, &sessions);

    assert_eq!(payload.status, "waiting");
}

#[test]
fn aborted_codex_turn_reports_interrupted() {
    let root = temp_state_dir("aborted");
    let sessions = temp_sessions_dir("aborted");
    write_session(
        &sessions,
        "rollout-aborted.jsonl",
        [
            r#"{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-aborted"}}"#,
            r#"{"type":"event_msg","payload":{"type":"turn_aborted","turn_id":"turn-aborted"}}"#,
        ]
        .join("\n")
        .as_str(),
    );

    let payload = read_effective_status_from_dirs(&root, &sessions);

    assert_eq!(payload.status, "interrupted");
}

#[test]
fn completed_codex_turn_does_not_report_running() {
    let root = temp_state_dir("completed");
    let sessions = temp_sessions_dir("completed");
    write_session(
        &sessions,
        "rollout-complete.jsonl",
        [
            r#"{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-complete"}}"#,
            r#"{"type":"response_item","payload":{"type":"reasoning","internal_chat_message_metadata_passthrough":{"turn_id":"turn-complete"}}}"#,
            r#"{"type":"response_item","payload":{"type":"message","role":"assistant","phase":"final_answer","internal_chat_message_metadata_passthrough":{"turn_id":"turn-complete"}}}"#,
            r#"{"type":"event_msg","payload":{"type":"task_complete","turn_id":"turn-complete"}}"#,
        ]
        .join("\n")
        .as_str(),
    );

    let payload = read_effective_status_from_dirs(&root, &sessions);

    assert_eq!(payload.status, "idle");
}

#[test]
fn malformed_session_file_falls_back_to_state_file_result() {
    let root = temp_state_dir("malformed-session");
    let sessions = temp_sessions_dir("malformed-session");
    write_session(&sessions, "rollout-bad.jsonl", "{not json");

    let payload = read_effective_status_from_dirs(&root, &sessions);

    assert_eq!(payload.status, "idle");
}

// 覆盖解析缓存的增量路径：第一次轮询解析后文件被追加，第二次轮询必须反映新增事件
#[test]
fn appended_session_events_update_status_between_polls() {
    let root = temp_state_dir("incremental");
    let sessions = temp_sessions_dir("incremental");
    let path = write_session(
        &sessions,
        "rollout-incremental.jsonl",
        "{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_started\",\"turn_id\":\"turn-inc\"}}\n",
    );

    let first = read_effective_status_from_dirs(&root, &sessions);
    assert_eq!(first.status, "running");

    let mut file = fs::File::options()
        .append(true)
        .open(&path)
        .expect("open session for append");
    writeln!(
        file,
        r#"{{"type":"event_msg","payload":{{"type":"task_complete","turn_id":"turn-inc"}}}}"#
    )
    .expect("append complete event");
    drop(file);

    let second = read_effective_status_from_dirs(&root, &sessions);
    assert_eq!(second.status, "idle");
}

// 覆盖缓存失效路径：文件被截断重写（变小）时必须全量重建，不能沿用旧状态
#[test]
fn rewritten_session_file_is_reparsed_from_scratch() {
    let root = temp_state_dir("rewritten");
    let sessions = temp_sessions_dir("rewritten");
    let path = write_session(
        &sessions,
        "rollout-rewrite.jsonl",
        [
            r#"{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-rw"}}"#,
            r#"{"type":"response_item","payload":{"type":"reasoning","internal_chat_message_metadata_passthrough":{"turn_id":"turn-rw"}}}"#,
        ]
        .join("\n")
        .as_str(),
    );

    let first = read_effective_status_from_dirs(&root, &sessions);
    assert_eq!(first.status, "running");

    fs::write(
        &path,
        r#"{"type":"event_msg","payload":{"type":"turn_aborted","turn_id":"turn-rw2"}}"#,
    )
    .expect("rewrite session");

    let second = read_effective_status_from_dirs(&root, &sessions);
    assert_eq!(second.status, "interrupted");
}
