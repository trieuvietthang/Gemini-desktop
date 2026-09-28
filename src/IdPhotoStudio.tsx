import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { listen } from "@tauri-apps/api/event";
import {
  fileToUploadedImage,
  convertToJpeg,
  composeMixedPrintSheet,
  autoCropToSize,
  replaceFlatBackground,
  mmToPx,
  analyzePortraitQuality,
  sampleBackgroundColor,
  colorDistanceFromHex,
  estimateSubjectFocus,
  RESOLUTIONS,
  type UploadedImage,
  type Resolution,
  type SheetPlacementSummary,
} from "./lib/imageUtils";
import { UploadZone, MultiUploadZone } from "./components/UploadZone";
import CropGuide from "./components/CropGuide";

// Mirrors src-tauri/src/id_photo.rs::IdPhotoHistoryEntry (plain snake_case —
// Tauri only camelCases top-level command *argument* names, not struct fields).
interface IdPhotoHistoryEntry {
  id: string;
  mime_type: string;
  data: string;
  label: string;
}

interface PhotoSize {
  id: string;
  label: string;
  widthMm?: number;
  heightMm?: number;
  pxWidth?: number;
  pxHeight?: number;
  // Nearest ratio the Gemini image API accepts — only steers framing at
  // generation time; the crop step below guarantees the exact final size.
  aspectRatio: string;
}

interface BackgroundOption {
  id: string;
  label: string;
  swatch?: string;
  promptText: string;
}

interface PhotoType {
  id: string;
  groupId: string;
  label: string;
  sizes: PhotoSize[];
  backgrounds: BackgroundOption[];
  allowCustomBackground: boolean;
  framingInstruction: string;
  defaultStyleInstruction: string;
  guide: { topPct: number; bottomPct: number } | null;
  // Whether "Tải tờ in" applies — only meaningful for physical-print sizes
  // (mm-based), not the pixel-only LinkedIn sizes.
  printable: boolean;
}

interface PhotoGroup {
  id: string;
  label: string;
  icon: string;
}

type Format = "PNG" | "JPG";
const FORMATS: Format[] = ["PNG", "JPG"];
// 600 DPI is well beyond what physical printing needs (300 is standard) but
// gives enough absolute pixels that the photo still looks sharp when viewed
// zoomed-in on a screen, instead of just "correct for its physical size".
const PRINT_DPI = 600;
// RGB distance above which the generated background is flagged as not
// matching the requested flat color closely enough — heuristic, not a
// calibrated colorimetric tolerance.
const BACKGROUND_MATCH_THRESHOLD = 55;

const PHOTO_GROUPS: PhotoGroup[] = [
  { id: "vn_id", label: "Ảnh thẻ Việt Nam", icon: "🆔" },
  { id: "passport_visa", label: "Hộ chiếu & Visa", icon: "🛂" },
  { id: "cv", label: "Hồ sơ / CV", icon: "💼" },
  { id: "linkedin", label: "LinkedIn / MXH", icon: "💻" },
];

// Reused verbatim by both LinkedIn photo types below.
const LINKEDIN_BACKGROUNDS: BackgroundOption[] = [
  { id: "studio_gray", label: "Studio xám mờ", promptText: "Phông nền studio màu xám trung tính, mờ nhẹ (bokeh), không hoạ tiết, ánh sáng mềm chuyên nghiệp." },
  { id: "office_blur", label: "Văn phòng mờ hậu cảnh", promptText: "Hậu cảnh văn phòng hiện đại làm mờ (bokeh) nhẹ nhàng, ánh sáng tự nhiên, không gây xao nhãng khỏi chủ thể." },
  { id: "gradient_blue", label: "Gradient xanh chuyên nghiệp", promptText: "Phông nền gradient màu xanh dương chuyên nghiệp, chuyển sắc mượt, không hoạ tiết." },
  { id: "custom", label: "Tuỳ chỉnh mô tả...", promptText: "" },
];

