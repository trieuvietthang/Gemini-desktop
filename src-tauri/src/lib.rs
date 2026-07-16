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

#[tauri::command]
fn clear_gemini_api_key(app: tauri::AppHandle) -> Result<(), String> {
    let path = secrets_path(&app)?;
    if path.exists() {
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

const DEFAULT_SPOTLIGHT_SHORTCUT: &str = "Ctrl+Shift+Space";
const DEFAULT_CLIPBOARD_SHORTCUT: &str = "Ctrl+Alt+C";

#[derive(Serialize, Deserialize, Clone)]
struct AppSettings {
    spotlight_shortcut: String,
    clipboard_shortcut: String,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            spotlight_shortcut: DEFAULT_SPOTLIGHT_SHORTCUT.to_string(),
            clipboard_shortcut: DEFAULT_CLIPBOARD_SHORTCUT.to_string(),
        }
    }
}

fn settings_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("settings.json"))
}

fn load_settings(app: &tauri::AppHandle) -> AppSettings {
    settings_path(app)
        .ok()
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|data| serde_json::from_str(&data).ok())
        .unwrap_or_default()
}

fn save_settings(app: &tauri::AppHandle, settings: &AppSettings) -> Result<(), String> {
    let path = settings_path(app)?;
    let data = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    fs::write(path, data).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_settings(app: tauri::AppHandle) -> AppSettings {
    load_settings(&app)
}

#[tauri::command]
fn get_autostart_enabled(app: tauri::AppHandle) -> bool {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().unwrap_or(false)
}

#[tauri::command]
fn set_autostart_enabled(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    let manager = app.autolaunch();
    let result = if enabled { manager.enable() } else { manager.disable() };
    result.map_err(|e| e.to_string())
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

// Grab whatever's on the clipboard (user copies text/selection first) and
// open the spotlight with it ready to go, instead of making them open Quick
// Chat and paste manually.
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

// Settings has real window decorations (title bar, native X), and X isn't
// intercepted — so unlike the spotlight window, it can actually be destroyed
// (not just hidden) by the user. Same fix as the main window: rebuild it on
// demand if it's gone instead of assuming it's still there to show/hide.
fn toggle_settings(app_handle: &tauri::AppHandle) {
    if let Some(settings) = app_handle.get_webview_window("settings") {
        if settings.is_visible().unwrap_or(false) {
            let _ = settings.hide();
        } else {
            focus_window(&settings);
        }
        return;
    }

    match WebviewWindowBuilder::new(app_handle, "settings", WebviewUrl::App("index.html?settings=1".into()))
        .title("Cài đặt - Gemini cho PC")
        .inner_size(480.0, 480.0)
        .resizable(false)
        .center()
        .build()
    {
        Ok(window) => focus_window(&window),
        Err(e) => eprintln!("toggle_settings: failed to rebuild settings window: {e}"),
    }
}

#[tauri::command]
fn toggle_settings_window(app: tauri::AppHandle) {
    toggle_settings(&app);
}

// Called from the Settings window's own "Đóng" button. Hiding via a Rust
// command instead of the JS window.hide() API sidesteps whatever made the
// frontend call a no-op for this particular window.
#[tauri::command]
fn hide_settings_window(app: tauri::AppHandle) {
    if let Some(settings) = app.get_webview_window("settings") {
        let _ = settings.hide();
    }
}

// Both used at startup (with the saved/default combo) and from the Settings
// window (with a newly picked combo), so the handler logic only lives once.
fn register_spotlight_shortcut(app: &tauri::AppHandle, combo: &str) -> Result<(), String> {
    let shortcut = Shortcut::from_str(combo).map_err(|e| e.to_string())?;
    app.global_shortcut()
        .on_shortcut(shortcut, move |app_handle, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                toggle_spotlight(app_handle);
            }
        })
        .map_err(|e| e.to_string())
}

fn register_clipboard_shortcut(app: &tauri::AppHandle, combo: &str) -> Result<(), String> {
    let shortcut = Shortcut::from_str(combo).map_err(|e| e.to_string())?;
    app.global_shortcut()
        .on_shortcut(shortcut, move |app_handle, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                open_spotlight_with_clipboard(app_handle);
            }
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn update_shortcut(app: tauri::AppHandle, which: String, combo: String) -> Result<(), String> {
    // Validate before touching anything so a bad combo never unregisters the
    // working one.
    Shortcut::from_str(&combo).map_err(|e| format!("Tổ hợp phím không hợp lệ: {e}"))?;

    let mut settings = load_settings(&app);
    let old_combo = match which.as_str() {
        "spotlight" => settings.spotlight_shortcut.clone(),
        "clipboard" => settings.clipboard_shortcut.clone(),
        _ => return Err(format!("Unknown shortcut slot: {which}")),
    };
    if let Ok(old_shortcut) = Shortcut::from_str(&old_combo) {
        let _ = app.global_shortcut().unregister(old_shortcut);
    }

    let register_result = match which.as_str() {
        "spotlight" => register_spotlight_shortcut(&app, &combo),
        "clipboard" => register_clipboard_shortcut(&app, &combo),
        _ => unreachable!(),
    };

    if let Err(e) = register_result {
        // Re-register the old combo so the app isn't left with neither.
        let _ = match which.as_str() {
            "spotlight" => register_spotlight_shortcut(&app, &old_combo),
            _ => register_clipboard_shortcut(&app, &old_combo),
        };
        return Err(e);
    }

    match which.as_str() {
        "spotlight" => settings.spotlight_shortcut = combo,
        _ => settings.clipboard_shortcut = combo,
    }
    save_settings(&app, &settings)
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
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .setup(|app| {
            // Setup Tray Icon
            let show_item = MenuItem::with_id(app, "show", "Hiện cửa sổ", true, None::<&str>)?;
            let settings_item = MenuItem::with_id(app, "settings", "Cài đặt", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Thoát", true, None::<&str>)?;
            let tray_menu = Menu::with_items(app, &[&show_item, &settings_item, &quit_item])?;

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&tray_menu)
                // Without this, Tauri opens the menu on left-click too, so the
                // custom on_tray_icon_event show/focus handler below never fires.
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => restore_main_window(app),
                    "settings" => toggle_settings(app),
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

            // Setup Global Shortcuts, using the saved combo if the user has
            // customized it via Settings, otherwise the defaults.
            let settings = load_settings(app.handle());
            if let Err(e) = register_spotlight_shortcut(app.handle(), &settings.spotlight_shortcut) {
                eprintln!("Failed to register spotlight shortcut '{}': {e}", settings.spotlight_shortcut);
            }
            if let Err(e) = register_clipboard_shortcut(app.handle(), &settings.clipboard_shortcut) {
                eprintln!("Failed to register clipboard shortcut '{}': {e}", settings.clipboard_shortcut);
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            has_gemini_api_key,
            set_gemini_api_key,
            clear_gemini_api_key,
            generate_content,
            toggle_spotlight_window,
            toggle_settings_window,
            hide_settings_window,
            read_clipboard_text,
            read_file_as_attachment,
            get_settings,
            update_shortcut,
            get_autostart_enabled,
            set_autostart_enabled
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
