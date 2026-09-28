// Shared image-handling helpers used by every image-generation tab
// (ImageStudio, IdPhotoStudio, ...). All canvas-based — no external
// dependency needed for file reading, format conversion, cropping or
// print-sheet composition.

export interface QualityWarning {
  code: string;
  message: string;
}

export interface UploadedImage {
  mimeType: string;
  data: string; // base64, no data-url prefix
  name: string;
  // Only set for portrait photos (see analyzePortraitQuality) — advisory
  // only, never blocks generation.
  warnings?: QualityWarning[];
}

// Shared generation-quality options for the Gemini image API's `imageSize`
// config, used by every tab that generates an image.
export type Resolution = "1K" | "2K" | "4K";
export const RESOLUTIONS: Resolution[] = ["1K", "2K", "4K"];

export function fileToUploadedImage(file: File): Promise<UploadedImage> {
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
export function convertToJpeg(dataUrl: string): Promise<string> {
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

const QUALITY_SAMPLE_SIZE = 200;
const LOW_RES_THRESHOLD_PX = 400;
const TOO_DARK_MEAN = 60;
const TOO_BRIGHT_MEAN = 215;
// Variance-of-Laplacian is a standard cheap blur estimator (the same idea as
// OpenCV's `cv2.Laplacian(img, CV_64F).var()`); the threshold below is an
// empirical rule of thumb, not a calibrated measurement, so this is only
// ever surfaced as a soft advisory warning, never a hard block.
const BLUR_VARIANCE_THRESHOLD = 80;

// Downscales the portrait to a small canvas and checks resolution,
// brightness and blur — the three most common reasons a reference photo
// produces a poor identity match or a noisy result, all cheap enough to run
// synchronously on every upload without any external library.
export function analyzePortraitQuality(dataUrl: string): Promise<QualityWarning[]> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const warnings: QualityWarning[] = [];
      const { naturalWidth: w, naturalHeight: h } = img;
      if (Math.min(w, h) < LOW_RES_THRESHOLD_PX) {
        warnings.push({
          code: "low_res",
          message: `Ảnh có độ phân giải thấp (${w}x${h}px) — nên dùng ảnh gốc lớn hơn để có kết quả sắc nét.`,
        });
      }

      const size = QUALITY_SAMPLE_SIZE;
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        resolve(warnings);
        return;
      }
      ctx.drawImage(img, 0, 0, size, size);

      let data: Uint8ClampedArray;
      try {
        data = ctx.getImageData(0, 0, size, size).data;
      } catch {
        resolve(warnings);
        return;
      }

      const gray = new Float32Array(size * size);
      let sum = 0;
      for (let i = 0, p = 0; i < data.length; i += 4, p++) {
        const g = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        gray[p] = g;
        sum += g;
      }
      const mean = sum / gray.length;
      if (mean < TOO_DARK_MEAN) {
        warnings.push({ code: "too_dark", message: "Ảnh khá tối — nên chụp ở nơi đủ sáng để khuôn mặt rõ nét hơn." });
      } else if (mean > TOO_BRIGHT_MEAN) {
        warnings.push({ code: "too_bright", message: "Ảnh bị cháy sáng — nên chụp ở nơi ánh sáng dịu hơn." });
      }

      let lapSum = 0;
      let lapSumSq = 0;
      let count = 0;
      for (let y = 1; y < size - 1; y++) {
        for (let x = 1; x < size - 1; x++) {
          const idx = y * size + x;
          const lap = gray[idx - 1] + gray[idx + 1] + gray[idx - size] + gray[idx + size] - 4 * gray[idx];
          lapSum += lap;
          lapSumSq += lap * lap;
          count++;
        }
      }
      const lapMean = lapSum / count;
      const variance = lapSumSq / count - lapMean * lapMean;
      if (variance < BLUR_VARIANCE_THRESHOLD) {
        warnings.push({
          code: "blurry",
          message: "Ảnh có vẻ hơi mờ hoặc thiếu chi tiết — kết quả tạo ra có thể không sắc nét.",
        });
      }

      resolve(warnings);
    };
    img.onerror = () => resolve([]);
    img.src = dataUrl;
  });
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const clean = hex.replace("#", "");
  if (clean.length !== 6) return null;
  return {
    r: parseInt(clean.substring(0, 2), 16),
    g: parseInt(clean.substring(2, 4), 16),
    b: parseInt(clean.substring(4, 6), 16),
  };
}