const PHOTO_TYPES: PhotoType[] = [
  {
    id: "vn_the",
    groupId: "vn_id",
    label: "Ảnh thẻ",
    sizes: [
      { id: "3x4", label: "3 x 4 cm", widthMm: 30, heightMm: 40, aspectRatio: "3:4" },
      { id: "4x6", label: "4 x 6 cm", widthMm: 40, heightMm: 60, aspectRatio: "2:3" },
      { id: "2x3", label: "2 x 3 cm", widthMm: 20, heightMm: 30, aspectRatio: "2:3" },
    ],
    backgrounds: [
      { id: "white", label: "Trắng", swatch: "#FFFFFF", promptText: "Phông nền màu trắng trơn, đồng nhất, không bóng đổ, không hoạ tiết — đúng chuẩn ảnh giấy tờ." },
      { id: "blue", label: "Xanh dương", swatch: "#3B6FA0", promptText: "Phông nền màu xanh dương trơn, đồng nhất, không bóng đổ, không hoạ tiết." },
      { id: "gray", label: "Xám", swatch: "#BEBEBE", promptText: "Phông nền màu xám trơn, đồng nhất, không bóng đổ, không hoạ tiết." },
    ],
    allowCustomBackground: false,
    framingInstruction: "Khung vai-đầu (đầu và vai trên), đầu chiếm khoảng 70-80% chiều cao khung ảnh, mắt nhìn thẳng vào ống kính, đầu để trần, cân đối chính giữa khung hình.",
    defaultStyleInstruction: "Nghiêm túc, biểu cảm trung tính, không cười, không đội mũ/nón, không đeo kính.",
    guide: { topPct: 12, bottomPct: 88 },
    printable: true,
  },
  {
    id: "ho_chieu_vn",
    groupId: "passport_visa",
    label: "Hộ chiếu Việt Nam",
    sizes: [{ id: "4x6", label: "4 x 6 cm", widthMm: 40, heightMm: 60, aspectRatio: "2:3" }],
    backgrounds: [
      { id: "white", label: "Trắng (bắt buộc)", swatch: "#FFFFFF", promptText: "Phông nền màu trắng trơn tuyệt đối, đồng nhất, không bóng đổ, không hoạ tiết — đúng chuẩn ảnh hộ chiếu." },
    ],
    allowCustomBackground: false,
    framingInstruction: "Khung vai-đầu chuẩn hộ chiếu, đầu chiếm khoảng 70-80% chiều cao khung ảnh, mắt nhìn thẳng vào ống kính, đầu để trần, không đeo kính màu, không đội mũ nón.",
    defaultStyleInstruction: "Chuẩn hành chính, nghiêm túc, không cười lộ răng, miệng khép tự nhiên.",
    guide: { topPct: 12, bottomPct: 88 },
    printable: true,
  },
  {
    id: "visa_us",
    groupId: "passport_visa",
    label: "Visa Mỹ (DS-160)",
    sizes: [{ id: "2x2in", label: "2 x 2 inch (51 x 51 mm)", widthMm: 51, heightMm: 51, aspectRatio: "1:1" }],
    backgrounds: [
      { id: "white", label: "Trắng (bắt buộc)", swatch: "#FFFFFF", promptText: "Phông nền màu trắng trơn tuyệt đối, đồng nhất, không bóng đổ." },
    ],
    allowCustomBackground: false,
    framingInstruction: "Đầu chiếm khoảng 50-69% chiều cao khung ảnh tính từ cằm đến đỉnh đầu, mắt nhìn thẳng vào ống kính, nền trắng đồng nhất không bóng đổ, không đeo kính.",
    defaultStyleInstruction: "Chuẩn hành chính Mỹ, nghiêm túc, biểu cảm tự nhiên, mắt mở to nhìn thẳng.",
    guide: { topPct: 20, bottomPct: 82 },
    printable: true,
  },
  {
    id: "visa_schengen",
    groupId: "passport_visa",
    label: "Visa Schengen",
    sizes: [{ id: "35x45", label: "35 x 45 mm", widthMm: 35, heightMm: 45, aspectRatio: "4:5" }],
    backgrounds: [
      { id: "white", label: "Trắng", swatch: "#FFFFFF", promptText: "Phông nền màu trắng trơn, đồng nhất, không bóng đổ." },
      { id: "gray", label: "Xám nhạt", swatch: "#E5E5E5", promptText: "Phông nền màu xám nhạt trơn, đồng nhất, không bóng đổ." },
    ],
    allowCustomBackground: false,
    framingInstruction: "Đầu chiếm khoảng 70-80% chiều cao khung ảnh, mắt nhìn thẳng vào ống kính, nền sáng màu đồng nhất, không đeo kính.",
    defaultStyleInstruction: "Chuẩn hành chính châu Âu, nghiêm túc, biểu cảm trung tính.",
    guide: { topPct: 12, bottomPct: 88 },
    printable: true,
  },
  {
    id: "cv_photo",
    groupId: "cv",
    label: "Ảnh hồ sơ / CV",
    sizes: [
      { id: "3x4", label: "3 x 4 cm", widthMm: 30, heightMm: 40, aspectRatio: "3:4" },
      { id: "4x6", label: "4 x 6 cm", widthMm: 40, heightMm: 60, aspectRatio: "2:3" },
      { id: "2x3", label: "2 x 3 cm", widthMm: 20, heightMm: 30, aspectRatio: "2:3" },
    ],
    backgrounds: [
      { id: "white", label: "Trắng", swatch: "#FFFFFF", promptText: "Phông nền màu trắng trơn, đồng nhất, không bóng đổ." },
      { id: "gray", label: "Xám nhạt", swatch: "#E8E8E8", promptText: "Phông nền màu xám nhạt trơn, đồng nhất, không bóng đổ." },
      { id: "beige", label: "Be nhạt", swatch: "#EFE6D8", promptText: "Phông nền màu be nhạt trơn, đồng nhất, không bóng đổ." },
    ],
    allowCustomBackground: false,
    framingInstruction: "Khung vai-đầu, đầu chiếm khoảng 65-75% chiều cao khung ảnh, mắt nhìn thẳng vào ống kính, cân đối chính giữa khung hình.",
    defaultStyleInstruction: "Lịch sự, chuyên nghiệp, có thể mỉm cười nhẹ tự nhiên, trang phục công sở gọn gàng.",
    guide: { topPct: 15, bottomPct: 85 },
    printable: true,
  },
  {
    id: "linkedin_square",
    groupId: "linkedin",
    label: "Chân dung vuông",
    sizes: [{ id: "1x1", label: "Vuông 1:1 (800 x 800 px)", pxWidth: 800, pxHeight: 800, aspectRatio: "1:1" }],
    backgrounds: LINKEDIN_BACKGROUNDS,
    allowCustomBackground: true,
    framingInstruction: "Khung bán thân (đầu, vai và một phần ngực trên), chủ thể chính giữa khung hình, còn khoảng trống hợp lý phía trên đầu.",
    defaultStyleInstruction: "Chuyên nghiệp, thân thiện, ánh sáng studio mềm, có thể mỉm cười tự nhiên, trang phục công sở/business casual.",
    guide: null,
    printable: false,
  },
  {
    id: "linkedin_portrait",
    groupId: "linkedin",
    label: "Chân dung dọc",
    sizes: [{ id: "4x5", label: "Dọc 4:5 (800 x 1000 px)", pxWidth: 800, pxHeight: 1000, aspectRatio: "4:5" }],
    backgrounds: LINKEDIN_BACKGROUNDS,
    allowCustomBackground: true,
    framingInstruction: "Khung bán thân dọc (đầu đến ngang ngực trên), còn khoảng trống hợp lý phía trên đầu và hai bên.",
    defaultStyleInstruction: "Chuyên nghiệp, thân thiện, ánh sáng studio mềm, có thể mỉm cười tự nhiên, trang phục công sở/business casual.",
    guide: null,
    printable: false,
  },
];

