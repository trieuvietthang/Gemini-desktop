import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Webview } from "@tauri-apps/api/webview";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { invoke } from "@tauri-apps/api/core";

interface Tab {
  id: string;
  name: string;
  url: string;
  icon: string;
}

const TABS: Tab[] = [
  { id: "gemini", name: "Gemini", url: "https://gemini.google.com/app", icon: "💬" },
  { id: "notebook", name: "Sổ ghi chú", url: "https://notebooklm.google.com/", icon: "📓" },
  { id: "docs", name: "Google Docs", url: "https://docs.google.com/document/u/0/", icon: "📄" },
  { id: "aistudio", name: "AI Studio", url: "https://aistudio.google.com/", icon: "🧪" },
];

const EXPANDED_WIDTH = 72;
const COLLAPSED_WIDTH = 10;
const COLLAPSE_DELAY_MS = 300;
const OFFSCREEN_X = -100000;
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

export default function App() {
  const [activeTabId, setActiveTabId] = useState<string>("gemini");
  const [sidebarExpanded, setSidebarExpanded] = useState(false);
  const webviewsRef = useRef<{ [key: string]: Webview }>({});
  const collapseTimerRef = useRef<number | null>(null);

  const sidebarWidth = sidebarExpanded ? EXPANDED_WIDTH : COLLAPSED_WIDTH;

  const contentSize = () => ({
    width: window.innerWidth - sidebarWidth,
    height: window.innerHeight,
  });

  // Switching tabs used to hide()/show() the child Webviews, but that turned out
  // to have z-order bugs on Windows (an inactive one could still render on top
  // of whichever tab — or the spotlight window — was supposed to be visible).
  // Moving the inactive webview off-canvas instead sidesteps that entirely: a
  // webview positioned outside the window's bounds simply can't visually
  // interfere with anything, regardless of native stacking order. The same
  // reasoning is why the sidebar auto-hide below *resizes* the active webview
  // instead of letting the expanded rail float on top of it — a native child
  // webview always draws over the window's own React content, so an overlay
  // rail would just get hidden behind whichever tab is showing.
  const layout = (currentActiveId: string) => {
    const { width, height } = contentSize();
    for (const id in webviewsRef.current) {
      const wv = webviewsRef.current[id];
      wv.setSize(new LogicalSize(width, height));
      wv.setPosition(new LogicalPosition(id === currentActiveId ? sidebarWidth : OFFSCREEN_X, 0));
    }
  };

  const ensureWebview = (tab: Tab): Webview => {
    const existing = webviewsRef.current[tab.id];
    if (existing) return existing;

    const appWindow = getCurrentWindow();
    const { width, height } = contentSize();
    const webview = new Webview(appWindow, tab.id, {
      url: tab.url,
      x: tab.id === activeTabId ? sidebarWidth : OFFSCREEN_X,
      y: 0,
      width,
      height,
      userAgent: USER_AGENT,
      // Lets Ctrl+/Ctrl-/Ctrl+scroll zoom the page, same as a browser tab —
      // without this the content is stuck at one scale regardless of the
      // display's resolution/DPI.
      zoomHotkeysEnabled: true,
    });
    webviewsRef.current[tab.id] = webview;

    webview.once('tauri://error', (e) => {
      console.error(`Webview error for ${tab.id}:`, e);
    });

    return webview;
  };

  useEffect(() => {
    const tab = TABS.find(t => t.id === activeTabId);
    if (!tab) return;

    ensureWebview(tab);
    layout(activeTabId);

    const handleResize = () => layout(activeTabId);
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
    // sidebarWidth changes (auto-hide expand/collapse) also need a relayout
    // so the active webview shrinks/grows to make room instead of overlapping.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabId, sidebarWidth]);

  useEffect(() => {
    return () => {
      if (collapseTimerRef.current) window.clearTimeout(collapseTimerRef.current);
    };
  }, []);

  const handleSidebarEnter = () => {
    if (collapseTimerRef.current) {
      window.clearTimeout(collapseTimerRef.current);
      collapseTimerRef.current = null;
    }
    setSidebarExpanded(true);
  };

  const handleSidebarLeave = () => {
    collapseTimerRef.current = window.setTimeout(() => setSidebarExpanded(false), COLLAPSE_DELAY_MS);
  };

  const openSpotlight = () => {
    invoke("toggle_spotlight_window").catch(err => console.error("Failed to open Quick Chat:", err));
  };

  const openSettings = () => {
    invoke("toggle_settings_window").catch(err => console.error("Failed to open Settings:", err));
  };

  return (
    <div className="flex h-screen bg-transparent overflow-hidden relative">
      <div
        onMouseEnter={handleSidebarEnter}
        onMouseLeave={handleSidebarLeave}
        style={{ width: sidebarWidth }}
        className="bg-white border-r border-gray-200 flex flex-col items-center py-4 shrink-0 shadow-[0_4px_12px_rgba(0,0,0,0.08)] z-10 overflow-hidden transition-[width] duration-200 ease-out"
      >
        {sidebarExpanded ? (
          <div className="flex flex-col items-center gap-2 w-full h-full">
            <div
              className="w-10 h-10 rounded-xl bg-justice-blue text-white flex items-center justify-center font-bold shrink-0 mb-2"
              title="Gemini cho PC - TVT"
            >
              T
            </div>

            <div className="flex flex-col gap-2 items-center w-full px-2">
              {TABS.map(tab => (
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

            <div className="flex-1" />

            <button
              onClick={openSettings}
              title="Cài đặt"
              className="w-11 h-11 shrink-0 flex items-center justify-center rounded-xl text-gray-500 hover:bg-gray-100 transition-colors cursor-pointer mb-2"
            >
              ⚙️
            </button>

            <button
              onClick={openSpotlight}
              title="Quick Chat (Ctrl+Shift+Space)"
              className="w-11 h-11 shrink-0 flex items-center justify-center bg-authority-red text-white rounded-xl shadow-md hover:bg-red-700 transition-colors cursor-pointer"
            >
              ✦
            </button>
          </div>
        ) : (
          <div className="w-1.5 h-16 rounded-full bg-gray-200 mt-6" />
        )}
      </div>

      {/* Main Content Area (Webview goes here) */}
      <div className="flex-1 bg-transparent relative">
        <div className="absolute inset-0 flex items-center justify-center">
           <p className="text-gray-400 font-medium">Đang tải...</p>
        </div>
      </div>
    </div>
  );
}
