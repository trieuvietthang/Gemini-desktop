import { useEffect, useState, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Webview } from "@tauri-apps/api/webview";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { invoke } from "@tauri-apps/api/core";

interface Tab {
  id: string;
  name: string;
  url: string;
  icon: string;
}

const DEFAULT_TABS: Tab[] = [
  { id: "gemini", name: "Gemini AI", url: "https://gemini.google.com/app", icon: "💬" },
  { id: "gems", name: "Gems", url: "https://gemini.google.com/gems/view", icon: "💎" },
  { id: "notebook", name: "Sổ ghi chú", url: "https://gemini.google.com/notebook", icon: "📓" },
];

const SIDEBAR_WIDTH = 72;
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

export default function App() {
  const [tabs] = useState<Tab[]>(DEFAULT_TABS);
  const [activeTabId, setActiveTabId] = useState<string>("gemini");
  const webviewsRef = useRef<{ [key: string]: Webview }>({});

  // Webviews are created lazily (only when a tab is first opened) instead of all
  // at startup, so launching the app doesn't spin up several Chromium renderer
  // processes at once.
  const ensureWebview = (tab: Tab): Webview => {
    const existing = webviewsRef.current[tab.id];
    if (existing) return existing;

    const appWindow = getCurrentWindow();
    const webview = new Webview(appWindow, tab.id, {
      url: tab.url,
      x: SIDEBAR_WIDTH,
      y: 0,
      width: window.innerWidth - SIDEBAR_WIDTH,
      height: window.innerHeight,
      userAgent: USER_AGENT,
    });
    webviewsRef.current[tab.id] = webview;

    webview.once('tauri://error', (e) => {
      console.error(`Webview error for ${tab.id}:`, e);
    });

    return webview;
  };

  useEffect(() => {
    const handleResize = () => {
      for (const id in webviewsRef.current) {
        webviewsRef.current[id].setSize(new LogicalSize(window.innerWidth - SIDEBAR_WIDTH, window.innerHeight));
      }
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  useEffect(() => {
    const tab = tabs.find(t => t.id === activeTabId);
    if (!tab) return;

    ensureWebview(tab);

    for (const id in webviewsRef.current) {
      if (id === activeTabId) {
        webviewsRef.current[id].show();
      } else {
        webviewsRef.current[id].hide();
      }
    }
  }, [activeTabId]);

  const openSpotlight = () => {
    invoke("toggle_spotlight_window").catch(err => console.error("Failed to open Quick Chat:", err));
  };

  return (
    <div className="flex h-screen bg-transparent overflow-hidden relative">
      {/* Icon rail — Gemini's own webview already has its own navigation/sidebar,
          so this stays narrow and just switches workspaces + opens Quick Chat. */}
      <div className="w-[72px] bg-white border-r border-gray-200 flex flex-col items-center py-4 gap-2 shadow-[0_4px_12px_rgba(0,0,0,0.08)] z-10">
        <div
          className="w-10 h-10 rounded-xl bg-justice-blue text-white flex items-center justify-center font-bold shrink-0 mb-2"
          title="Đông Hà Nội - AI"
        >
          Đ
        </div>

        <div className="flex-1 flex flex-col gap-2 items-center overflow-y-auto w-full px-2">
          {tabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTabId(tab.id)}
              title={tab.name}
              className={`w-11 h-11 shrink-0 rounded-xl flex items-center justify-center text-lg transition-all duration-200 cursor-pointer ${
                activeTabId === tab.id
                  ? "bg-justice-blue text-white shadow-md"
                  : "text-gray-500 hover:bg-gray-100"
              }`}
            >
              {tab.icon}
            </button>
          ))}
        </div>

        <button
          onClick={openSpotlight}
          title="Quick Chat (Ctrl+Shift+Space)"
          className="w-11 h-11 shrink-0 flex items-center justify-center bg-authority-red text-white rounded-xl shadow-md hover:bg-red-700 transition-colors cursor-pointer"
        >
          ✦
        </button>
      </div>

      {/* Main Content Area (Webview goes here) */}
      <div className="flex-1 bg-transparent relative">
        <div className="absolute inset-0 flex items-center justify-center">
           <p className="text-gray-400 font-medium">Loading Workspace...</p>
        </div>
      </div>
    </div>
  );
}
