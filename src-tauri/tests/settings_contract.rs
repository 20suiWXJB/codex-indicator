use indicator_lib::{
    default_settings, read_settings_from_dir, save_settings_to_dir, AppSettings,
};
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

fn temp_config_dir(name: &str) -> PathBuf {
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock")
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("indicator-settings-{name}-{suffix}"));
    fs::create_dir_all(dir.join("config")).expect("create temp config dir");
    dir
}

#[test]
fn missing_settings_json_returns_defaults() {
    let root = temp_config_dir("missing");

    let result = read_settings_from_dir(&root);

    assert_eq!(result.settings, default_settings());
    assert!(result.load_error.is_none());
}

#[test]
fn partial_settings_json_merges_with_defaults() {
    let root = temp_config_dir("partial");
    fs::write(
        root.join("config/settings.json"),
        r#"{"theme":"dark","notifyOnError":false,"pollIntervalMs":1000}"#,
    )
    .expect("write partial settings");

    let result = read_settings_from_dir(&root);

    assert_eq!(result.settings.language, "zh-CN");
    assert_eq!(result.settings.theme, "dark");
    assert_eq!(result.settings.notify_on_error, false);
    assert_eq!(result.settings.poll_interval_ms, 1000);
    assert_eq!(result.settings.panel_expanded_height, 300);
}

#[test]
fn invalid_settings_json_returns_defaults_with_recoverable_error() {
    let root = temp_config_dir("invalid");
    fs::write(root.join("config/settings.json"), "{not json").expect("write invalid settings");

    let result = read_settings_from_dir(&root);

    assert_eq!(result.settings, default_settings());
    assert!(result
        .load_error
        .as_deref()
        .unwrap_or_default()
        .contains("设置文件不可读"));
}

#[test]
fn saved_settings_can_be_read_back() {
    let root = temp_config_dir("save-read");
    let settings = AppSettings {
        theme: "dark".to_string(),
        show_main_window_on_launch: false,
        always_on_top: false,
        panel_expanded_height: 480,
        poll_interval_ms: 750,
        ..default_settings()
    };

    let saved = save_settings_to_dir(&root, &settings).expect("save settings");
    let result = read_settings_from_dir(&root);

    assert_eq!(saved, settings);
    assert_eq!(result.settings, settings);
    assert!(result.load_error.is_none());
}
