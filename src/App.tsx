import { useEffect, useState, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Webview } from "@tauri-apps/api/webview";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";

interface Tab {
  id: string;
  name: string;
  url: string;
}

const DEFAULT_TABS: Tab[] = [
  { id: "gemini", name: "Gemini AI", url: "https://gemini.google.com/app" },
  { id: "advanced", name: "GEMs", url: "https://gemini.google.com/gems/view" },
  { id: "search", name: "Search", url: "https://gemini.google.com/search" },
];



export default function App() {
  const [tabs, _setTabs] = useState<Tab[]>(DEFAULT_TABS);
  const [activeTabId, setActiveTabId] = useState<string>("gemini");
  const webviewsRef = useRef<{ [key: string]: Webview }>({});
  
  const [showSpotlight, setShowSpotlight] = useState(false);
  const [spotlightQuery, setSpotlightQuery] = useState("");
  const [spotlightAnswer, setSpotlightAnswer] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [apiKeyConfigured, setApiKeyConfigured] = useState<boolean | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [apiKeySaving, setApiKeySaving] = useState(false);

  const spotlightInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const unlisten = listen("toggle-spotlight", () => {
      setShowSpotlight(prev => !prev);
    });
    return () => {
      unlisten.then(f => f());
    };
  }, []);

  useEffect(() => {
    if (showSpotlight) {
      invoke<boolean>("has_gemini_api_key")
        .then(setApiKeyConfigured)
        .catch(() => setApiKeyConfigured(false));
    }
  }, [showSpotlight]);

  // Tab content is rendered as a separate native Webview stacked above the
  // main window's webview, so it visually covers the spotlight overlay
  // unless we hide it first.
  useEffect(() => {
    const activeWebview = webviewsRef.current[activeTabId];
    if (!activeWebview) return;
    if (showSpotlight) {
      activeWebview.hide();
    } else {
      activeWebview.show();
    }
  }, [showSpotlight, activeTabId]);

  const handleSaveApiKey = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!apiKeyInput.trim()) return;
    setApiKeySaving(true);
    try {
      await invoke("set_gemini_api_key", { key: apiKeyInput.trim() });
      setApiKeyConfigured(true);
      setApiKeyInput("");
    } catch (err: any) {
      console.error("Failed to save API key:", err);
    } finally {
      setApiKeySaving(false);
    }
  };

  useEffect(() => {
    if (showSpotlight && spotlightInputRef.current) {
      setTimeout(() => spotlightInputRef.current?.focus(), 100);
    }
  }, [showSpotlight]);

  useEffect(() => {
    const initWebview = async () => {
      const appWindow = getCurrentWindow();
      const sidebarWidth = 260;
      
      for (const tab of tabs) {
        if (!webviewsRef.current[tab.id]) {
          try {
            const webview = new Webview(appWindow, tab.id, {
              url: tab.url,
              x: sidebarWidth,
              y: 0,
              width: window.innerWidth - sidebarWidth,
              height: window.innerHeight,
              userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
            });
            webviewsRef.current[tab.id] = webview;
            
            webview.once('tauri://created', () => {
               if (tab.id === activeTabId) {
                 webview.show();
               } else {
                 webview.hide();
               }
            });
            webview.once('tauri://error', (e) => {
               console.error(`Webview error for ${tab.id}:`, e);
            });
          } catch (e: any) {
            console.error(`Exception creating webview ${tab.id}:`, e);
          }
        }
      }

      const handleResize = () => {
        for (const id in webviewsRef.current) {
           const wv = webviewsRef.current[id];
           wv.setSize(new LogicalSize(window.innerWidth - sidebarWidth, window.innerHeight));
        }
      };
      
      window.addEventListener("resize", handleResize);
      return () => window.removeEventListener("resize", handleResize);
    };

    initWebview();
  }, [tabs]);

  useEffect(() => {
    for (const id in webviewsRef.current) {
      if (id === activeTabId) {
        webviewsRef.current[id].show();
      } else {
        webviewsRef.current[id].hide();
      }
    }
  }, [activeTabId]);

  const handleSpotlightSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!spotlightQuery.trim()) return;

    setIsGenerating(true);
    setSpotlightAnswer("");

    try {
      const text = await invoke<string>("generate_content", { prompt: spotlightQuery });
      setSpotlightAnswer(text);
    } catch (err: any) {
      console.error(err);
      setSpotlightAnswer(`Error: ${typeof err === "string" ? err : err.message}`);
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <div className="flex h-screen bg-transparent overflow-hidden relative">
      {/* Sidebar */}
      <div className="w-[260px] bg-white border-r border-gray-200 flex flex-col shadow-[0_4px_12px_rgba(0,0,0,0.08)] z-10">
        <div className="p-6 border-b border-gray-100">
          <h1 className="text-[#2338B8] font-bold text-xl tracking-wide uppercase">Thừa Phát Lại</h1>
          <p className="text-xs text-gray-500 mt-1 uppercase font-semibold">Đông Hà Nội - AI</p>
        </div>
        
        <div className="p-4 flex-1 overflow-y-auto">
          <p className="text-xs text-gray-400 font-bold uppercase mb-3 px-2">Workspaces</p>
          <ul className="space-y-1">
            {tabs.map(tab => (
              <li key={tab.id}>
                <button
                  onClick={() => setActiveTabId(tab.id)}
                  className={`w-full text-left px-3 py-2.5 rounded-xl transition-all duration-200 text-sm font-medium ${
                    activeTabId === tab.id
                      ? "bg-[#2338B8] text-white shadow-md"
                      : "text-gray-600 hover:bg-gray-100"
                  }`}
                >
                  {tab.name}
                </button>
              </li>
            ))}
          </ul>
        </div>
        
        <div className="p-4 border-t border-gray-100">
          <button 
            onClick={() => setShowSpotlight(true)}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-[#F0191D] text-white rounded-xl text-sm font-bold shadow-md hover:bg-red-700 transition-colors cursor-pointer"
          >
             Quick Chat (Ctrl+Shift+Space)
          </button>
        </div>
      </div>
      
      {/* Main Content Area (Webview goes here) */}
      <div className="flex-1 bg-transparent relative">
        <div className="absolute inset-0 flex items-center justify-center">
           <p className="text-gray-400 font-medium">Loading Workspace...</p>
        </div>
      </div>

      {/* Spotlight Overlay */}
      {showSpotlight && (
        <div className="absolute inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
          <div className="bg-white w-full max-w-2xl rounded-2xl shadow-[0_12px_40px_rgba(0,0,0,0.2)] overflow-hidden flex flex-col max-h-[80vh]">
            {apiKeyConfigured === false ? (
              <form onSubmit={handleSaveApiKey} className="p-6 flex flex-col gap-3">
                <div className="flex items-center justify-between">
                  <span className="text-[#2338B8] font-bold">Cấu hình Gemini API key</span>
                  <button
                    type="button"
                    onClick={() => setShowSpotlight(false)}
                    className="text-gray-400 hover:text-gray-600 cursor-pointer p-1"
                  >
                    ✕
                  </button>
                </div>
                <p className="text-sm text-gray-500">
                  Nhập Gemini API key để dùng Quick Chat. Key được lưu cục bộ trên máy này, không gửi đi đâu khác.
                </p>
                <input
                  ref={spotlightInputRef}
                  type="password"
                  value={apiKeyInput}
                  onChange={e => setApiKeyInput(e.target.value)}
                  placeholder="Dán API key vào đây..."
                  className="border border-gray-200 rounded-lg px-3 py-2 outline-none focus:border-[#2338B8] text-gray-800"
                />
                <button
                  type="submit"
                  disabled={apiKeySaving || !apiKeyInput.trim()}
                  className="self-end px-4 py-2 bg-[#2338B8] text-white rounded-xl text-sm font-bold shadow-md hover:bg-blue-800 transition-colors disabled:opacity-50 cursor-pointer"
                >
                  {apiKeySaving ? "Đang lưu..." : "Lưu"}
                </button>
              </form>
            ) : (
              <>
                <form onSubmit={handleSpotlightSubmit} className="p-4 border-b border-gray-100 flex items-center gap-3">
                  <span className="text-[#2338B8] font-bold">✨ AI</span>
                  <input
                    ref={spotlightInputRef}
                    type="text"
                    value={spotlightQuery}
                    onChange={e => setSpotlightQuery(e.target.value)}
                    placeholder="Ask Gemini anything..."
                    className="flex-1 bg-transparent outline-none text-lg text-gray-800 placeholder-gray-400"
                  />
                  <button
                    type="button"
                    onClick={() => setShowSpotlight(false)}
                    className="text-gray-400 hover:text-gray-600 cursor-pointer p-1"
                  >
                    ✕
                  </button>
                </form>

                {(spotlightAnswer || isGenerating) && (
                  <div className="p-6 overflow-y-auto bg-gray-50 flex-1">
                    {isGenerating ? (
                      <p className="text-gray-500 animate-pulse font-medium">Generating response...</p>
                    ) : (
                      <div className="text-gray-800 leading-relaxed whitespace-pre-wrap">
                        {spotlightAnswer}
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
