import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

interface AppSettings {
  spotlight_shortcut: string;
  clipboard_shortcut: string;
  spotlight_opacity: number;
  gemini_model: string;
  gemini_temperature: number;
  system_instruction: string;
}

type ShortcutSlot = "spotlight" | "clipboard";

const MODELS = [
  { id: "gemini-flash-latest", label: "Gemini Flash — nhanh, cân bằng (khuyến nghị)" },
  { id: "gemini-flash-lite-latest", label: "Gemini Flash-Lite — nhẹ nhất, nhanh nhất" },
  { id: "gemini-pro-latest", label: "Gemini Pro — mạnh nhất, chậm hơn" },
];

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
  const [systemInstructionDraft, setSystemInstructionDraft] = useState("");
  const capturingRef = useRef<ShortcutSlot | null>(null);

  const refresh = () => {
    invoke<AppSettings>("get_settings")
      .then((s) => {
        setSettings(s);
        setSystemInstructionDraft(s.system_instruction);
      })
      .catch(console.error);
    invoke<boolean>("get_autostart_enabled").then(setAutostart).catch(console.error);
    invoke<boolean>("has_gemini_api_key").then(setApiKeyConfigured).catch(console.error);
  };

  useEffect(() => {
    capturingRef.current = capturing;
  }, [capturing]);

  useEffect(() => {
    refresh();
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !capturingRef.current) {
        invoke("hide_settings_window").catch(console.error);
      }
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

  const changeModel = async (model: string) => {
    setSettings(prev => (prev ? { ...prev, gemini_model: model } : prev));
    try {
      await invoke("set_gemini_model", { model });
    } catch (err) {
      setError(typeof err === "string" ? err : String(err));
    }
  };

  const changeTemperature = async (value: number) => {
    setSettings(prev => (prev ? { ...prev, gemini_temperature: value } : prev));
    try {
      await invoke("set_gemini_temperature", { temperature: value });
    } catch (err) {
      setError(typeof err === "string" ? err : String(err));
    }
  };

  const saveSystemInstruction = async () => {
    setSettings(prev => (prev ? { ...prev, system_instruction: systemInstructionDraft } : prev));
    try {
      await invoke("set_system_instruction", { instruction: systemInstructionDraft });
    } catch (err) {
      setError(typeof err === "string" ? err : String(err));
    }
  };

  const changeOpacity = async (value: number) => {
    setSettings(prev => (prev ? { ...prev, spotlight_opacity: value } : prev));
    try {
      await invoke("set_spotlight_opacity", { opacity: value });
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
      <div className="px-5 py-4 border-b border-gray-100 flex items-center gap-2.5">
        <img src="/logo-small.png" alt="THADS Đông Hà Nội" className="w-7 h-7 rounded-full object-contain shrink-0" />
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
          <h2 className="text-xs font-bold uppercase text-gray-400 mb-1">Model &amp; độ sáng tạo</h2>
          <div className="py-2">
            <div className="text-sm font-medium text-gray-800 mb-1.5">Model Gemini</div>
            <select
              value={settings?.gemini_model ?? "gemini-flash-latest"}
              onChange={(e) => changeModel(e.target.value)}
              className="w-full text-sm px-3 py-2 rounded-lg bg-gray-100 text-gray-800 outline-none cursor-pointer"
            >
              {MODELS.map((m) => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
            </select>
          </div>
          <div className="py-2">
            <div className="flex items-center justify-between mb-1.5">
              <div className="text-sm font-medium text-gray-800">Độ sáng tạo (temperature)</div>
              <span className="text-xs text-gray-400 font-mono">
                {settings ? settings.gemini_temperature.toFixed(1) : "..."}
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={20}
              value={settings ? Math.round(settings.gemini_temperature * 10) : 10}
              onChange={(e) => changeTemperature(Number(e.target.value) / 10)}
              className="w-full accent-justice-blue cursor-pointer"
            />
            <div className="text-xs text-gray-400 mt-1">Thấp = chính xác, bám sát dữ kiện. Cao = sáng tạo, đa dạng hơn.</div>
          </div>
          <div className="py-2">
            <div className="text-sm font-medium text-gray-800 mb-1.5">Vai trò hệ thống (system instruction)</div>
            <textarea
              value={systemInstructionDraft}
              onChange={(e) => setSystemInstructionDraft(e.target.value)}
              onBlur={saveSystemInstruction}
              placeholder="Ví dụ: Bạn là trợ lý pháp lý, trả lời ngắn gọn, chính xác, có trích dẫn căn cứ pháp luật khi có thể."
              rows={3}
              className="w-full text-sm px-3 py-2 rounded-lg bg-gray-100 text-gray-800 outline-none resize-none placeholder-gray-400"
            />
            <div className="text-xs text-gray-400 mt-1">Áp dụng cho mọi cuộc trò chuyện Quick Chat mới</div>
          </div>
        </section>

        <section>
          <h2 className="text-xs font-bold uppercase text-gray-400 mb-1">Giao diện Quick Chat</h2>
          <div className="py-2">
            <div className="flex items-center justify-between mb-1.5">
              <div className="text-sm font-medium text-gray-800">Độ trong suốt</div>
              <span className="text-xs text-gray-400 font-mono">
                {settings ? Math.round(settings.spotlight_opacity * 100) : "..."}%
              </span>
            </div>
            <input
              type="range"
              min={30}
              max={100}
              value={settings ? Math.round(settings.spotlight_opacity * 100) : 90}
              onChange={(e) => changeOpacity(Number(e.target.value) / 100)}
              className="w-full accent-justice-blue cursor-pointer"
            />
            <div className="text-xs text-gray-400 mt-1">Áp dụng ngay cho cửa sổ Quick Chat</div>
          </div>
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

        <section>
          <h2 className="text-xs font-bold uppercase text-gray-400 mb-1">Giới thiệu</h2>
          <div className="py-2 text-sm text-gray-600 space-y-1">
            <div className="flex items-center gap-3 pb-1">
              <img src="/logo-small.png" alt="THADS Đông Hà Nội" className="w-12 h-12 rounded-full object-contain shrink-0" />
              <div>
                <div className="font-medium text-gray-800">THADS Đông Hà Nội - Trợ lý AI</div>
                <div className="text-xs text-gray-400">Phiên bản 0.1.0</div>
              </div>
            </div>
            <div className="text-xs text-gray-400 pt-1">
              Tích hợp Gemini, NotebookLM, Google Docs và AI Studio
            </div>
            <div className="text-xs text-gray-400 pt-2">
              Phát triển bởi Thang.TV<br />
              trieuvietthang@gmail.com
            </div>
            <div className="text-xs text-gray-400 pt-2 leading-relaxed">
              © 2026 Văn phòng Thi hành án dân sự Đông Hà Nội.<br />
              Số 5 Đường Núi Đôi, xã Sóc Sơn, Hà Nội.<br />
              Bảo lưu mọi quyền — phần mềm nội bộ, không phải mã nguồn mở.
            </div>
          </div>
        </section>
      </div>

      <div className="px-5 py-3 border-t border-gray-100 flex justify-end">
        <button
          type="button"
          onClick={() => invoke("hide_settings_window").catch(console.error)}
          className="px-4 py-2 bg-justice-blue text-white rounded-xl text-sm font-bold shadow-md hover:bg-blue-800 transition-colors cursor-pointer"
        >
          Đóng
        </button>
      </div>
    </div>
  );
}
