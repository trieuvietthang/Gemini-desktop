// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

use tauri::{Manager, Emitter, tray::{TrayIconBuilder, MouseButton, MouseButtonState, TrayIconEvent}};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use std::str::FromStr;
use std::fs;
use std::path::PathBuf;
use serde::{Deserialize, Serialize};

const GEMINI_MODEL_URL: &str = "https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent";

#[derive(Serialize, Deserialize, Default)]
struct Secrets {
    gemini_api_key: Option<String>,
}

fn secrets_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("secrets.json"))
}

// Env var takes precedence (useful for managed/deployed machines); otherwise fall back
// to the per-user secrets file written via `set_gemini_api_key`. The key never lives in
// source control or the shipped JS bundle.
fn load_api_key(app: &tauri::AppHandle) -> Option<String> {
    if let Ok(key) = std::env::var("GEMINI_API_KEY") {
        if !key.trim().is_empty() {
            return Some(key);
        }
    }
    let path = secrets_path(app).ok()?;
    let data = fs::read_to_string(path).ok()?;
    let secrets: Secrets = serde_json::from_str(&data).ok()?;
    secrets.gemini_api_key.filter(|k| !k.trim().is_empty())
}

#[tauri::command]
fn has_gemini_api_key(app: tauri::AppHandle) -> bool {
    load_api_key(&app).is_some()
}

#[tauri::command]
fn set_gemini_api_key(app: tauri::AppHandle, key: String) -> Result<(), String> {
    let path = secrets_path(&app)?;
    let secrets = Secrets { gemini_api_key: Some(key) };
    let data = serde_json::to_string_pretty(&secrets).map_err(|e| e.to_string())?;
    fs::write(path, data).map_err(|e| e.to_string())
}

#[tauri::command]
async fn generate_content(app: tauri::AppHandle, prompt: String) -> Result<String, String> {
    let api_key = load_api_key(&app)
        .ok_or_else(|| "Chưa cấu hình Gemini API key".to_string())?;

    let client = reqwest::Client::new();
    let res = client
        .post(GEMINI_MODEL_URL)
        .header("X-goog-api-key", api_key)
        .json(&serde_json::json!({
            "contents": [{ "parts": [{ "text": prompt }] }]
        }))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = res.status();
    let body: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;

    if !status.is_success() {
        let msg = body["error"]["message"].as_str().unwrap_or("Unknown error");
        return Err(msg.to_string());
    }

    body["candidates"][0]["content"]["parts"][0]["text"]
        .as_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "Sorry, I could not generate a response.".to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // Setup Tray Icon
            let tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;

            // Setup Global Shortcut (Ctrl+Shift+Space)
            let app_handle = app.handle().clone();
            let shortcut = Shortcut::from_str("Ctrl+Shift+Space").unwrap();
            
            // Register shortcut, ignore error if already registered to prevent panic
            let _ = app.global_shortcut().on_shortcut(shortcut, move |app_handle, _shortcut, event| {
                if event.state == ShortcutState::Pressed {
                    if let Some(window) = app_handle.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                        let _ = window.emit("toggle-spotlight", ());
                    }
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            has_gemini_api_key,
            set_gemini_api_key,
            generate_content
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
