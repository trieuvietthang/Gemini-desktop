import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";

interface UploadedImage {
  mimeType: string;
  data: string; // base64, no data-url prefix
  name: string;
}

// Mirrors src-tauri/src/image_studio.rs::HistoryEntry (plain snake_case —
// Tauri only camelCases top-level command *argument* names, not struct fields).
interface HistoryEntry {
  id: string;
  mime_type: string;
  data: string;
  extra_instructions: string;
  resolution: string;
  aspect_ratio: string;
}

type Resolution = "1K" | "2K" | "4K";
type Format = "PNG" | "JPG";

const RESOLUTIONS: Resolution[] = ["1K", "2K", "4K"];
const FORMATS: Format[] = ["PNG", "JPG"];
const ASPECT_RATIOS = ["auto", "1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];

function fileToUploadedImage(file: File): Promise<UploadedImage> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const data = result.split(",")[1] ?? "";
      resolve({ mimeType: file.type || "image/png", data, name: file.name });
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

// JPEG has no alpha channel, so a white backdrop is painted first —
// otherwise transparent areas of a PNG would turn black on conversion.
function convertToJpeg(dataUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        reject(new Error("Canvas not supported"));
        return;
      }
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);
      resolve(canvas.toDataURL("image/jpeg", 0.92));
    };
    img.onerror = reject;
    img.src = dataUrl;
  });
}

function UploadZone({
  label,
  hint,
  image,
  onPick,
  onClear,
}: {
  label: string;
  hint: string;
  image: UploadedImage | null;
  onPick: (file: File) => void;
  onClear: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onPick(file);
          e.target.value = "";
        }}
      />
      {image ? (
        <div className="relative rounded-xl border border-gray-200 overflow-hidden group">
          <img
            src={`data:${image.mimeType};base64,${image.data}`}
            alt={label}
            className="w-full h-28 object-cover"
          />
          <button
            type="button"
            onClick={onClear}
            title="Xoá ảnh"
            className="absolute top-1.5 right-1.5 w-6 h-6 rounded-full bg-black/60 text-white text-xs flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
          >
            ✕
          </button>
          <div className="absolute bottom-0 inset-x-0 bg-black/50 text-white text-[10px] px-2 py-1 truncate">
            {image.name}
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="w-full h-28 rounded-xl border-2 border-dashed border-gray-200 hover:border-justice-blue hover:bg-justice-blue/5 transition-colors flex flex-col items-center justify-center gap-1 cursor-pointer"
        >
          <span className="w-7 h-7 rounded-full bg-gray-100 text-gray-400 flex items-center justify-center text-base">+</span>
          <span className="text-xs font-medium text-gray-600">{label}</span>
          <span className="text-[10px] text-gray-400">{hint}</span>
        </button>
      )}
    </div>
  );
}