// Averages pixel color in the 4 corners of an already-cropped ID photo —
// reliably background, since the subject sits in the middle — to sanity
// check it actually matches the requested flat background color.
export function sampleBackgroundColor(dataUrl: string): Promise<{ r: number; g: number; b: number }> {
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
      ctx.drawImage(img, 0, 0);
      const w = canvas.width;
      const h = canvas.height;
      const sample = Math.max(4, Math.round(Math.min(w, h) * 0.05));
      const corners: [number, number][] = [
        [0, 0],
        [w - sample, 0],
        [0, h - sample],
        [w - sample, h - sample],
      ];
      let rSum = 0;
      let gSum = 0;
      let bSum = 0;
      let n = 0;
      for (const [cx, cy] of corners) {
        const data = ctx.getImageData(cx, cy, sample, sample).data;
        for (let i = 0; i < data.length; i += 4) {
          rSum += data[i];
          gSum += data[i + 1];
          bSum += data[i + 2];
          n++;
        }
      }
      resolve({ r: rSum / n, g: gSum / n, b: bSum / n });
    };
    img.onerror = reject;
    img.src = dataUrl;
  });
}

export function colorDistanceFromHex(rgb: { r: number; g: number; b: number }, hex: string): number | null {
  const target = hexToRgb(hex);
  if (!target) return null;
  return Math.sqrt((rgb.r - target.r) ** 2 + (rgb.g - target.g) ** 2 + (rgb.b - target.b) ** 2);
}

const FOCUS_SAMPLE_SIZE = 100;
// How far (in RGB distance) a pixel must be from the target background color
// to count as "subject" rather than background — heuristic, not exact.
const FOCUS_FOREGROUND_THRESHOLD = 40;
// Bail out (return null, caller falls back to geometric centering) if fewer
// than this fraction of sampled pixels look like foreground — the estimate
// isn't trustworthy (e.g. background didn't come out close to the target
// color, or the crop is almost all background).
const FOCUS_MIN_FOREGROUND_RATIO = 0.02;

// Cheap chroma-key heuristic for a better initial crop position than dead
// center: only meaningful when the photo type has a known flat target
// background color (backgroundHex) — for "styled" backgrounds (LinkedIn,
// custom descriptions) there's nothing reliable to key against, so this
// returns null and the caller keeps the existing geometric-center default.
// This is used instead of the browser's Shape Detection `FaceDetector` API,
// which is not available on desktop Chromium (WebView2/Windows) — only on
// Android/ChromeOS — so it would be dead code on this app's actual target.
export function estimateSubjectFocus(
  dataUrl: string,
  backgroundHex?: string,
): Promise<{ xPct: number; yPct: number } | null> {
  if (!backgroundHex) return Promise.resolve(null);
  const bg = hexToRgb(backgroundHex);
  if (!bg) return Promise.resolve(null);

  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      if (!w || !h) {
        resolve(null);
        return;
      }
      const sw = FOCUS_SAMPLE_SIZE;
      const sh = Math.max(1, Math.round((h / w) * sw));
      const canvas = document.createElement("canvas");
      canvas.width = sw;
      canvas.height = sh;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        resolve(null);
        return;
      }
      ctx.drawImage(img, 0, 0, sw, sh);
      let data: Uint8ClampedArray;
      try {
        data = ctx.getImageData(0, 0, sw, sh).data;
      } catch {
        resolve(null);
        return;
      }

      let sumX = 0;
      let sumY = 0;
      let count = 0;
      for (let y = 0; y < sh; y++) {
        for (let x = 0; x < sw; x++) {
          const idx = (y * sw + x) * 4;
          const dr = data[idx] - bg.r;
          const dg = data[idx + 1] - bg.g;
          const db = data[idx + 2] - bg.b;
          const dist = Math.sqrt(dr * dr + dg * dg + db * db);
          if (dist > FOCUS_FOREGROUND_THRESHOLD) {
            sumX += x;
            sumY += y;
            count++;
          }
        }
      }
      if (count < sw * sh * FOCUS_MIN_FOREGROUND_RATIO) {
        resolve(null);
        return;
      }
      resolve({ xPct: sumX / count / sw, yPct: sumY / count / sh });
    };
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

