import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";

interface AppSettings {
  spotlight_shortcut: string;
  clipboard_shortcut: string;
}

type ShortcutSlot = "spotlight" | "clipboard";

const IGNORED_KEYS = new Set(["Control", "Alt", "Shift", "Meta"]);

function comboFromEvent(e: KeyboardEvent): string | null {
  if (IGNORED_KEYS.has(e.key)) return null;

  const parts: string[] = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  if (e.metaKey) parts.push("Super");

  // Global shortcuts need at least one modifier — a bare key can't be
  // registered system-wide.
  if (parts.length === 0) return null;

  let key = e.key;
  if (key === " ") key = "Space";
  else if (key.length === 1) key = key.toUpperCase();
  parts.push(key);
  return parts.join("+");
}

export default function Settings() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [autostart, setAutostart] = useState(false);
  const [apiKeyConfigured, setApiKeyConfigured] = useState(false);
  const [capturing, setCapturing] = useState<ShortcutSlot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmClearKey, setConfirmClearKey] = useState(false);

  const refresh = () => {
    invoke<AppSettings>("get_settings").then(setSettings).catch(console.error);
    invoke<boolean>("get_autostart_enabled").then(setAutostart).catch(console.error);
    invoke<boolean>("has_gemini_api_key").then(setApiKeyConfigured).catch(console.error);
  };

  useEffect(() => {
    refresh();
    const win = getCurrentWindow();
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !capturing) win.hide();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!capturing) return;

    const handler = (e: KeyboardEvent) => {
      e.preventDefault();
      if (e.key === "Escape") {
        setCapturing(null);
        return;
      }
      const combo = comboFromEvent(e);
      if (!combo) return; // still waiting for a real key, or no modifier held

      setError(null);
      invoke("update_shortcut", { which: capturing, combo })
        .then(() => setSettings(prev => (prev ? { ...prev, [`${capturing}_shortcut`]: combo } : prev)))
        .catch((err) => setError(typeof err === "string" ? err : String(err)))
        .finally(() => setCapturing(null));
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [capturing]);

  const toggleAutostart = async () => {
    const next = !autostart;
    try {
      await invoke("set_autostart_enabled", { enabled: next });
      setAutostart(next);
    } catch (err) {
      setError(typeof err === "string" ? err : String(err));
    }
  };

  const clearApiKey = async () => {
    try {
      await invoke("clear_gemini_api_key");
      setApiKeyConfigured(false);
      setConfirmClearKey(false);
    } catch (err) {
      setError(typeof err === "string" ? err : String(err));
    }
  };

  const ShortcutRow = ({ slot, label, hint }: { slot: ShortcutSlot; label: string; hint: string }) => (
    <div className="flex items-center justify-between py-2">
      <div>
        <div className="text-sm font-medium text-gray-800">{label}</div>
        <div className="text-xs text-gray-400">{hint}</div>
      </div>
      {capturing === slot ? (
        <span className="text-xs px-3 py-1.5 rounded-lg bg-justice-blue/10 text-justice-blue font-medium animate-pulse">
          Nhấn tổ hợp phím... (Esc để huỷ)
        </span>
      ) : (
        <button
          type="button"
          onClick={() => setCapturing(slot)}
          className="text-xs font-mono px-3 py-1.5 rounded-lg bg-gray-100 text-gray-700 hover:bg-gray-200 transition-colors cursor-pointer"
        >
          {settings ? settings[`${slot}_shortcut`] : "..."}
        </button>
      )}
    </div>
  );

  return (
    <div className="w-screen h-screen bg-white flex flex-col overflow-hidden">
      <div className="px-5 py-4 border-b border-gray-100">
        <h1 className="text-justice-blue font-bold text-lg">Cài đặt</h1>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-3 flex flex-col gap-5">
        <section>
          <h2 className="text-xs font-bold uppercase text-gray-400 mb-1">Phím tắt</h2>
          <div className="divide-y divide-gray-100">
            <ShortcutRow slot="spotlight" label="Mở Quick Chat" hint="Bật/tắt cửa sổ hỏi nhanh Gemini" />
            <ShortcutRow slot="clipboard" label="Hỏi về nội dung đã copy" hint="Mở Quick Chat kèm nội dung clipboard" />
          </div>
          {error && <p className="text-xs text-authority-red mt-2">{error}</p>}
        </section>

        <section>
          <h2 className="text-xs font-bold uppercase text-gray-400 mb-1">Khởi động</h2>
          <div className="flex items-center justify-between py-2">
            <div>
              <div className="text-sm font-medium text-gray-800">Khởi động cùng Windows</div>
              <div className="text-xs text-gray-400">Tự chạy ngầm khi bật máy</div>
            </div>
            <button
              type="button"
              onClick={toggleAutostart}
              className={`w-11 h-6 rounded-full transition-colors cursor-pointer relative ${
                autostart ? "bg-justice-blue" : "bg-gray-200"
              }`}
            >
              <span
                className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${
                  autostart ? "translate-x-[22px]" : "translate-x-0.5"
                }`}
              />
            </button>
          </div>
        </section>

        <section>
          <h2 className="text-xs font-bold uppercase text-gray-400 mb-1">Gemini API key</h2>
          <div className="flex items-center justify-between py-2">
            <div className="text-sm text-gray-600">
              {apiKeyConfigured ? "Đã cấu hình" : "Chưa cấu hình"}
            </div>
            {apiKeyConfigured && (
              confirmClearKey ? (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-500">Xoá key đã lưu?</span>
                  <button
                    type="button"
                    onClick={clearApiKey}
                    className="text-xs px-2.5 py-1 rounded-lg bg-authority-red text-white font-medium cursor-pointer"
                  >
                    Xoá
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmClearKey(false)}
                    className="text-xs px-2.5 py-1 rounded-lg bg-gray-100 text-gray-600 font-medium cursor-pointer"
                  >
                    Huỷ
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmClearKey(true)}
                  className="text-xs px-3 py-1.5 rounded-lg bg-gray-100 text-gray-600 hover:bg-gray-200 transition-colors cursor-pointer"
                >
                  Xoá key
                </button>
              )
            )}
          </div>
        </section>
      </div>

      <div className="px-5 py-3 border-t border-gray-100 flex justify-end">
        <button
          type="button"
          onClick={() => getCurrentWindow().hide()}
          className="px-4 py-2 bg-justice-blue text-white rounded-xl text-sm font-bold shadow-md hover:bg-blue-800 transition-colors cursor-pointer"
        >
          Đóng
        </button>
      </div>
    </div>
  );
}
