import { useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Webview } from "@tauri-apps/api/webview";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";

const GEMINI_URL = "https://gemini.google.com/app";
const NOTEBOOK_URL = "https://notebooklm.google.com/";
const SIDEBAR_WIDTH = 72;
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

export default function App() {
  const webviewRef = useRef<Webview | null>(null);

  // A single persistent Webview for Gemini itself — Gemini's own web UI already
  // has Gems/Notes/history navigation built in, so there's no need to juggle
  // several native child Webviews (which turned out to have z-order/lifecycle
  // bugs when switching between them).
  useEffect(() => {
    const appWindow = getCurrentWindow();
    const webview = new Webview(appWindow, "gemini", {
      url: GEMINI_URL,
      x: SIDEBAR_WIDTH,
      y: 0,
      width: window.innerWidth - SIDEBAR_WIDTH,
      height: window.innerHeight,
      userAgent: USER_AGENT,
      // Lets Ctrl+/Ctrl-/Ctrl+scroll zoom the page, same as a browser tab —
      // without this the content is stuck at one scale regardless of the
      // display's resolution/DPI.
      zoomHotkeysEnabled: true,
    });
    webviewRef.current = webview;

    webview.once('tauri://error', (e) => {
      console.error("Gemini webview error:", e);
    });

    const handleResize = () => {
      webview.setSize(new LogicalSize(window.innerWidth - SIDEBAR_WIDTH, window.innerHeight));
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  const openSpotlight = () => {
    invoke("toggle_spotlight_window").catch(err => console.error("Failed to open Quick Chat:", err));
  };

  const openNotebook = () => {
    // NotebookLM is a separate product/origin from gemini.google.com, so it
    // can't be reached through Gemini's own in-page navigation. Opening it in
    // the system browser is simpler and more reliable than another embedded
    // Webview, and keeps the app's own resource usage down.
    openUrl(NOTEBOOK_URL).catch((err: unknown) => console.error("Failed to open Notebook:", err));
  };

  return (
    <div className="flex h-screen bg-transparent overflow-hidden relative">
      <div className="w-[72px] bg-white border-r border-gray-200 flex flex-col items-center py-4 gap-2 shadow-[0_4px_12px_rgba(0,0,0,0.08)] z-10">
        <div
          className="w-10 h-10 rounded-xl bg-justice-blue text-white flex items-center justify-center font-bold shrink-0 mb-2"
          title="Gemini cho PC - TVT"
        >
          T
        </div>

        <div className="flex-1" />

        <button
          onClick={openNotebook}
          title="Sổ ghi chú (NotebookLM) — mở trong trình duyệt"
          className="w-11 h-11 shrink-0 flex items-center justify-center text-lg text-gray-500 hover:bg-gray-100 rounded-xl transition-colors cursor-pointer"
        >
          📓
        </button>

        <button
          onClick={openSpotlight}
          title="Quick Chat (Ctrl+Shift+Space)"
          className="w-11 h-11 shrink-0 flex items-center justify-center bg-authority-red text-white rounded-xl shadow-md hover:bg-red-700 transition-colors cursor-pointer"
        >
          ✦
        </button>
      </div>

      {/* Main Content Area (Gemini webview goes here) */}
      <div className="flex-1 bg-transparent relative">
        <div className="absolute inset-0 flex items-center justify-center">
           <p className="text-gray-400 font-medium">Đang tải Gemini...</p>
        </div>
      </div>
    </div>
  );
}