const HAIR_OPTIONS = [
  { id: "default", label: "Giữ nguyên (mặc định)", instruction: "" },
  { id: "neat", label: "Gọn gàng công sở", instruction: "Chải gọn gàng, chuyên nghiệp kiểu công sở, không để tóc loà xoà trước mặt." },
  { id: "tied", label: "Buộc tóc", instruction: "Buộc tóc gọn gàng ra sau." },
  { id: "natural", label: "Xoã tự nhiên", instruction: "Để tóc xoã tự nhiên, gọn gàng, không rối." },
  { id: "custom", label: "Tuỳ chỉnh...", instruction: "" },
];

const SHEET_SIZES = [
  { id: "10x15", label: "10 x 15 cm", widthMm: 100, heightMm: 150 },
  { id: "13x18", label: "13 x 18 cm", widthMm: 130, heightMm: 180 },
  { id: "a4", label: "A4 (21 x 29.7 cm)", widthMm: 210, heightMm: 297 },
];

export default function IdPhotoStudio() {
  const [apiKeyConfigured, setApiKeyConfigured] = useState<boolean | null>(null);

  const [groupId, setGroupId] = useState(PHOTO_GROUPS[0].id);
  const typesInGroup = PHOTO_TYPES.filter((t) => t.groupId === groupId);
  const [typeId, setTypeId] = useState(typesInGroup[0].id);
  const selectedType = PHOTO_TYPES.find((t) => t.id === typeId) ?? typesInGroup[0];

  const [sizeId, setSizeId] = useState(selectedType.sizes[0].id);
  const selectedSize = selectedType.sizes.find((s) => s.id === sizeId) ?? selectedType.sizes[0];

  const [backgroundId, setBackgroundId] = useState(selectedType.backgrounds[0].id);
  const selectedBackground = selectedType.backgrounds.find((b) => b.id === backgroundId) ?? selectedType.backgrounds[0];
  const [customBackgroundText, setCustomBackgroundText] = useState("");

  const [styleDraft, setStyleDraft] = useState(selectedType.defaultStyleInstruction);

  const [persons, setPersons] = useState<UploadedImage[]>([]);
  const [outfit, setOutfit] = useState<UploadedImage | null>(null);
  const [outfitDescription, setOutfitDescription] = useState("");

  const [hairId, setHairId] = useState("default");
  const [customHairText, setCustomHairText] = useState("");

  const [extraInstructions, setExtraInstructions] = useState("");
  const [resolution, setResolution] = useState<Resolution>("4K");
  const [variantCount, setVariantCount] = useState(1);

  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [batch, setBatch] = useState<IdPhotoHistoryEntry[]>([]);
  const [rawResult, setRawResult] = useState<IdPhotoHistoryEntry | null>(null);
  const [finalPhoto, setFinalPhoto] = useState<{ dataUrl: string; widthPx: number; heightPx: number } | null>(null);

  const [format, setFormat] = useState<Format>("PNG");
  const [isSaving, setIsSaving] = useState(false);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);

  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetSizeId, setSheetSizeId] = useState(SHEET_SIZES[0].id);
  // How many copies of each size (keyed by PhotoSize.id) to place on the
  // sheet — sizes the user hasn't manually cropped are auto-cropped from
  // rawResult on demand (see handleComposeMixedSheet).
  const [sheetCounts, setSheetCounts] = useState<Record<string, number>>({});
  const [sheetCutLines, setSheetCutLines] = useState(true);
  const [sheetPreview, setSheetPreview] = useState<string | null>(null);
  const [sheetSummary, setSheetSummary] = useState<{
    placed: SheetPlacementSummary[];
    unplaced: SheetPlacementSummary[];
  } | null>(null);
  const [isComposingSheet, setIsComposingSheet] = useState(false);

  const [history, setHistory] = useState<IdPhotoHistoryEntry[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const [genProgress, setGenProgress] = useState<{ done: number; total: number } | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  // Chroma-key-based initial crop guess (see estimateSubjectFocus) — null
  // when the background isn't a known flat color, falling back to plain
  // geometric centering in CropGuide.
  const [focusHint, setFocusHint] = useState<{ xPct: number; yPct: number } | null>(null);
  // Advisory-only: set after cropping when the final background color
  // doesn't closely match the requested swatch (see handleCropConfirm).
  const [bgWarning, setBgWarning] = useState<string | null>(null);
  const [isSwappingBackground, setIsSwappingBackground] = useState(false);

  useEffect(() => {
    invoke<boolean>("has_gemini_api_key").then(setApiKeyConfigured).catch(() => setApiKeyConfigured(false));
    invoke<IdPhotoHistoryEntry[]>("list_id_photo_history").then(setHistory).catch((err) => console.error("Failed to load history:", err));
  }, []);

  // Switching group resets to that group's first type if the current one no
  // longer belongs to it.
  useEffect(() => {
    if (!PHOTO_TYPES.some((t) => t.id === typeId && t.groupId === groupId)) {
      const firstType = PHOTO_TYPES.find((t) => t.groupId === groupId);
      if (firstType) setTypeId(firstType.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupId]);

  // Switching type resets size/background/style to that type's defaults
  // instead of leaving a stale selection from a different category. Any
  // existing result is cleared too — background/style differ per type, so
  // the raw image is no longer relevant and a fresh generation is required
  // (switching just the *size* within the same type, below, is the case
  // that reuses the raw image instead of clearing it).
  useEffect(() => {
    setSizeId(selectedType.sizes[0].id);
    setBackgroundId(selectedType.backgrounds[0].id);
    setCustomBackgroundText("");
    setStyleDraft(selectedType.defaultStyleInstruction);
    setRawResult(null);
    setBatch([]);
    setFinalPhoto(null);
    setSheetPreview(null);
    setSheetSummary(null);
    setSheetCounts({});
    setBgWarning(null);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typeId]);

  // Chroma-key heuristic for a better initial crop position than dead
  // center (see estimateSubjectFocus) — recomputed whenever a new raw image
  // is generated or a different history/variant entry is picked.
  useEffect(() => {
    if (!rawResult) {
      setFocusHint(null);
      return;
    }
    let cancelled = false;
    estimateSubjectFocus(`data:${rawResult.mime_type};base64,${rawResult.data}`, selectedBackground.swatch).then(
      (hint) => {
        if (!cancelled) setFocusHint(hint);
      },
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawResult]);

  // Native OS drag-drop (same pattern as ImageStudio.tsx) — dropped files are
  // always added as portrait photos here (there's no background photo slot).
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
              setPersons((prev) => [...prev, { mimeType: att.mime_type, data: att.data, name }]);
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
  }, []);

  const canGenerate = persons.length > 0 && !isGenerating && apiKeyConfigured === true;

  const addPortraitFiles = (files: FileList) => {
    Promise.all(
      Array.from(files).map(async (file) => {
        const img = await fileToUploadedImage(file);
        const warnings = await analyzePortraitQuality(`data:${img.mimeType};base64,${img.data}`);
        return { ...img, warnings };
      }),
    )
      .then((imgs) => setPersons((prev) => [...prev, ...imgs]))
      .catch((err) => console.error("Failed to read portrait files:", err));
  };

  const outputPx = (): { w: number; h: number } => {
    if (selectedSize.pxWidth && selectedSize.pxHeight) {
      return { w: selectedSize.pxWidth, h: selectedSize.pxHeight };
    }
    return {
      w: mmToPx(selectedSize.widthMm ?? 40, PRINT_DPI),
      h: mmToPx(selectedSize.heightMm ?? 60, PRINT_DPI),
    };
  };

  const handleGenerate = async () => {
    if (!canGenerate) return;
    setIsGenerating(true);
    setError(null);
    setFinalPhoto(null);
    setSheetPreview(null);
    setSheetSummary(null);
    setSheetCounts({});
    setBgWarning(null);
    setGenProgress(null);
    const unlisten = await listen<{ done: number; total: number }>("id_photo_progress", (e) =>
      setGenProgress(e.payload),
    );
    try {
      const backgroundInstruction =
        selectedBackground.id === "custom"
          ? customBackgroundText.trim() || "Phông nền studio trung tính, mờ nhẹ, chuyên nghiệp."
          : selectedBackground.promptText;
      const hair = HAIR_OPTIONS.find((h) => h.id === hairId) ?? HAIR_OPTIONS[0];
      const hairstyleInstruction = hair.id === "custom" ? customHairText.trim() : hair.instruction;

      const entries = await invoke<IdPhotoHistoryEntry[]>("generate_id_photo", {
        persons: persons.map((p) => ({ mime_type: p.mimeType, data: p.data })),
        outfit: outfit ? { mime_type: outfit.mimeType, data: outfit.data } : null,
        outfitDescription,
        hairstyleInstruction,
        framingInstruction: selectedType.framingInstruction,
        backgroundInstruction,
        styleInstruction: styleDraft,
        extraInstructions,
        aspectRatio: selectedSize.aspectRatio,
        resolution,
        variantCount,
        label: `${selectedType.label} - ${selectedSize.label}`,
      });
      setBatch(entries);
      setRawResult(entries[0] ?? null);
      setHistory((prev) => [...entries, ...prev]);
    } catch (err: any) {
      setError(typeof err === "string" ? err : err?.message ?? "Đã có lỗi xảy ra");
    } finally {
      unlisten();
      setGenProgress(null);
      setIsGenerating(false);
    }
  };

  const pickVariant = (entry: IdPhotoHistoryEntry) => {
    setRawResult(entry);
    setFinalPhoto(null);
    setSheetPreview(null);
    setSheetSummary(null);
    setBgWarning(null);
    setError(null);
  };

  // Switching background: if both the old and new backgrounds are known
  // flat colors, swap the pixels directly on the raw image (no API call) —
  // otherwise (a "styled" background is involved on either side) there's no
  // fixed color to key against, so the stale result is cleared and a fresh
  // generation is required. Clearing when swap isn't possible also fixes a
  // latent bug: previously, picking a different background while a result
  // already existed changed nothing about the displayed image.
  const handleBackgroundSelect = (newId: string) => {
    const newBg = selectedType.backgrounds.find((b) => b.id === newId);
    if (!newBg) return;
    const oldBg = selectedBackground;
    setBackgroundId(newId);
    setCustomBackgroundText("");
    if (!rawResult) return;

    if (oldBg.swatch && newBg.swatch) {
      setIsSwappingBackground(true);
      replaceFlatBackground(`data:${rawResult.mime_type};base64,${rawResult.data}`, oldBg.swatch, newBg.swatch)
        .then((swappedDataUrl) => {
          setRawResult({ ...rawResult, mime_type: "image/png", data: swappedDataUrl.split(",")[1] ?? "" });
          setFinalPhoto(null);
          setSheetPreview(null);
          setSheetSummary(null);
          setBgWarning(null);
        })
        .catch((err) => console.error("Failed to swap background:", err))
        .finally(() => setIsSwappingBackground(false));
    } else {
      setRawResult(null);
      setBatch([]);
      setFinalPhoto(null);
      setSheetPreview(null);
      setSheetSummary(null);
      setBgWarning(null);
    }
  };

  const handleCropConfirm = (dataUrl: string) => {
    const { w, h } = outputPx();
    setFinalPhoto({ dataUrl, widthPx: w, heightPx: h });
    setBgWarning(null);
    setSheetPreview(null);
    setSheetSummary(null);
    // Only a meaningful check for official types with a known flat target
    // background color — "styled" backgrounds (LinkedIn, custom text) have
    // nothing fixed to compare against.
    const swatch = selectedBackground.swatch;
    if (swatch) {
      sampleBackgroundColor(dataUrl)
        .then((rgb) => {
          const distance = colorDistanceFromHex(rgb, swatch);
          if (distance !== null && distance > BACKGROUND_MATCH_THRESHOLD) {
            setBgWarning(
              `Màu nền tạo ra có vẻ chưa khớp với "${selectedBackground.label}" đã chọn — nên kiểm tra kỹ hoặc tạo lại nếu dùng cho hồ sơ chính thức.`,
            );
          }
        })
        .catch((err) => console.error("Failed to check background color:", err));
    }
  };

  const handleDownload = async () => {
    if (!finalPhoto || isSaving) return;
    setIsSaving(true);
    try {
      let dataBase64 = finalPhoto.dataUrl.split(",")[1] ?? "";
      let ext = "png";
      if (format === "JPG") {
        const converted = await convertToJpeg(finalPhoto.dataUrl);
        dataBase64 = converted.split(",")[1] ?? "";
        ext = "jpg";
      }
      const savedPath = await invoke<string | null>("save_image_file", {
        data: dataBase64,
        suggestedName: `anh-the-${selectedType.id}-${Date.now()}.${ext}`,
      });
      if (savedPath) {
        setSavedNotice("photo");
        setTimeout(() => setSavedNotice(null), 2000);
      }
    } catch (err) {
      console.error("Failed to save image:", err);
      setError(typeof err === "string" ? err : "Không lưu được ảnh");
    } finally {
      setIsSaving(false);
    }
  };

  // Builds the mixed-size print sheet: any size with a requested count > 0
  // that the user hasn't manually cropped gets auto-cropped from rawResult
  // (same "cover fit centered on the subject" default CropGuide starts
  // with — see autoCropToSize/estimateSubjectFocus), so the user only has to
  // type in how many of each size they want, not crop every size by hand.
  const handleComposeMixedSheet = async () => {
    if (!rawResult || isComposingSheet) return;
    const wanted = selectedType.sizes
      .map((s) => ({ size: s, count: sheetCounts[s.id] ?? 0 }))
      .filter((x) => x.count > 0 && x.size.widthMm && x.size.heightMm);
    if (wanted.length === 0) return;

    setIsComposingSheet(true);
    try {
      const rawDataUrl = `data:${rawResult.mime_type};base64,${rawResult.data}`;
      const items = await Promise.all(
        wanted.map(async ({ size, count }) => {
          const dataUrl =
            size.id === selectedSize.id && finalPhoto
              ? finalPhoto.dataUrl
              : await autoCropToSize(rawDataUrl, mmToPx(size.widthMm!, PRINT_DPI), mmToPx(size.heightMm!, PRINT_DPI), focusHint);
          return { id: size.id, label: size.label, dataUrl, widthMm: size.widthMm!, heightMm: size.heightMm!, count };
        }),
      );
      const sheet = SHEET_SIZES.find((s) => s.id === sheetSizeId) ?? SHEET_SIZES[0];
      const result = await composeMixedPrintSheet(
        items,
        { width: sheet.widthMm, height: sheet.heightMm },
        PRINT_DPI,
        sheetCutLines,
      );
      setSheetPreview(result.dataUrl);
      setSheetSummary({ placed: result.placed, unplaced: result.unplaced });
    } catch (err) {
      console.error("Failed to compose print sheet:", err);
    } finally {
      setIsComposingSheet(false);
    }
  };

  const handleDownloadSheet = async () => {
    if (!sheetPreview || isSaving) return;
    setIsSaving(true);
    try {
      const dataBase64 = sheetPreview.split(",")[1] ?? "";
      const sheet = SHEET_SIZES.find((s) => s.id === sheetSizeId) ?? SHEET_SIZES[0];
      const savedPath = await invoke<string | null>("save_image_file", {
        data: dataBase64,
        suggestedName: `to-in-${sheet.id}-${Date.now()}.png`,
      });
      if (savedPath) {
        setSavedNotice("sheet");
        setTimeout(() => setSavedNotice(null), 2000);
      }
    } catch (err) {
      console.error("Failed to save print sheet:", err);
    } finally {
      setIsSaving(false);
    }
  };

  const handleDeleteHistory = async (id: string) => {
    try {
      await invoke("delete_id_photo_history_entry", { id });
      setHistory((prev) => prev.filter((h) => h.id !== id));
      setBatch((prev) => prev.filter((h) => h.id !== id));
      if (rawResult?.id === id) {
        setRawResult(null);
        setFinalPhoto(null);
        setSheetPreview(null);
        setSheetSummary(null);
        setBgWarning(null);
      }
    } catch (err) {
      console.error("Failed to delete history entry:", err);
    }
  };

  if (apiKeyConfigured === false) {
    return (
      <div className="absolute inset-0 flex items-center justify-center bg-gray-50">
        <div className="text-center max-w-sm px-6">
          <p className="text-gray-600 font-medium mb-2">Chưa cấu hình Gemini API key</p>
          <p className="text-sm text-gray-400 mb-4">Cần API key để dùng tính năng tạo ảnh thẻ bằng Nano Banana Pro.</p>
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

  const targetRatio =
    (selectedSize.pxWidth ?? selectedSize.widthMm ?? 1) / (selectedSize.pxHeight ?? selectedSize.heightMm ?? 1);
  const { w: targetWidthPx, h: targetHeightPx } = outputPx();

  return (
    <div className={`absolute inset-0 flex bg-gray-50 overflow-hidden ${isDragOver ? "ring-2 ring-inset ring-justice-blue" : ""}`}>
      {/* Left panel: inputs */}
      <div className="w-[360px] shrink-0 border-r border-gray-200 bg-white overflow-y-auto p-4 flex flex-col gap-4">
        <div>
          <h1 className="text-justice-blue font-bold text-base">🆔 Ảnh thẻ</h1>
          <p className="text-xs text-gray-400 mt-0.5">Tạo ảnh thẻ, hộ chiếu, visa, CV, LinkedIn đúng chuẩn bằng Nano Banana Pro</p>
        </div>

        <div>
          <div className="text-xs font-bold uppercase text-gray-400 mb-1.5">Nhóm ảnh</div>
          <div className="grid grid-cols-2 gap-1.5">
            {PHOTO_GROUPS.map((g) => (
              <button
                key={g.id}
                type="button"
                onClick={() => setGroupId(g.id)}
                className={`py-2 rounded-lg text-xs font-medium flex flex-col items-center gap-0.5 transition-colors cursor-pointer ${
                  groupId === g.id ? "bg-justice-blue text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                }`}
              >
                <span className="text-base leading-none">{g.icon}</span>
                {g.label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <div className="text-xs font-bold uppercase text-gray-400 mb-1.5">Loại ảnh</div>
          <select
            value={typeId}
            onChange={(e) => setTypeId(e.target.value)}
            className="w-full text-sm px-3 py-2 rounded-lg bg-gray-100 text-gray-800 outline-none cursor-pointer"
          >
            {typesInGroup.map((t) => (
              <option key={t.id} value={t.id}>{t.label}</option>
            ))}
          </select>
        </div>

        <div>
          <div className="text-xs font-bold uppercase text-gray-400 mb-1.5">Cỡ ảnh</div>
          <div className="flex flex-wrap gap-1.5">
            {selectedType.sizes.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => {
                  setSizeId(s.id);
                  // Reuse the raw generated image for the new size instead of
                  // regenerating — only the crop step needs to run again.
                  if (rawResult) {
                    setFinalPhoto(null);
                    setSheetPreview(null);
                    setSheetSummary(null);
                    setBgWarning(null);
                  }
                }}
                className={`px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer ${
                  sizeId === s.id ? "bg-justice-blue text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
          {rawResult && (
            <div className="text-[11px] text-gray-400 mt-1">
              Đổi cỡ dùng lại ảnh vừa tạo để cắt lại, không tốn thêm lượt gọi API.
            </div>
          )}
        </div>

        <div>
          <div className="text-xs font-bold uppercase text-gray-400 mb-1.5">Phông nền</div>
          <div className="flex flex-wrap gap-1.5">
            {selectedType.backgrounds.map((b) => (
              <button
                key={b.id}
                type="button"
                onClick={() => handleBackgroundSelect(b.id)}
                disabled={isSwappingBackground}
                className={`px-2.5 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-50 ${
                  backgroundId === b.id ? "bg-justice-blue text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                }`}
              >
                {b.swatch && (
                  <span className="w-3 h-3 rounded-full border border-black/10 shrink-0" style={{ backgroundColor: b.swatch }} />
                )}
                {b.label}
              </button>
            ))}
          </div>
          {rawResult && selectedBackground.swatch && (
            <div className="text-[11px] text-gray-400 mt-1">
              {isSwappingBackground
                ? "Đang đổi màu nền..."
                : "Đổi giữa các màu nền có sẵn cũng dùng lại ảnh vừa tạo, không tốn thêm lượt gọi API."}
            </div>
          )}
          {selectedType.allowCustomBackground && selectedBackground.id === "custom" && (
            <textarea
              value={customBackgroundText}
              onChange={(e) => setCustomBackgroundText(e.target.value)}
              placeholder="Mô tả phông nền mong muốn, ví dụ: phòng họp hiện đại làm mờ hậu cảnh, tông màu trung tính..."
              rows={2}
              className="w-full text-sm px-3 py-2 mt-1.5 rounded-lg bg-gray-50 border border-gray-200 text-gray-800 outline-none resize-none placeholder-gray-400 focus:border-justice-blue"
            />
          )}
        </div>

        <div>
          <div className="text-xs font-bold uppercase text-gray-400 mb-1.5">Phong cách</div>
          <textarea
            value={styleDraft}
            onChange={(e) => setStyleDraft(e.target.value)}
            rows={2}
            className="w-full text-sm px-3 py-2 rounded-lg bg-gray-50 border border-gray-200 text-gray-800 outline-none resize-none placeholder-gray-400 focus:border-justice-blue"
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
            hint="Không có sẽ dùng mô tả bên dưới hoặc giữ trang phục gốc"
            image={outfit}
            onPick={(f) => fileToUploadedImage(f).then(setOutfit)}
            onClear={() => setOutfit(null)}
          />
          <textarea
            value={outfitDescription}
            onChange={(e) => setOutfitDescription(e.target.value)}
            placeholder="Mô tả trang phục thêm (tuỳ chọn), ví dụ: áo sơ mi trắng, vest xanh navy..."
            rows={2}
            className="w-full text-sm px-3 py-2 mt-1.5 rounded-lg bg-gray-50 border border-gray-200 text-gray-800 outline-none resize-none placeholder-gray-400 focus:border-justice-blue"
          />
        </div>

        <div>
          <div className="text-xs font-bold uppercase text-gray-400 mb-1.5">Kiểu tóc</div>
          <select
            value={hairId}
            onChange={(e) => setHairId(e.target.value)}
            className="w-full text-sm px-3 py-2 rounded-lg bg-gray-100 text-gray-800 outline-none cursor-pointer"
          >
            {HAIR_OPTIONS.map((h) => (
              <option key={h.id} value={h.id}>{h.label}</option>
            ))}
          </select>
          {hairId === "custom" && (
            <input
              type="text"
              value={customHairText}
              onChange={(e) => setCustomHairText(e.target.value)}
              placeholder="Mô tả kiểu tóc mong muốn..."
              className="w-full text-sm px-3 py-2 mt-1.5 rounded-lg bg-gray-50 border border-gray-200 text-gray-800 outline-none placeholder-gray-400 focus:border-justice-blue"
            />
          )}
        </div>

        <div>
          <div className="text-xs font-bold uppercase text-gray-400 mb-1.5">Hướng dẫn bổ sung (tuỳ chọn)</div>
          <textarea
            value={extraInstructions}
            onChange={(e) => setExtraInstructions(e.target.value)}
            placeholder="Ví dụ: giữ nguyên râu, không chỉnh sửa nốt ruồi trên má..."
            rows={2}
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
          <div className="text-[11px] text-gray-400 mt-1">Độ phân giải càng cao, ảnh sau khi cắt/xuất ra càng sắc nét, ít vỡ hạt — nên chọn 4K nếu cần in ảnh chất lượng cao.</div>
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
                  {confirmDeleteId === h.id ? (
                    <div className="w-full aspect-square rounded-lg bg-black/80 flex flex-col items-center justify-center gap-1 text-white text-[9px] px-1 text-center">
                      <span>Xoá ảnh này?</span>
                      <div className="flex gap-1">
                        <button
                          type="button"
                          onClick={() => {
                            handleDeleteHistory(h.id);
                            setConfirmDeleteId(null);
                          }}
                          className="px-1.5 py-0.5 rounded bg-authority-red font-bold cursor-pointer"
                        >
                          Xoá
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteId(null)}
                          className="px-1.5 py-0.5 rounded bg-white/20 font-bold cursor-pointer"
                        >
                          Huỷ
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() => pickVariant(h)}
                        title={h.label}
                        className="w-full aspect-square rounded-lg overflow-hidden border border-gray-200 cursor-pointer"
                      >
                        <img src={`data:${h.mime_type};base64,${h.data}`} alt="" className="w-full h-full object-cover" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteId(h.id)}
                        title="Xoá"
                        className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-black/70 text-white text-[9px] flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
                      >
                        ✕
                      </button>
                    </>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Right panel: result */}
      <div className="flex-1 flex flex-col items-center justify-center p-6 relative overflow-y-auto">
        {isGenerating ? (
          <div className="text-center">
            <div className="text-3xl mb-2 animate-pulse">✨</div>
            <p className="text-sm text-gray-500">
              {variantCount > 1
                ? genProgress
                  ? `Đang tạo ảnh ${genProgress.done}/${genProgress.total}...`
                  : `Đang tạo ${variantCount} ảnh, có thể mất vài phút...`
                : "Đang tạo ảnh, có thể mất khoảng một phút..."}
            </p>
          </div>
        ) : error ? (
          <div className="text-center max-w-md px-6">
            <p className="text-authority-red font-medium mb-1">Không tạo được ảnh</p>
            <p className="text-sm text-gray-500">{error}</p>
          </div>
        ) : rawResult && !finalPhoto ? (
          <div className="flex flex-col items-center gap-3">
            {persons[0] && (
              <div className="flex items-center gap-2">
                <div className="flex flex-col items-center gap-1">
                  <img
                    src={`data:${persons[0].mimeType};base64,${persons[0].data}`}
                    alt="Ảnh gốc"
                    className="w-14 h-14 rounded-lg object-cover border border-gray-200"
                  />
                  <span className="text-[10px] text-gray-400">Ảnh gốc</span>
                </div>
                <span className="text-gray-300">→</span>
              </div>
            )}
            <CropGuide
              imageDataUrl={`data:${rawResult.mime_type};base64,${rawResult.data}`}
              aspectRatio={targetRatio}
              guide={selectedType.guide}
              outputWidthPx={targetWidthPx}
              outputHeightPx={targetHeightPx}
              initialFocus={focusHint}
              onConfirm={handleCropConfirm}
            />
            {batch.length > 1 && (
              <div className="flex gap-2 flex-wrap justify-center">
                {batch.map((b) => (
                  <button
                    key={b.id}
                    type="button"
                    onClick={() => pickVariant(b)}
                    className={`w-14 h-14 rounded-lg overflow-hidden border-2 transition-colors cursor-pointer ${
                      rawResult.id === b.id ? "border-justice-blue" : "border-transparent hover:border-gray-300"
                    }`}
                  >
                    <img src={`data:${b.mime_type};base64,${b.data}`} alt="" className="w-full h-full object-cover" />
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : finalPhoto ? (
          <div className="max-w-full flex flex-col items-center gap-3">
            {persons[0] && (
              <div className="flex items-center gap-2">
                <div className="flex flex-col items-center gap-1">
                  <img
                    src={`data:${persons[0].mimeType};base64,${persons[0].data}`}
                    alt="Ảnh gốc"
                    className="w-14 h-14 rounded-lg object-cover border border-gray-200"
                  />
                  <span className="text-[10px] text-gray-400">Ảnh gốc</span>
                </div>
                <span className="text-gray-300">→</span>
              </div>
            )}
            <img
              src={finalPhoto.dataUrl}
              alt="Kết quả"
              className="max-h-[40vh] rounded-xl shadow-lg object-contain border border-gray-200"
            />
            {bgWarning && (
              <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-1.5 max-w-sm text-center">
                ⚠️ {bgWarning}
              </p>
            )}
            <div className="text-xs text-gray-400">
              {finalPhoto.widthPx} x {finalPhoto.heightPx}px · {selectedType.label} · {selectedSize.label}
            </div>

            <div className="flex gap-2 items-center">
              {FORMATS.map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setFormat(f)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors cursor-pointer ${
                    format === f ? "bg-justice-blue text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                  }`}
                >
                  {f}
                </button>
              ))}
            </div>

            <div className="flex gap-2 flex-wrap justify-center">
              <button
                type="button"
                onClick={handleDownload}
                disabled={isSaving}
                className="px-4 py-2 bg-justice-blue text-white rounded-xl text-sm font-bold shadow-md hover:bg-blue-800 transition-colors disabled:opacity-50 cursor-pointer"
              >
                {savedNotice === "photo" ? "✓ Đã lưu" : isSaving ? "Đang lưu..." : "⬇ Tải xuống 1 ảnh"}
              </button>
              {selectedType.printable && (
                <button
                  type="button"
                  onClick={() => setSheetOpen((v) => !v)}
                  className="px-4 py-2 bg-gray-100 text-gray-700 rounded-xl text-sm font-bold hover:bg-gray-200 transition-colors cursor-pointer"
                >
                  🖨️ Tải tờ in
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  setFinalPhoto(null);
                  setBgWarning(null);
                }}
                className="px-4 py-2 bg-gray-100 text-gray-700 rounded-xl text-sm font-bold hover:bg-gray-200 transition-colors cursor-pointer"
              >
                ✂️ Canh lại khung
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

            {selectedType.printable && sheetOpen && (
              <div className="mt-2 w-full max-w-sm bg-white border border-gray-200 rounded-xl p-3 flex flex-col gap-2">
                <div className="text-xs font-bold uppercase text-gray-400">In nhiều ảnh trên 1 tờ</div>
                <div className="flex flex-wrap gap-1.5">
                  {SHEET_SIZES.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => setSheetSizeId(s.id)}
                      className={`px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer ${
                        sheetSizeId === s.id ? "bg-justice-blue text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                      }`}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
                <div className="text-[11px] text-gray-400">
                  Nhập số lượng cho mỗi cỡ muốn in — cỡ chưa canh tay sẽ được tự động cắt căn giữa từ ảnh vừa tạo.
                </div>
                <div className="flex flex-col gap-1.5">
                  {selectedType.sizes.map((s) => (
                    <div key={s.id} className="flex items-center justify-between gap-2">
                      <span className="text-xs text-gray-700">{s.label}</span>
                      <input
                        type="number"
                        min={0}
                        max={100}
                        value={sheetCounts[s.id] ?? 0}
                        onChange={(e) =>
                          setSheetCounts((prev) => ({ ...prev, [s.id]: Math.max(0, Number(e.target.value) || 0) }))
                        }
                        className="w-16 text-sm px-2 py-1 rounded-lg bg-gray-100 outline-none"
                      />
                    </div>
                  ))}
                </div>
                <label className="flex items-center gap-1 text-xs text-gray-600 cursor-pointer">
                  <input type="checkbox" checked={sheetCutLines} onChange={(e) => setSheetCutLines(e.target.checked)} />
                  Đường kẻ cắt
                </label>
                <button
                  type="button"
                  onClick={handleComposeMixedSheet}
                  disabled={isComposingSheet}
                  className="py-1.5 rounded-lg bg-justice-blue text-white text-xs font-bold cursor-pointer disabled:opacity-50"
                >
                  {isComposingSheet ? "Đang xếp..." : "Xếp tờ in"}
                </button>
                {sheetPreview && sheetSummary && (
                  <div className="flex flex-col items-center gap-1.5 mt-1">
                    <img src={sheetPreview} alt="Tờ in" className="max-h-64 rounded-lg border border-gray-200 object-contain" />
                    <div className="text-[11px] text-gray-400 text-center">
                      Đã xếp: {sheetSummary.placed.map((p) => `${p.label} x${p.count}`).join(", ")}
                    </div>
                    {sheetSummary.unplaced.length > 0 && (
                      <div className="text-[11px] text-amber-700 text-center">
                        ⚠️ Không đủ chỗ: {sheetSummary.unplaced.map((p) => `${p.label} thiếu ${p.count}`).join(", ")} — chọn khổ giấy lớn hơn hoặc giảm số lượng.
                      </div>
                    )}
                    <button
                      type="button"
                      onClick={handleDownloadSheet}
                      disabled={isSaving}
                      className="px-3 py-1.5 rounded-lg bg-justice-blue text-white text-xs font-bold cursor-pointer disabled:opacity-50"
                    >
                      {savedNotice === "sheet" ? "✓ Đã lưu" : "⬇ Tải tờ in"}
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        ) : (
          <div className="text-center max-w-sm px-6">
            <p className="text-gray-400 font-medium">Kết quả sẽ hiện ở đây</p>
            <p className="text-xs text-gray-300 mt-1">Chọn loại/cỡ ảnh, tải ảnh chân dung, sau đó bấm "Tạo ảnh"</p>
          </div>
        )}
      </div>
    </div>
  );
}
