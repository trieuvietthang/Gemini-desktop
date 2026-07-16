import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

interface AppSettings {
  spotlight_shortcut: string;
  clipboard_shortcut: string;
}

interface Section {
  title: string;
  items: { label: string; detail: string }[];
}

export default function Help() {
  const [shortcuts, setShortcuts] = useState<AppSettings | null>(null);

  useEffect(() => {
    invoke<AppSettings>("get_settings").then(setShortcuts).catch(console.error);

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") invoke("hide_help_window").catch(console.error);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const tools: Section = {
    title: "Các công cụ tích hợp",
    items: [
      { label: "💬 Gemini", detail: "Trò chuyện với Gemini, giữ nguyên lịch sử như trên web." },
      { label: "📓 Sổ ghi chú", detail: "NotebookLM — tổng hợp, hỏi đáp trên tài liệu của bạn." },
      { label: "📄 Google Docs", detail: "Soạn thảo văn bản trực tiếp trong ứng dụng." },
      { label: "🧪 AI Studio", detail: "Công cụ nâng cao cho việc thử nghiệm prompt, model." },
    ],
  };

  const quickChat: Section = {
    title: "Quick Chat — hỏi nhanh không cần rời màn hình đang làm",
    items: [
      { label: "✨ Hội thoại nhiều lượt", detail: "Quick Chat nhớ ngữ cảnh cho đến khi bấm 🔄 tạo cuộc trò chuyện mới." },
      { label: "📷 Chụp màn hình", detail: "Chụp 1 vùng màn hình để hỏi Gemini về nội dung trong ảnh." },
      { label: "📎 Kéo thả file", detail: "Kéo ảnh hoặc PDF vào cửa sổ Quick Chat để đính kèm câu hỏi." },
      { label: "🧪 Mở trong AI Studio", detail: "Sao chép hội thoại và chuyển sang tab AI Studio để làm việc sâu hơn." },
      { label: "</> Xem code", detail: "Xem đoạn lệnh cURL tương ứng với câu hỏi hiện tại, tiện cho việc tích hợp/kiểm tra." },
    ],
  };

  const tips: Section = {
    title: "Mẹo sử dụng",
    items: [
      { label: "Sao chép nhanh", detail: `Copy một đoạn văn bản bất kỳ rồi nhấn ${shortcuts?.clipboard_shortcut ?? "..."} — Quick Chat sẽ mở sẵn với gợi ý Tóm tắt / Dịch / Giải thích.` },
      { label: "Thu gọn sidebar", detail: "Đưa chuột ra khỏi sidebar bên trái để tự động thu gọn, nhường không gian làm việc." },
      { label: "Thu nhỏ xuống khay hệ thống", detail: "Đóng cửa sổ chính bằng nút X sẽ thu ứng dụng vào khay hệ thống (system tray), không thoát hẳn." },
      { label: "Zoom nội dung", detail: "Dùng Ctrl + / Ctrl - hoặc Ctrl + cuộn chuột để phóng to/thu nhỏ nội dung, giống trình duyệt." },
    ],
  };

  const SectionBlock = ({ section }: { section: Section }) => (
    <section>
      <h2 className="text-xs font-bold uppercase text-gray-400 mb-2">{section.title}</h2>
      <div className="flex flex-col gap-2">
        {section.items.map((item) => (
          <div key={item.label} className="bg-gray-50 rounded-xl px-4 py-3">
            <div className="text-sm font-medium text-gray-800">{item.label}</div>
            <div className="text-xs text-gray-500 mt-0.5 leading-relaxed">{item.detail}</div>
          </div>
        ))}
      </div>
    </section>
  );

  return (
    <div className="w-screen h-screen bg-white flex flex-col overflow-hidden">
      <div className="px-5 py-4 border-b border-gray-100 flex items-center gap-2.5">
        <img src="/logo-small.png" alt="THADS Đông Hà Nội" className="w-7 h-7 rounded-full object-contain shrink-0" />
        <h1 className="text-justice-blue font-bold text-lg">Trợ giúp</h1>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-6">
        <section>
          <h2 className="text-xs font-bold uppercase text-gray-400 mb-2">Phím tắt</h2>
          <div className="flex flex-col gap-2">
            <div className="bg-gray-50 rounded-xl px-4 py-3 flex items-center justify-between">
              <span className="text-sm text-gray-800">Mở/đóng Quick Chat</span>
              <span className="text-xs font-mono px-2.5 py-1 rounded-lg bg-white border border-gray-200 text-gray-600">
                {shortcuts?.spotlight_shortcut ?? "..."}
              </span>
            </div>
            <div className="bg-gray-50 rounded-xl px-4 py-3 flex items-center justify-between">
              <span className="text-sm text-gray-800">Hỏi về nội dung đã copy</span>
              <span className="text-xs font-mono px-2.5 py-1 rounded-lg bg-white border border-gray-200 text-gray-600">
                {shortcuts?.clipboard_shortcut ?? "..."}
              </span>
            </div>
            <div className="text-xs text-gray-400 px-1">Có thể đổi tại Cài đặt ⚙️</div>
          </div>
        </section>

        <SectionBlock section={tools} />
        <SectionBlock section={quickChat} />
        <SectionBlock section={tips} />

        <section>
          <h2 className="text-xs font-bold uppercase text-gray-400 mb-2">Liên hệ hỗ trợ</h2>
          <div className="bg-gray-50 rounded-xl px-4 py-3 text-sm text-gray-600 leading-relaxed">
            Phát triển bởi Thang.TV — <span className="text-justice-blue">trieuvietthang@gmail.com</span>
            <br />
            Văn phòng Thi hành án dân sự Đông Hà Nội
          </div>
        </section>
      </div>

      <div className="px-5 py-3 border-t border-gray-100 flex justify-end">
        <button
          type="button"
          onClick={() => invoke("hide_help_window").catch(console.error)}
          className="px-4 py-2 bg-justice-blue text-white rounded-xl text-sm font-bold shadow-md hover:bg-blue-800 transition-colors cursor-pointer"
        >
          Đóng
        </button>
      </div>
    </div>
  );
}
