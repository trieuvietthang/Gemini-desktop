// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

use tauri::{Manager, Emitter, WebviewWindowBuilder, WebviewUrl, menu::{Menu, MenuItem}, tray::{TrayIconBuilder, MouseButton, MouseButtonState, TrayIconEvent}};
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

#[derive(Serialize, Deserialize, Clone)]
struct Attachment {
    mime_type: String,
    /// Raw base64 (no `data:...;base64,` prefix).
    data: String,
}

#[derive(Serialize, Deserialize, Clone)]
struct ChatMessage {
    role: String, // "user" | "model"
    text: String,
    #[serde(default)]
    attachments: Vec<Attachment>,
}

// `history` is the whole conversation so far (including the newest user
// message last), letting Quick Chat hold a real multi-turn conversation
// instead of treating every question as a one-off.
#[tauri::command]
async fn generate_content(app: tauri::AppHandle, history: Vec<ChatMessage>) -> Result<String, String> {
    let api_key = load_api_key(&app)
        .ok_or_else(|| "Chưa cấu hình Gemini API key".to_string())?;

    let contents: Vec<serde_json::Value> = history
        .iter()
        .map(|m| {
            let mut parts = vec![serde_json::json!({ "text": m.text })];
            for att in &m.attachments {
                parts.push(serde_json::json!({
                    "inline_data": { "mime_type": att.mime_type, "data": att.data }
                }));
            }
            serde_json::json!({ "role": m.role, "parts": parts })
        })
        .collect();

    let client = reqwest::Client::new();
    let res = client
        .post(GEMINI_MODEL_URL)
        .header("X-goog-api-key", api_key)
        .json(&serde_json::json!({ "contents": contents }))
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

#[tauri::command]
fn read_clipboard_text() -> Result<String, String> {
    let mut clipboard = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    clipboard.get_text().map_err(|e| e.to_string())
}

fn guess_mime_type(path: &str) -> &'static str {
    let lower = path.to_lowercase();
    if lower.ends_with(".png") {
        "image/png"
    } else if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
        "image/jpeg"
    } else if lower.ends_with(".webp") {
        "image/webp"
    } else if lower.ends_with(".gif") {
        "image/gif"
    } else if lower.ends_with(".pdf") {
        "application/pdf"
    } else {
        "application/octet-stream"
    }
}

#[tauri::command]
fn read_file_as_attachment(path: String) -> Result<Attachment, String> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    Ok(Attachment {
        mime_type: guess_mime_type(&path).to_string(),
        data: STANDARD.encode(bytes),
    })
}

// The spotlight is a separate always-on-top window (see tauri.conf.json) rather
// than an overlay inside the main window, because the per-tab Webviews are
// native views stacked above the main window's content and would otherwise
// cover it.
fn toggle_spotlight(app_handle: &tauri::AppHandle) {
    if let Some(spotlight) = app_handle.get_webview_window("spotlight") {
        if spotlight.is_visible().unwrap_or(false) {
            let _ = spotlight.hide();
        } else {
            let _ = spotlight.show();
            let _ = spotlight.set_focus();
            let _ = spotlight.emit("spotlight-shown", ());
        }
    }
}

#[tauri::command]
fn toggle_spotlight_window(app: tauri::AppHandle) {
    toggle_spotlight(&app);
}

// Ctrl+Shift+C: grab whatever's on the clipboard (user copies text/selection
// first) and open the spotlight with it ready to go, instead of making them
// open Quick Chat and paste manually.
fn open_spotlight_with_clipboard(app_handle: &tauri::AppHandle) {
    let text = arboard::Clipboard::new()
        .and_then(|mut c| c.get_text())
        .unwrap_or_default();

    if let Some(spotlight) = app_handle.get_webview_window("spotlight") {
        let _ = spotlight.show();
        let _ = spotlight.set_focus();
        let _ = spotlight.emit("clipboard-capture", text);
    }
}

fn focus_window(window: &tauri::WebviewWindow) {
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
    // Windows can refuse SetForegroundWindow from a background/tray process
    // (the "foreground lock" restriction), so the window becomes visible but
    // stays behind everything else. Briefly toggling always-on-top forces it
    // to the front regardless.
    let _ = window.set_always_on_top(true);
    let _ = window.set_always_on_top(false);
}

// Closing the main window (X button) destroys it rather than just hiding it —
// calling .hide() on it turned out to destroy it too, immediately, which
// appears to be a limitation of hosting child Webviews (the "unstable"
// multiwebview feature) on the window. So closing is left as a real close,
// and restoring means rebuilding the window from scratch if it's gone rather
// than relying on hide()/show().
fn restore_main_window(app_handle: &tauri::AppHandle) {
    if let Some(window) = app_handle.get_webview_window("main") {
        focus_window(&window);
        return;
    }

    match WebviewWindowBuilder::new(app_handle, "main", WebviewUrl::App("index.html".into()))
        .title("Gemini cho PC - TVT")
        .inner_size(1280.0, 800.0)
        .build()
    {
        Ok(window) => focus_window(&window),
        Err(e) => eprintln!("restore_main_window: failed to rebuild main window: {e}"),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // Setup Tray Icon
            let show_item = MenuItem::with_id(app, "show", "Hiện cửa sổ", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Thoát", true, None::<&str>)?;
            let tray_menu = Menu::with_items(app, &[&show_item, &quit_item])?;

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&tray_menu)
                // Without this, Tauri opens the menu on left-click too, so the
                // custom on_tray_icon_event show/focus handler below never fires.
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => restore_main_window(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event {
                        restore_main_window(tray.app_handle());
                    }
                })
                .build(app)?;

            // Setup Global Shortcuts
            let spotlight_shortcut = Shortcut::from_str("Ctrl+Shift+Space").unwrap();
            // Ctrl+Shift+C is Windows' own Copilot shortcut and Ctrl+Alt+G was
            // already claimed by something else on this machine — both failed
            // registration.
            let clipboard_shortcut = Shortcut::from_str("Ctrl+Alt+C").unwrap();

            // Register shortcuts; log (rather than silently ignore) if one is
            // already claimed by the OS or another app, since that's exactly the
            // kind of failure that's otherwise invisible.
            if let Err(e) = app.global_shortcut().on_shortcut(spotlight_shortcut, move |app_handle, _shortcut, event| {
                if event.state == ShortcutState::Pressed {
                    toggle_spotlight(app_handle);
                }
            }) {
                eprintln!("Failed to register Ctrl+Shift+Space shortcut: {e}");
            }
            if let Err(e) = app.global_shortcut().on_shortcut(clipboard_shortcut, move |app_handle, _shortcut, event| {
                if event.state == ShortcutState::Pressed {
                    open_spotlight_with_clipboard(app_handle);
                }
            }) {
                eprintln!("Failed to register Ctrl+Alt+C shortcut: {e}");
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            has_gemini_api_key,
            set_gemini_api_key,
            generate_content,
            toggle_spotlight_window,
            read_clipboard_text,
            read_file_as_attachment
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