const BG_SWAP_INNER_THRESHOLD = 30;
const BG_SWAP_OUTER_THRESHOLD = 75;

// Chroma-key style background color swap: pixels close to `oldHex` become
// `newHex`, with the color blend feathered between the two thresholds so the
// swap doesn't leave a hard cutout edge around hair/shoulders. This is only
// as good as the source background actually being a fairly clean flat color
// to begin with — not real background segmentation, but good enough to
// switch between official flat-color ID photo backgrounds (white/blue/gray)
// without calling the API again.
export function replaceFlatBackground(dataUrl: string, oldHex: string, newHex: string): Promise<string> {
  const oldRgb = hexToRgb(oldHex);
  const newRgb = hexToRgb(newHex);
  if (!oldRgb || !newRgb) return Promise.reject(new Error("Invalid color"));

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
      ctx.drawImage(img, 0, 0);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const data = imageData.data;
      for (let i = 0; i < data.length; i += 4) {
        const dr = data[i] - oldRgb.r;
        const dg = data[i + 1] - oldRgb.g;
        const db = data[i + 2] - oldRgb.b;
        const dist = Math.sqrt(dr * dr + dg * dg + db * db);
        if (dist >= BG_SWAP_OUTER_THRESHOLD) continue; // clearly the subject, leave untouched
        const t =
          dist <= BG_SWAP_INNER_THRESHOLD
            ? 1
            : 1 - (dist - BG_SWAP_INNER_THRESHOLD) / (BG_SWAP_OUTER_THRESHOLD - BG_SWAP_INNER_THRESHOLD);
        data[i] = data[i] * (1 - t) + newRgb.r * t;
        data[i + 1] = data[i + 1] * (1 - t) + newRgb.g * t;
        data[i + 2] = data[i + 2] * (1 - t) + newRgb.b * t;
      }
      ctx.putImageData(imageData, 0, 0);
      resolve(canvas.toDataURL("image/png"));
    };
    img.onerror = reject;
    img.src = dataUrl;
  });
}

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Crops `cropRect` (in the source image's natural pixel space) out of
// `dataUrl` and scales it to exactly outputWidthPx x outputHeightPx. This is
// what guarantees the final ID photo matches an official size to the pixel,
// regardless of what aspect ratio the generative model actually produced.
export function cropImageToSize(
  dataUrl: string,
  cropRect: CropRect,
  outputWidthPx: number,
  outputHeightPx: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = outputWidthPx;
      canvas.height = outputHeightPx;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        reject(new Error("Canvas not supported"));
        return;
      }
      ctx.drawImage(
        img,
        cropRect.x,
        cropRect.y,
        cropRect.width,
        cropRect.height,
        0,
        0,
        outputWidthPx,
        outputHeightPx,
      );
      resolve(canvas.toDataURL("image/png"));
    };
    img.onerror = reject;
    img.src = dataUrl;
  });
}

// Same "cover fit centered on a focus point" math CropGuide uses at zoom=1,
// factored out so it can also run headlessly (no UI/pan/zoom) for sizes the
// print sheet needs that the user hasn't manually cropped.
function computeCoverCropRect(
  naturalW: number,
  naturalH: number,
  targetW: number,
  targetH: number,
  focus?: { xPct: number; yPct: number } | null,
): CropRect {
  const targetRatio = targetW / targetH;
  const naturalRatio = naturalW / naturalH;
  let cropW: number;
  let cropH: number;
  if (naturalRatio > targetRatio) {
    cropH = naturalH;
    cropW = cropH * targetRatio;
  } else {
    cropW = naturalW;
    cropH = cropW / targetRatio;
  }
  const cx = focus ? focus.xPct * naturalW : naturalW / 2;
  const cy = focus ? focus.yPct * naturalH : naturalH / 2;
  const x = Math.min(Math.max(cx - cropW / 2, 0), naturalW - cropW);
  const y = Math.min(Math.max(cy - cropH / 2, 0), naturalH - cropH);
  return { x, y, width: cropW, height: cropH };
}

// Headless equivalent of confirming CropGuide at zoom=1: crops the largest
// centered (or focus-centered) region matching the target aspect ratio and
// scales it to the exact output size — used by the print sheet to prepare
// sizes the user hasn't manually cropped, without asking them to.
export function autoCropToSize(
  dataUrl: string,
  outputWidthPx: number,
  outputHeightPx: number,
  focus?: { xPct: number; yPct: number } | null,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const rect = computeCoverCropRect(img.naturalWidth, img.naturalHeight, outputWidthPx, outputHeightPx, focus);
      cropImageToSize(dataUrl, rect, outputWidthPx, outputHeightPx).then(resolve).catch(reject);
    };
    img.onerror = reject;
    img.src = dataUrl;
  });
}

