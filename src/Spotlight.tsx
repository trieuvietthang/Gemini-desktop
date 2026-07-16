import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";

interface Attachment {
  mime_type: string;
  data: string; // base64
  name: string;
}

interface Message {
  role: "user" | "model";
  text: string;
  attachments?: Attachment[];
}

const QUICK_ACTIONS = [
  { label: "Tóm tắt", instruction: "Tóm tắt ngắn gọn nội dung sau:" },
  { label: "Dịch sang tiếng Anh", instruction: "Dịch nội dung sau sang tiếng Anh:" },
  { label: "Giải thích", instruction: "Giải thích nội dung sau một cách dễ hiểu:" },
];

export default function Spotlight() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [query, setQuery] = useState("");
  const [pendingAttachments, setPendingAttachments] = useState<Attachment[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [apiKeyConfigured, setApiKeyConfigured] = useState<boolean | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [apiKeySaving, setApiKeySaving] = useState(false);
  const [clipboardQuickActions, setClipboardQuickActions] = useState(false);
  const [isCapturing, setIsCapturing] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    invoke<boolean>("has_gemini_api_key")
      .then(setApiKeyConfigured)
      .catch(() => setApiKeyConfigured(false));

    const win = getCurrentWindow();
    const webview = getCurrentWebview();

    const unlistenShown = listen("spotlight-shown", () => {
      setClipboardQuickActions(false);
      setTimeout(() => inputRef.current?.focus(), 50);
    });

    const unlistenClipboard = listen<string>("clipboard-capture", (event) => {
      setQuery(event.payload);
      setClipboardQuickActions(true);
      setTimeout(() => inputRef.current?.focus(), 50);
    });

    // Spotlight-style UX: clicking away hides the window instead of leaving it orphaned.
    const unlistenFocus = win.onFocusChanged(({ payload: focused }) => {
      if (!focused) win.hide();
    });

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") win.hide();
    };
    window.addEventListener("keydown", handleKeyDown);

    const unlistenDragDrop = webview.onDragDropEvent((event) => {
      if (event.payload.type === "over") {
        setIsDragOver(true);
      } else if (event.payload.type === "drop") {
        setIsDragOver(false);
        for (const path of event.payload.paths) {
          invoke<{ mime_type: string; data: string }>("read_file_as_attachment", { path })
            .then((att) => {
              const name = path.split(/[\\/]/).pop() || path;
              setPendingAttachments((prev) => [...prev, { ...att, name }]);
            })
            .catch((err) => console.error("Failed to read dropped file:", err));
        }
      } else {
        setIsDragOver(false);
      }
    });

    return () => {
      unlistenShown.then((f) => f());
      unlistenClipboard.then((f) => f());
      unlistenFocus.then((f) => f());
      unlistenDragDrop.then((f) => f());
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, isGenerating]);

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

  const sendMessage = async (text: string, attachments: Attachment[]) => {
    if (!text.trim() && attachments.length === 0) return;

    const userMessage: Message = { role: "user", text, attachments };
    const nextMessages = [...messages, userMessage];
    setMessages(nextMessages);
    setQuery("");
    setPendingAttachments([]);
    setClipboardQuickActions(false);
    setIsGenerating(true);

    try {
      const history = nextMessages.map((m) => ({
        role: m.role,
        text: m.text,
        attachments: (m.attachments || []).map((a) => ({ mime_type: a.mime_type, data: a.data })),
      }));
      const reply = await invoke<string>("generate_content", { history });
      setMessages((prev) => [...prev, { role: "model", text: reply }]);
    } catch (err: any) {
      const message = typeof err === "string" ? err : err.message;
      setMessages((prev) => [...prev, { role: "model", text: `Lỗi: ${message}` }]);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    sendMessage(query, pendingAttachments);
  };

  const handleQuickAction = (instruction: string) => {
    sendMessage(`${instruction}\n\n${query}`, pendingAttachments);
  };

  const handleNewChat = () => {
    setMessages([]);
    setQuery("");
    setPendingAttachments([]);
    setClipboardQuickActions(false);
  };

  const captureScreenshot = async () => {
    setIsCapturing(true);
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const video = document.createElement("video");
      video.srcObject = stream;
      await video.play();
      // Give the video element a moment to actually paint a frame.
      await new Promise((resolve) => setTimeout(resolve, 250));

      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext("2d")?.drawImage(video, 0, 0);

      const dataUrl = canvas.toDataURL("image/png");
      const data = dataUrl.split(",")[1];
      setPendingAttachments((prev) => [
        ...prev,
        { mime_type: "image/png", data, name: `screenshot-${Date.now()}.png` },
      ]);
    } catch (err) {
      console.error("Screenshot capture failed or was cancelled:", err);
    } finally {
      stream?.getTracks().forEach((t) => t.stop());
      setIsCapturing(false);
    }
  };

  const removeAttachment = (index: number) => {
    setPendingAttachments((prev) => prev.filter((_, i) => i !== index));
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
              onChange={(e) => setApiKeyInput(e.target.value)}
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
            <div className="p-3 border-b border-gray-100 flex items-center justify-between">
              <span className="text-justice-blue font-bold px-1">✨ Quick Chat</span>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={handleNewChat}
                  title="Cuộc trò chuyện mới"
                  className="text-gray-400 hover:text-gray-600 cursor-pointer p-1.5 rounded-lg hover:bg-gray-100 text-sm"
                >
                  🔄
                </button>
                <button
                  type="button"
                  onClick={() => getCurrentWindow().hide()}
                  className="text-gray-400 hover:text-gray-600 cursor-pointer p-1.5 rounded-lg hover:bg-gray-100"
                >
                  ✕
                </button>
              </div>
            </div>

            {(messages.length > 0 || isGenerating) && (
              <div ref={scrollRef} className="overflow-y-auto bg-gray-50 flex-1 p-4 flex flex-col gap-3">
                {messages.map((m, i) => (
                  <div
                    key={i}
                    className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap ${
                      m.role === "user"
                        ? "self-end bg-justice-blue text-white"
                        : "self-start bg-white text-gray-800 border border-gray-100"
                    }`}
                  >
                    {m.attachments && m.attachments.length > 0 && (
                      <div className="flex flex-wrap gap-1 mb-1.5">
                        {m.attachments.map((a, ai) => (
                          <span
                            key={ai}
                            className={`text-xs px-2 py-0.5 rounded-full ${
                              m.role === "user" ? "bg-white/20" : "bg-gray-100"
                            }`}
                          >
                            📎 {a.name}
                          </span>
                        ))}
                      </div>
                    )}
                    {m.text}
                  </div>
                ))}
                {isGenerating && (
                  <div className="self-start bg-white text-gray-500 border border-gray-100 rounded-2xl px-4 py-2.5 text-sm animate-pulse">
                    Đang trả lời...
                  </div>
                )}
              </div>
            )}

            {clipboardQuickActions && (
              <div className="px-4 pt-3 flex flex-wrap gap-2">
                {QUICK_ACTIONS.map((qa) => (
                  <button
                    key={qa.label}
                    type="button"
                    onClick={() => handleQuickAction(qa.instruction)}
                    className="text-xs px-3 py-1.5 rounded-full bg-justice-blue/10 text-justice-blue font-medium hover:bg-justice-blue/20 transition-colors cursor-pointer"
                  >
                    {qa.label}
                  </button>
                ))}
              </div>
            )}

            {pendingAttachments.length > 0 && (
              <div className="px-4 pt-3 flex flex-wrap gap-2">
                {pendingAttachments.map((a, i) => (
                  <span
                    key={i}
                    className="text-xs px-2 py-1 rounded-full bg-gray-100 text-gray-600 flex items-center gap-1"
                  >
                    📎 {a.name}
                    <button
                      type="button"
                      onClick={() => removeAttachment(i)}
                      className="text-gray-400 hover:text-gray-700 cursor-pointer"
                    >
                      ✕
                    </button>
                  </span>
                ))}
              </div>
            )}

            <form onSubmit={handleSubmit} className="p-3 flex items-center gap-2">
              <button
                type="button"
                onClick={captureScreenshot}
                disabled={isCapturing}
                title="Chụp màn hình để hỏi Gemini"
                className="shrink-0 w-9 h-9 flex items-center justify-center rounded-xl text-gray-500 hover:bg-gray-100 transition-colors cursor-pointer disabled:opacity-50"
              >
                {isCapturing ? "⏳" : "📷"}
              </button>
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={isDragOver ? "Thả file vào đây..." : "Hỏi Gemini bất cứ điều gì..."}
                className={`flex-1 bg-gray-50 rounded-xl px-3 py-2 outline-none text-gray-800 placeholder-gray-400 border ${
                  isDragOver ? "border-justice-blue" : "border-transparent"
                }`}
              />
              <button
                type="submit"
                disabled={isGenerating || (!query.trim() && pendingAttachments.length === 0)}
                className="shrink-0 w-9 h-9 flex items-center justify-center rounded-xl bg-authority-red text-white shadow-md hover:bg-red-700 transition-colors cursor-pointer disabled:opacity-50"
              >
                ➤
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
