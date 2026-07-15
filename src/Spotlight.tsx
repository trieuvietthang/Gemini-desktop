import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";

export default function Spotlight() {
  const [query, setQuery] = useState("");
  const [answer, setAnswer] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [apiKeyConfigured, setApiKeyConfigured] = useState<boolean | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [apiKeySaving, setApiKeySaving] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);

  const refresh = () => {
    setQuery("");
    setAnswer("");
    invoke<boolean>("has_gemini_api_key")
      .then(setApiKeyConfigured)
      .catch(() => setApiKeyConfigured(false));
    setTimeout(() => inputRef.current?.focus(), 50);
  };

  useEffect(() => {
    refresh();
    const win = getCurrentWindow();

    const unlistenShown = listen("spotlight-shown", refresh);
    // Spotlight-style UX: clicking away hides the window instead of leaving it orphaned.
    const unlistenFocus = win.onFocusChanged(({ payload: focused }) => {
      if (!focused) win.hide();
    });

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") win.hide();
    };
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      unlistenShown.then(f => f());
      unlistenFocus.then(f => f());
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  const handleSaveApiKey = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!apiKeyInput.trim()) return;
    setApiKeySaving(true);
    try {
      await invoke("set_gemini_api_key", { key: apiKeyInput.trim() });
      setApiKeyConfigured(true);
      setApiKeyInput("");
    } catch (err) {
      console.error("Failed to save API key:", err);
    } finally {
      setApiKeySaving(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;

    setIsGenerating(true);
    setAnswer("");

    try {
      const text = await invoke<string>("generate_content", { prompt: query });
      setAnswer(text);
    } catch (err: any) {
      console.error(err);
      setAnswer(`Error: ${typeof err === "string" ? err : err.message}`);
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <div className="w-screen h-screen flex items-start justify-center p-3">
      <div className="bg-white w-full h-full rounded-2xl shadow-[0_12px_40px_rgba(0,0,0,0.3)] overflow-hidden flex flex-col border border-gray-100">
        {apiKeyConfigured === false ? (
          <form onSubmit={handleSaveApiKey} className="p-6 flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <span className="text-justice-blue font-bold">Cấu hình Gemini API key</span>
              <button
                type="button"
                onClick={() => getCurrentWindow().hide()}
                className="text-gray-400 hover:text-gray-600 cursor-pointer p-1"
              >
                ✕
              </button>
            </div>
            <p className="text-sm text-gray-500">
              Nhập Gemini API key để dùng Quick Chat. Key được lưu cục bộ trên máy này, không gửi đi đâu khác.
            </p>
            <input
              ref={inputRef}
              type="password"
              value={apiKeyInput}
              onChange={e => setApiKeyInput(e.target.value)}
              placeholder="Dán API key vào đây..."
              className="border border-gray-200 rounded-lg px-3 py-2 outline-none focus:border-justice-blue text-gray-800"
            />
            <button
              type="submit"
              disabled={apiKeySaving || !apiKeyInput.trim()}
              className="self-end px-4 py-2 bg-justice-blue text-white rounded-xl text-sm font-bold shadow-md hover:bg-blue-800 transition-colors disabled:opacity-50 cursor-pointer"
            >
              {apiKeySaving ? "Đang lưu..." : "Lưu"}
            </button>
          </form>
        ) : (
          <>
            <form onSubmit={handleSubmit} className="p-4 border-b border-gray-100 flex items-center gap-3">
              <span className="text-justice-blue font-bold">✨ AI</span>
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="Ask Gemini anything..."
                className="flex-1 bg-transparent outline-none text-lg text-gray-800 placeholder-gray-400"
              />
              <button
                type="button"
                onClick={() => getCurrentWindow().hide()}
                className="text-gray-400 hover:text-gray-600 cursor-pointer p-1"
              >
                ✕
              </button>
            </form>

            {(answer || isGenerating) && (
              <div className="p-6 overflow-y-auto bg-gray-50 flex-1">
                {isGenerating ? (
                  <p className="text-gray-500 animate-pulse font-medium">Generating response...</p>
                ) : (
                  <div className="text-gray-800 leading-relaxed whitespace-pre-wrap">
                    {answer}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