export interface SizeMm {
  width: number;
  height: number;
}

const SHEET_MARGIN_MM = 5;
const SHEET_GUTTER_MM = 2;

export function mmToPx(mm: number, dpi: number): number {
  return Math.round((mm / 25.4) * dpi);
}

export interface SheetItem {
  id: string;
  label: string;
  dataUrl: string;
  widthMm: number;
  heightMm: number;
  count: number;
}

export interface SheetPlacementSummary {
  id: string;
  label: string;
  count: number;
}

export interface MixedSheetResult {
  dataUrl: string;
  placed: SheetPlacementSummary[];
  unplaced: SheetPlacementSummary[];
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = dataUrl;
  });
}

// Tiles possibly-mixed photo sizes (the classic "photo shop" sheet with, say,
// 10 3x4 + 5 2x3 + 3 4x6 all on one 10x15cm print) onto one sheet at `dpi`.
// Packing uses a simple "shelf" heuristic — sort pieces tallest-first, fill
// each row left to right, wrap to a new row once one doesn't fit width-wise —
// a standard, easy-to-reason-about approach for a handful of rectangle sizes;
// it isn't a guaranteed-optimal 2D bin packing, so anything that still
// doesn't fit vertically is reported back as `unplaced` instead of drawn, so
// the caller can tell the user to pick a bigger sheet or lower a count.
export async function composeMixedPrintSheet(
  items: SheetItem[],
  sheetSizeMm: SizeMm,
  dpi: number,
  showCutLines: boolean,
): Promise<MixedSheetResult> {
  const sheetWpx = mmToPx(sheetSizeMm.width, dpi);
  const sheetHpx = mmToPx(sheetSizeMm.height, dpi);
  const marginPx = mmToPx(SHEET_MARGIN_MM, dpi);
  const gutterPx = mmToPx(SHEET_GUTTER_MM, dpi);

  const images = await Promise.all(items.map((item) => loadImage(item.dataUrl)));

  interface Copy {
    itemIndex: number;
    w: number;
    h: number;
  }
  const copies: Copy[] = [];
  items.forEach((item, itemIndex) => {
    const w = mmToPx(item.widthMm, dpi);
    const h = mmToPx(item.heightMm, dpi);
    for (let i = 0; i < item.count; i++) copies.push({ itemIndex, w, h });
  });
  copies.sort((a, b) => b.h - a.h);

  const canvas = document.createElement("canvas");
  canvas.width = sheetWpx;
  canvas.height = sheetHpx;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas not supported");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  let cursorX = marginPx;
  let cursorY = marginPx;
  let rowHeight = 0;
  const placedCount = new Array(items.length).fill(0);
  const unplacedCount = new Array(items.length).fill(0);

  for (const copy of copies) {
    if (cursorX + copy.w > sheetWpx - marginPx) {
      cursorX = marginPx;
      cursorY += rowHeight + gutterPx;
      rowHeight = 0;
    }
    if (cursorY + copy.h > sheetHpx - marginPx) {
      unplacedCount[copy.itemIndex]++;
      continue;
    }
    ctx.drawImage(images[copy.itemIndex], cursorX, cursorY, copy.w, copy.h);
    if (showCutLines) {
      ctx.save();
      ctx.strokeStyle = "rgba(0,0,0,0.35)";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.strokeRect(cursorX + 0.5, cursorY + 0.5, copy.w - 1, copy.h - 1);
      ctx.restore();
    }
    placedCount[copy.itemIndex]++;
    cursorX += copy.w + gutterPx;
    rowHeight = Math.max(rowHeight, copy.h);
  }

  return {
    dataUrl: canvas.toDataURL("image/png"),
    placed: items
      .map((it, i) => ({ id: it.id, label: it.label, count: placedCount[i] }))
      .filter((x) => x.count > 0),
    unplaced: items
      .map((it, i) => ({ id: it.id, label: it.label, count: unplacedCount[i] }))
      .filter((x) => x.count > 0),
  };
}
