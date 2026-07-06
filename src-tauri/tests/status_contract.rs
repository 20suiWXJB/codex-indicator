use indicator_lib::{
    read_effective_status_from_dirs, read_effective_statuses_from_dirs,
    read_effective_statuses_from_dirs_with_ttl,
    read_recent_events_from_dir, read_status_from_dir,
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
fn recent_events_preserve_instance_metadata() {
    let root = temp_state_dir("events-instance");
    fs::write(
        root.join("state/events.jsonl"),
        r#"{"status":"waiting","source":"codex","event":"PermissionRequest","instance":"abc","cwd":"D:\\Code\\Tauri\\indicator","summary":"one","detail":"","createdAt":"2026-07-02T16:00:00+08:00"}"#,
    )
    .expect("write events");

    let events = read_recent_events_from_dir(&root, 1);

    assert_eq!(events.len(), 1);
    assert_eq!(events[0].instance, "abc");
    assert_eq!(events[0].cwd, "D:\\Code\\Tauri\\indicator");
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
fn configurable_running_ttl_controls_stale_unfinished_session_status() {
    let root = temp_state_dir("running-ttl");
    let sessions = temp_sessions_dir("running-ttl");
    let session_path = write_session(
        &sessions,
        "rollout-running-ttl.jsonl",
        [
            r#"{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-ttl"}}"#,
            r#"{"type":"response_item","payload":{"type":"reasoning","internal_chat_message_metadata_passthrough":{"turn_id":"turn-ttl"}}}"#,
        ]
        .join("\n")
        .as_str(),
    );
    set_session_modified(&session_path, SystemTime::now() - Duration::from_secs(5 * 60));

    let long = read_effective_statuses_from_dirs_with_ttl(
        &root,
        &sessions,
        Duration::from_secs(10 * 60),
        Duration::from_secs(10 * 60),
    );
    let short = read_effective_statuses_from_dirs_with_ttl(
        &root,
        &sessions,
        Duration::from_secs(10 * 60),
        Duration::from_secs(2 * 60),
    );

    assert_eq!(long.aggregate.status, "running");
    assert_eq!(short.aggregate.status, "idle");
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

// 覆盖解析缓存失效路径：文件被截断重写（变小）时必须全量重建，不能沿用旧状态
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

// ============================================================================
// 回归测试：Codex request_user_input 提问工具识别
// ============================================================================

/// 测试 request_user_input 工具调用能正确触发 waiting 状态
///
/// 使用真实 Codex jsonl 中确认的事件形态：
/// response_item → function_call(name=request_user_input, call_id=X)
#[test]
fn request_user_input_function_call_reports_waiting() {
    let root = temp_state_dir("request-user-input");
    let sessions = temp_sessions_dir("request-user-input");
    // 模拟 Codex CLI 计划模式提问的真实 jsonl 事件
    let user_input_call = serde_json::json!({
        "type": "response_item",
        "payload": {
            "type": "function_call",
            "call_id": "call-question",
            "name": "request_user_input",
            "arguments": "{\"questions\":[{\"header\":\"Token范围\",\"question\":\"...\",\"options\":[\"全部\",\"当前文件\"]}]}",
            "internal_chat_message_metadata_passthrough": {
                "turn_id": "turn-question"
            }
        }
    })
    .to_string();
    write_session(
        &sessions,
        "rollout-question.jsonl",
        [
            r#"{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-question"}}"#,
            user_input_call.as_str(),
        ]
        .join("\n")
        .as_str(),
    );

    let payload = read_effective_status_from_dirs(&root, &sessions);

    // 提问应触发 waiting 状态
    assert_eq!(payload.status, "waiting");
    // 提问类型的等待不应显示"批准"文案
    assert!(
        payload.summary.contains("选择选项")
            || payload.summary.contains("提问")
            || payload.summary.contains("等你"),
        "提问等待的 summary 应区别于批准文案，实际: {}",
        payload.summary
    );
}

/// 测试用户回答后 waiting 状态被正确清除，回到 running
///
/// 提问的 function_call 带 call_id，回答后的 function_call_output
/// 带相同 call_id，应通过 clear_waiting_call_if_resolved 自动清除 waiting。
#[test]
fn answered_user_input_clears_waiting_and_returns_to_running() {
    let root = temp_state_dir("answered-question");
    let sessions = temp_sessions_dir("answered-question");
    let call_id = "call-question-resolved";
    let user_input_call = serde_json::json!({
        "type": "response_item",
        "payload": {
            "type": "function_call",
            "call_id": call_id,
            "name": "request_user_input",
            "arguments": "{\"questions\":[{\"header\":\"Token范围\",\"question\":\"...\",\"options\":[\"全部\",\"当前文件\"]}]}",
            "internal_chat_message_metadata_passthrough": {
                "turn_id": "turn-resolved"
            }
        }
    })
    .to_string();
    // 模拟用户回答后 Codex 写入的 function_call_output
    let user_output = serde_json::json!({
        "type": "response_item",
        "payload": {
            "type": "function_call_output",
            "call_id": call_id,
            "internal_chat_message_metadata_passthrough": {
                "turn_id": "turn-resolved"
            }
        }
    })
    .to_string();
    write_session(
        &sessions,
        "rollout-resolved.jsonl",
        [
            r#"{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-resolved"}}"#,
            user_input_call.as_str(),
            user_output.as_str(),
        ]
        .join("\n")
        .as_str(),
    );

    let payload = read_effective_status_from_dirs(&root, &sessions);

    // 回答后 waiting 应解除，回到 running
    assert_eq!(payload.status, "running");
}

#[test]
fn multiple_active_sessions_return_instances_and_waiting_aggregate() {
    let root = temp_state_dir("multi-active");
    let sessions = temp_sessions_dir("multi-active");
    let running_meta = serde_json::json!({
        "type": "session_meta",
        "payload": {
            "id": "11111111-1111-1111-1111-111111111111",
            "cwd": "D:\\Code\\Tauri\\indicator"
        }
    })
    .to_string();
    let waiting_meta = serde_json::json!({
        "type": "session_meta",
        "payload": {
            "id": "22222222-2222-2222-2222-222222222222",
            "cwd": "D:\\Code\\Java\\agent-mall-plus"
        }
    })
    .to_string();
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
        "rollout-2026-07-04T10-00-00-11111111-1111-1111-1111-111111111111.jsonl",
        [
            running_meta.as_str(),
            r#"{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-running"}}"#,
            r#"{"type":"response_item","payload":{"type":"reasoning","internal_chat_message_metadata_passthrough":{"turn_id":"turn-running"}}}"#,
        ]
        .join("\n")
        .as_str(),
    );
    write_session(
        &sessions,
        "rollout-2026-07-04T10-01-00-22222222-2222-2222-2222-222222222222.jsonl",
        [
            waiting_meta.as_str(),
            r#"{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-waiting"}}"#,
            approval_call.as_str(),
        ]
        .join("\n")
        .as_str(),
    );

    let payload = read_effective_statuses_from_dirs(&root, &sessions);

    assert_eq!(payload.instances.len(), 2);
    assert_eq!(payload.aggregate.status, "waiting");
    assert_eq!(payload.aggregate.summary, "1运行 1等待");
    assert!(payload.instances.iter().any(|instance| {
        instance.id == "11111111-1111-1111-1111-111111111111"
            && instance.label == "indicator"
            && instance.status == "running"
    }));
    assert!(payload.instances.iter().any(|instance| {
        instance.id == "22222222-2222-2222-2222-222222222222"
            && instance.label == "agent-mall-plus"
            && instance.status == "waiting"
    }));
}

#[test]
fn bridge_status_file_overrides_matching_session_instance_only() {
    let root = temp_state_dir("multi-bridge");
    fs::create_dir_all(root.join("state/status")).expect("create multi status dir");
    let sessions = temp_sessions_dir("multi-bridge");
    let first_meta = serde_json::json!({
        "type": "session_meta",
        "payload": {
            "id": "33333333-3333-3333-3333-333333333333",
            "cwd": "D:\\Code\\Tauri\\indicator"
        }
    })
    .to_string();
    let second_meta = serde_json::json!({
        "type": "session_meta",
        "payload": {
            "id": "44444444-4444-4444-4444-444444444444",
            "cwd": "D:\\Code\\Java\\openapi-plus"
        }
    })
    .to_string();

    write_session(
        &sessions,
        "rollout-2026-07-04T10-02-00-33333333-3333-3333-3333-333333333333.jsonl",
        [
            first_meta.as_str(),
            r#"{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-first"}}"#,
            r#"{"type":"response_item","payload":{"type":"reasoning","internal_chat_message_metadata_passthrough":{"turn_id":"turn-first"}}}"#,
        ]
        .join("\n")
        .as_str(),
    );
    write_session(
        &sessions,
        "rollout-2026-07-04T10-03-00-44444444-4444-4444-4444-444444444444.jsonl",
        [
            second_meta.as_str(),
            r#"{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-second"}}"#,
            r#"{"type":"response_item","payload":{"type":"reasoning","internal_chat_message_metadata_passthrough":{"turn_id":"turn-second"}}}"#,
        ]
        .join("\n")
        .as_str(),
    );
    fs::write(
        root.join("state/status/44444444-4444-4444-4444-444444444444.json"),
        format!(
            r#"{{"instance":"44444444-4444-4444-4444-444444444444","status":"waiting","source":"codex","event":"PermissionRequest","summary":"Bridge waiting","detail":"approval","updatedAt":"{}","ttlMs":0}}"#,
            current_rfc3339()
        ),
    )
    .expect("write bridge status");

    let payload = read_effective_statuses_from_dirs(&root, &sessions);

    assert!(payload.instances.iter().any(|instance| {
        instance.id == "33333333-3333-3333-3333-333333333333" && instance.status == "running"
    }));
    assert!(payload.instances.iter().any(|instance| {
        instance.id == "44444444-4444-4444-4444-444444444444"
            && instance.status == "waiting"
            && instance.summary == "Bridge waiting"
    }));
    assert_eq!(payload.aggregate.status, "waiting");
    assert_eq!(payload.aggregate.summary, "1运行 1等待");
}

#[test]
fn legacy_status_json_does_not_override_multi_instance_aggregate() {
    let root = temp_state_dir("legacy-multi");
    fs::write(
        root.join("state/status.json"),
        r#"{"status":"waiting","source":"codex","event":"PermissionRequest","summary":"legacy waiting","detail":"","updatedAt":"2026-07-02T16:50:00+08:00","ttlMs":0}"#,
    )
    .expect("write legacy status");
    let sessions = temp_sessions_dir("legacy-multi");
    for (id, project, turn) in [
        (
            "55555555-5555-5555-5555-555555555555",
            "D:\\Code\\Tauri\\indicator",
            "turn-first",
        ),
        (
            "66666666-6666-6666-6666-666666666666",
            "D:\\Code\\Java\\openapi-plus",
            "turn-second",
        ),
    ] {
        let meta = serde_json::json!({
            "type": "session_meta",
            "payload": {
                "id": id,
                "cwd": project
            }
        })
        .to_string();
        write_session(
            &sessions,
            &format!("rollout-2026-07-04T10-04-00-{id}.jsonl"),
            [
                meta.as_str(),
                &format!(r#"{{"type":"event_msg","payload":{{"type":"task_started","turn_id":"{turn}"}}}}"#),
                &format!(r#"{{"type":"response_item","payload":{{"type":"reasoning","internal_chat_message_metadata_passthrough":{{"turn_id":"{turn}"}}}}}}"#),
            ]
            .join("\n")
            .as_str(),
        );
    }

    let payload = read_effective_statuses_from_dirs(&root, &sessions);

    assert_eq!(payload.instances.len(), 2);
    assert_eq!(payload.aggregate.status, "running");
    assert_eq!(payload.aggregate.summary, "2运行");
}

#[test]
fn newest_matching_bridge_status_wins_for_instance() {
    let root = temp_state_dir("bridge-newest");
    fs::create_dir_all(root.join("state/status")).expect("create multi status dir");
    let sessions = temp_sessions_dir("bridge-newest");
    let id = "77777777-7777-7777-7777-777777777777";
    let cwd = "D:\\Code\\Tauri\\indicator";
    let meta = serde_json::json!({
        "type": "session_meta",
        "payload": {
            "id": id,
            "cwd": cwd
        }
    })
    .to_string();
    write_session(
        &sessions,
        &format!("rollout-2026-07-04T10-05-00-{id}.jsonl"),
        [
            meta.as_str(),
            r#"{"type":"event_msg","payload":{"type":"task_started","turn_id":"turn-newest"}}"#,
            r#"{"type":"response_item","payload":{"type":"reasoning","internal_chat_message_metadata_passthrough":{"turn_id":"turn-newest"}}}"#,
        ]
        .join("\n")
        .as_str(),
    );
    fs::write(
        root.join("state/status/cwd-hash.json"),
        format!(
            r#"{{"cwd":"{}","status":"waiting","source":"codex","event":"PermissionRequest","summary":"old waiting","detail":"","updatedAt":"2026-07-04T10:00:00Z","ttlMs":0}}"#,
            cwd.replace('\\', "\\\\")
        ),
    )
    .expect("write old bridge status");
    fs::write(
        root.join("state/status/77777777-7777-7777-7777-777777777777.json"),
        format!(
            r#"{{"instance":"{id}","status":"error","source":"codex","event":"Error","summary":"new error","detail":"","updatedAt":"{}","ttlMs":0}}"#,
            current_rfc3339()
        ),
    )
    .expect("write new bridge status");

    let payload = read_effective_statuses_from_dirs(&root, &sessions);

    assert_eq!(payload.instances.len(), 1);
    assert_eq!(payload.instances[0].status, "error");
    assert_eq!(payload.instances[0].summary, "new error");
    assert_eq!(payload.aggregate.status, "error");
}