// Portrait uploader that accepts several photos of the same person (different
// angles/expressions) to sharpen face fidelity.
function MultiUploadZone({
  images,
  onAddFiles,
  onRemove,
}: {
  images: UploadedImage[];
  onAddFiles: (files: FileList) => void;
  onRemove: (index: number) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div className="grid grid-cols-3 gap-2">
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files && e.target.files.length > 0) onAddFiles(e.target.files);
          e.target.value = "";
        }}
      />
      {images.map((img, i) => (
        <div key={i} className="relative rounded-lg border border-gray-200 overflow-hidden group aspect-square">
          <img src={`data:${img.mimeType};base64,${img.data}`} alt="" className="w-full h-full object-cover" />
          <button
            type="button"
            onClick={() => onRemove(i)}
            title="Xoá ảnh"
            className="absolute top-0.5 right-0.5 w-5 h-5 rounded-full bg-black/60 text-white text-[10px] flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
          >
            ✕
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        className="aspect-square rounded-lg border-2 border-dashed border-gray-200 hover:border-justice-blue hover:bg-justice-blue/5 transition-colors flex flex-col items-center justify-center gap-0.5 cursor-pointer"
      >
        <span className="w-6 h-6 rounded-full bg-gray-100 text-gray-400 flex items-center justify-center text-base">+</span>
        <span className="text-[10px] text-gray-500">Thêm ảnh</span>
      </button>
    </div>
  );
}

export default function ImageStudio() {
  const [apiKeyConfigured, setApiKeyConfigured] = useState<boolean | null>(null);
  const [background, setBackground] = useState<UploadedImage | null>(null);
  const [persons, setPersons] = useState<UploadedImage[]>([]);
  const [outfit, setOutfit] = useState<UploadedImage | null>(null);
  const [extraInstructions, setExtraInstructions] = useState("");
  const [resolution, setResolution] = useState<Resolution>("2K");
  const [format, setFormat] = useState<Format>("PNG");
  const [aspectRatio, setAspectRatio] = useState("auto");
  const [variantCount, setVariantCount] = useState(1);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const [result, setResult] = useState<HistoryEntry | null>(null);
  // The set of images produced by the most recent generation — shown as a
  // selectable strip when more than one variant was requested.
  const [batch, setBatch] = useState<HistoryEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);

  useEffect(() => {
    invoke<boolean>("has_gemini_api_key").then(setApiKeyConfigured).catch(() => setApiKeyConfigured(false));
    invoke<HistoryEntry[]>("list_image_history").then(setHistory).catch((err) => console.error("Failed to load history:", err));
  }, []);

  // Native OS drag-drop (Tauri intercepts HTML5 dataTransfer in this window,
  // same reasoning as Spotlight.tsx) — the first dropped file fills the
  // background if empty, otherwise dropped files are added as portrait photos.
  useEffect(() => {
    const webview = getCurrentWebview();
    const unlisten = webview.onDragDropEvent((event) => {
      if (event.payload.type === "over") {
        setIsDragOver(true);
      } else if (event.payload.type === "drop") {
        setIsDragOver(false);
        for (const path of event.payload.paths) {
          invoke<{ mime_type: string; data: string }>("read_file_as_attachment", { path })
            .then((att) => {
              const name = path.split(/[\\/]/).pop() || path;
              const img: UploadedImage = { mimeType: att.mime_type, data: att.data, name };
              if (!background) setBackground(img);
              else setPersons((prev) => [...prev, img]);
            })
            .catch((err) => console.error("Failed to read dropped file:", err));
        }
      } else {
        setIsDragOver(false);
      }
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, [background]);

  const canGenerate = !!background && persons.length > 0 && !isGenerating && apiKeyConfigured === true;

  const handleGenerate = async () => {
    if (!background || persons.length === 0 || isGenerating) return;
    setIsGenerating(true);
    setError(null);
    try {
      const entries = await invoke<HistoryEntry[]>("generate_composite_image", {
        background: { mime_type: background.mimeType, data: background.data },
        persons: persons.map((p) => ({ mime_type: p.mimeType, data: p.data })),
        outfit: outfit ? { mime_type: outfit.mimeType, data: outfit.data } : null,
        extraInstructions,
        resolution,
        aspectRatio,
        variantCount,
      });
      setBatch(entries);
      setResult(entries[0] ?? null);
      setHistory((prev) => [...entries, ...prev]);
    } catch (err: any) {
      setError(typeof err === "string" ? err : err?.message ?? "Đã có lỗi xảy ra");
    } finally {
      setIsGenerating(false);
    }
  };

  const handleDownload = async () => {
    if (!result || isSaving) return;
    setIsSaving(true);
    try {
      let dataBase64 = result.data;
      let ext = result.mime_type === "image/webp" ? "webp" : result.mime_type === "image/jpeg" ? "jpg" : "png";
      // JPG conversion is done in-canvas here; the backend just writes bytes.
      if (format === "JPG" && result.mime_type !== "image/jpeg") {
        const converted = await convertToJpeg(`data:${result.mime_type};base64,${result.data}`);
        dataBase64 = converted.split(",")[1] ?? "";
        ext = "jpg";
      }
      const savedPath = await invoke<string | null>("save_image_file", {
        data: dataBase64,
        suggestedName: `anh-ghep-${result.id}.${ext}`,
      });
      if (savedPath) {
        setSavedNotice("Đã lưu ảnh");
        setTimeout(() => setSavedNotice(null), 2000);
      }
    } catch (err) {
      console.error("Failed to save image:", err);
      setError(typeof err === "string" ? err : "Không lưu được ảnh");
    } finally {
      setIsSaving(false);
    }
  };

  const handleDeleteHistory = async (id: string) => {
    try {
      await invoke("delete_image_history_entry", { id });
      setHistory((prev) => prev.filter((h) => h.id !== id));
      setBatch((prev) => prev.filter((h) => h.id !== id));
      if (result?.id === id) setResult(null);
    } catch (err) {
      console.error("Failed to delete history entry:", err);
    }
  };

  const addPortraitFiles = (files: FileList) => {
    Promise.all(Array.from(files).map(fileToUploadedImage))
      .then((imgs) => setPersons((prev) => [...prev, ...imgs]))
      .catch((err) => console.error("Failed to read portrait files:", err));
  };

  if (apiKeyConfigured === false) {
    return (
      <div className="absolute inset-0 flex items-center justify-center bg-gray-50">
        <div className="text-center max-w-sm px-6">
          <p className="text-gray-600 font-medium mb-2">Chưa cấu hình Gemini API key</p>
          <p className="text-sm text-gray-400 mb-4">Cần API key để dùng tính năng tạo ảnh ghép bằng Nano Banana Pro.</p>
          <button
            type="button"
            onClick={() => invoke("toggle_settings_window").catch(console.error)}
            className="px-4 py-2 bg-justice-blue text-white rounded-xl text-sm font-bold shadow-md hover:bg-blue-800 transition-colors cursor-pointer"
          >
            Mở Cài đặt
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={`absolute inset-0 flex bg-gray-50 overflow-hidden ${isDragOver ? "ring-2 ring-inset ring-justice-blue" : ""}`}>
      {/* Left panel: inputs */}
      <div className="w-[360px] shrink-0 border-r border-gray-200 bg-white overflow-y-auto p-4 flex flex-col gap-4">
        <div>
          <h1 className="text-justice-blue font-bold text-base">🎨 Tạo ảnh ghép</h1>
          <p className="text-xs text-gray-400 mt-0.5">Ghép ảnh chân dung vào ảnh nền một cách chân thực bằng Nano Banana Pro</p>
        </div>

        <div>
          <div className="text-xs font-bold uppercase text-gray-400 mb-1.5">Ảnh nền</div>
          <UploadZone
            label="Tải ảnh nền"
            hint="Buổi họp mặt gia đình / công ty / bạn bè"
            image={background}
            onPick={(f) => fileToUploadedImage(f).then(setBackground)}
            onClear={() => setBackground(null)}
          />
        </div>

        <div>
          <div className="text-xs font-bold uppercase text-gray-400 mb-1.5">Ảnh chân dung</div>
          <MultiUploadZone images={persons} onAddFiles={addPortraitFiles} onRemove={(i) => setPersons((prev) => prev.filter((_, idx) => idx !== i))} />
          <div className="text-[11px] text-gray-400 mt-1.5">
            Có thể thêm nhiều ảnh của <span className="font-medium">cùng một người</span> (các góc/biểu cảm khác nhau) để tái tạo khuôn mặt giống hơn.
          </div>
        </div>

        <div>
          <div className="text-xs font-bold uppercase text-gray-400 mb-1.5">Trang phục (tuỳ chọn)</div>
          <UploadZone
            label="Tải ảnh trang phục"
            hint="Không có sẽ dùng trang phục trong ảnh chân dung"
            image={outfit}
            onPick={(f) => fileToUploadedImage(f).then(setOutfit)}
            onClear={() => setOutfit(null)}
          />
        </div>

        <div>
          <div className="text-xs font-bold uppercase text-gray-400 mb-1.5">Hướng dẫn bổ sung (tuỳ chọn)</div>
          <textarea
            value={extraInstructions}
            onChange={(e) => setExtraInstructions(e.target.value)}
            placeholder="Ví dụ: Đặt người được ghép đứng bên phải, phía sau hàng thứ hai, tư thế và ánh mắt tự nhiên."
            rows={3}
            className="w-full text-sm px-3 py-2 rounded-lg bg-gray-50 border border-gray-200 text-gray-800 outline-none resize-none placeholder-gray-400 focus:border-justice-blue"
          />
        </div>

        <div>
          <div className="text-xs font-bold uppercase text-gray-400 mb-1.5">Độ phân giải</div>
          <div className="flex gap-2">
            {RESOLUTIONS.map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setResolution(r)}
                className={`flex-1 py-1.5 rounded-lg text-xs font-bold transition-colors cursor-pointer ${
                  resolution === r ? "bg-justice-blue text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                }`}
              >
                {r}
              </button>
            ))}
          </div>
        </div>

        <div>
          <div className="text-xs font-bold uppercase text-gray-400 mb-1.5">Định dạng tải xuống</div>
          <div className="flex gap-2">
            {FORMATS.map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFormat(f)}
                className={`flex-1 py-1.5 rounded-lg text-xs font-bold transition-colors cursor-pointer ${
                  format === f ? "bg-justice-blue text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                }`}
              >
                {f}
              </button>
            ))}
          </div>
        </div>

        <div>
          <div className="text-xs font-bold uppercase text-gray-400 mb-1">Tỷ lệ khung hình</div>
          <p className="text-[11px] text-gray-400 mb-1.5">Chọn tỷ lệ phù hợp để chừa đủ chỗ cho người được ghép, nhất là ảnh nhóm đông người.</p>
          <div className="flex flex-wrap gap-1.5">
            {ASPECT_RATIOS.map((ratio) => (
              <button
                key={ratio}
                type="button"
                onClick={() => setAspectRatio(ratio)}
                title={ratio}
                className={`px-2 py-1.5 rounded-lg text-[11px] font-medium flex items-center gap-1 transition-colors cursor-pointer ${
                  aspectRatio === ratio ? "bg-justice-blue text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                }`}
              >
                {ratio !== "auto" && (
                  <span
                    style={{ aspectRatio: ratio.replace(":", "/") }}
                    className={`inline-block h-3 border rounded-[2px] ${aspectRatio === ratio ? "border-white" : "border-gray-400"}`}
                  />
                )}
                {ratio}
              </button>
            ))}
          </div>
        </div>

        <div>
          <div className="text-xs font-bold uppercase text-gray-400 mb-1.5">Số ảnh tạo ra</div>
          <div className="flex gap-2">
            {[1, 2, 3, 4].map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => setVariantCount(n)}
                className={`flex-1 py-1.5 rounded-lg text-xs font-bold transition-colors cursor-pointer ${
                  variantCount === n ? "bg-justice-blue text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                }`}
              >
                {n}
              </button>
            ))}
          </div>
          {variantCount > 1 && (
            <div className="text-[11px] text-gray-400 mt-1">Tạo {variantCount} phương án để chọn — tốn phí API gấp {variantCount} lần.</div>
          )}
        </div>

        <button
          type="button"
          onClick={handleGenerate}
          disabled={!canGenerate}
          className="mt-1 w-full py-2.5 rounded-xl bg-authority-red text-white font-bold text-sm shadow-md hover:bg-red-700 transition-colors disabled:opacity-40 disabled:cursor-default cursor-pointer"
        >
          {isGenerating ? "Đang tạo ảnh..." : variantCount > 1 ? `✨ Tạo ${variantCount} ảnh` : "✨ Tạo ảnh"}
        </button>

        {history.length > 0 && (
          <div>
            <div className="text-xs font-bold uppercase text-gray-400 mb-1.5">Lịch sử</div>
            <div className="grid grid-cols-4 gap-1.5">
              {history.map((h) => (
                <div key={h.id} className="relative group">
                  <button
                    type="button"
                    onClick={() => setResult(h)}
                    className="w-full aspect-square rounded-lg overflow-hidden border border-gray-200 cursor-pointer"
                  >
                    <img src={`data:${h.mime_type};base64,${h.data}`} alt="" className="w-full h-full object-cover" />
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDeleteHistory(h.id)}
                    title="Xoá"
                    className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-black/70 text-white text-[9px] flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Right panel: result */}
      <div className="flex-1 flex flex-col items-center justify-center p-6 relative">
        {isGenerating ? (
          <div className="text-center">
            <div className="text-3xl mb-2 animate-pulse">✨</div>
            <p className="text-sm text-gray-500">
              {variantCount > 1
                ? `Đang tạo ${variantCount} ảnh, có thể mất vài phút...`
                : "Đang ghép ảnh, có thể mất khoảng một phút..."}
            </p>
          </div>
        ) : error ? (
          <div className="text-center max-w-md px-6">
            <p className="text-authority-red font-medium mb-1">Không tạo được ảnh</p>
            <p className="text-sm text-gray-500">{error}</p>
          </div>
        ) : result ? (
          <div className="max-w-full max-h-full flex flex-col items-center gap-3">
            <img
              src={`data:${result.mime_type};base64,${result.data}`}
              alt="Kết quả"
              className="max-w-full max-h-[calc(100vh-200px)] rounded-xl shadow-lg object-contain"
            />
            {batch.length > 1 && (
              <div className="flex gap-2 flex-wrap justify-center">
                {batch.map((b) => (
                  <button
                    key={b.id}
                    type="button"
                    onClick={() => setResult(b)}
                    className={`w-14 h-14 rounded-lg overflow-hidden border-2 transition-colors cursor-pointer ${
                      result.id === b.id ? "border-justice-blue" : "border-transparent hover:border-gray-300"
                    }`}
                  >
                    <img src={`data:${b.mime_type};base64,${b.data}`} alt="" className="w-full h-full object-cover" />
                  </button>
                ))}
              </div>
            )}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={handleDownload}
                disabled={isSaving}
                className="px-4 py-2 bg-justice-blue text-white rounded-xl text-sm font-bold shadow-md hover:bg-blue-800 transition-colors disabled:opacity-50 cursor-pointer"
              >
                {savedNotice ? "✓ Đã lưu" : isSaving ? "Đang lưu..." : "⬇ Tải xuống"}
              </button>
              <button
                type="button"
                onClick={handleGenerate}
                disabled={!canGenerate}
                className="px-4 py-2 bg-gray-100 text-gray-700 rounded-xl text-sm font-bold hover:bg-gray-200 transition-colors disabled:opacity-40 disabled:cursor-default cursor-pointer"
              >
                🔄 Tạo lại
              </button>
            </div>
          </div>
        ) : (
          <div className="text-center max-w-sm px-6">
            <p className="text-gray-400 font-medium">Kết quả sẽ hiện ở đây</p>
            <p className="text-xs text-gray-300 mt-1">Tải ảnh nền và ảnh chân dung, sau đó bấm "Tạo ảnh"</p>
          </div>
        )}
      </div>
    </div>
  );
}
