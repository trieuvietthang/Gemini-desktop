// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

use tauri::{Manager, Emitter, WindowEvent, menu::{Menu, MenuItem}, tray::{TrayIconBuilder, MouseButton, MouseButtonState, TrayIconEvent}};
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

fn restore_main_window(app_handle: &tauri::AppHandle) {
    let Some(window) = app_handle.get_webview_window("main") else {
        println!("restore_main_window: no 'main' window handle");
        return;
    };
    println!(
        "restore_main_window: before visible={:?} minimized={:?} pos={:?}",
        window.is_visible(),
        window.is_minimized(),
        window.outer_position()
    );

    // Defensive: unminimize() is a no-op if the window isn't minimized, but
    // covers the case where it ended up minimized rather than just hidden.
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
    // Windows can refuse SetForegroundWindow from a background/tray process
    // (the "foreground lock" restriction), so the window becomes visible but
    // stays behind everything else. Briefly toggling always-on-top forces it
    // to the front regardless.
    let _ = window.set_always_on_top(true);
    let _ = window.set_always_on_top(false);

    println!(
        "restore_main_window: after visible={:?} minimized={:?}",
        window.is_visible(),
        window.is_minimized()
    );
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // Closing the main window destroys it entirely by default, after which the
            // tray icon has nothing left to show/focus (the app keeps running via the
            // tray, but the window is gone for good). Hide instead, so the tray icon
            // can always bring it back.
            match app.get_webview_window("main") {
                Some(main_window) => {
                    println!("setup: main window found, attaching close handler");
                    let main_window_for_close = main_window.clone();
                    main_window.on_window_event(move |event| {
                        if let WindowEvent::CloseRequested { api, .. } = event {
                            println!("main window: CloseRequested — preventing close, hiding instead");
                            api.prevent_close();
                            let _ = main_window_for_close.hide();
                        }
                    });
                }
                None => {
                    println!("setup: main window NOT found — close handler NOT attached");
                }
            }

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

            // Setup Global Shortcut (Ctrl+Shift+Space)
            let shortcut = Shortcut::from_str("Ctrl+Shift+Space").unwrap();
            
            // Register shortcut, ignore error if already registered to prevent panic
            let _ = app.global_shortcut().on_shortcut(shortcut, move |app_handle, _shortcut, event| {
                if event.state == ShortcutState::Pressed {
                    toggle_spotlight(app_handle);
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            has_gemini_api_key,
            set_gemini_api_key,
            generate_content,
            toggle_spotlight_window
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
