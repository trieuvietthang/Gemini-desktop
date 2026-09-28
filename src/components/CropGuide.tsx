import { useEffect, useRef, useState } from "react";
import { cropImageToSize } from "../lib/imageUtils";

const VIEWPORT_MAX_W = 300;
const VIEWPORT_MAX_H = 420;
const MAX_ZOOM = 2.5;

interface Offset {
  x: number;
  y: number;
}

// Fixed-ratio crop tool: the source image can be panned/zoomed inside a
// viewport shaped exactly like the target photo size, with reference guide
// lines for where the head/eyes should roughly sit. Generative models can't
// be trusted to hit an official framing spec pixel-perfect, so this manual
// step is what actually guarantees the final export matches the chosen
// standard — "Xác nhận" crops+scales to the exact output pixel size via
// cropImageToSize (plain canvas draw, no server round-trip needed).
export default function CropGuide({
  imageDataUrl,
  aspectRatio,
  guide,
  outputWidthPx,
  outputHeightPx,
  initialFocus,
  onConfirm,
}: {
  imageDataUrl: string;
  aspectRatio: number; // target width / height
  guide: { topPct: number; bottomPct: number } | null;
  outputWidthPx: number;
  outputHeightPx: number;
  // Normalized (0-1) point in the source image to center the initial crop
  // on, from a chroma-key subject-detection heuristic — null falls back to
  // plain geometric centering (see estimateSubjectFocus in lib/imageUtils.ts).
  initialFocus?: { xPct: number; yPct: number } | null;
  onConfirm: (dataUrl: string) => void;
}) {
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState<Offset>({ x: 0, y: 0 });
  const [isConfirming, setIsConfirming] = useState(false);
  const dragRef = useRef<{ startX: number; startY: number; startOffset: Offset } | null>(null);
  const imgElRef = useRef<HTMLImageElement | null>(null);

  let viewportW = VIEWPORT_MAX_W;
  let viewportH = viewportW / aspectRatio;
  if (viewportH > VIEWPORT_MAX_H) {
    viewportH = VIEWPORT_MAX_H;
    viewportW = viewportH * aspectRatio;
  }

  const baseScale = natural ? Math.max(viewportW / natural.w, viewportH / natural.h) : 1;

  // Zooming shrinks the native-pixel region actually being cropped; past a
  // point that region has fewer pixels than the requested output size, so
  // cropImageToSize has to upscale (stretch) it — that's what makes an
  // exported photo look blocky/pixelated. Capping the slider here means the
  // user physically can't drag into that territory instead of finding out
  // only after downloading a blurry photo.
  const maxSafeZoom = natural
    ? Math.max(
        1,
        Math.min(viewportW / (baseScale * outputWidthPx), viewportH / (baseScale * outputHeightPx)),
      )
    : MAX_ZOOM;
  const effectiveMaxZoom = Math.min(MAX_ZOOM, maxSafeZoom);
  const effectiveZoom = Math.min(zoom, effectiveMaxZoom);
  // Even the default (un-zoomed) crop would need to upscale — the source
  // generation itself doesn't have enough native pixels for this output size.
  const sourceResolutionTooLow = natural !== null && maxSafeZoom <= 1.01;

  const scale = baseScale * effectiveZoom;
  const displayedW = natural ? natural.w * scale : 0;
  const displayedH = natural ? natural.h * scale : 0;

  const clampOffset = (o: Offset, dW: number, dH: number): Offset => ({
    x: Math.min(0, Math.max(viewportW - dW, o.x)),
    y: Math.min(0, Math.max(viewportH - dH, o.y)),
  });

  // Reads the now-loaded image's natural size and centers the crop on
  // `initialFocus` (a "cover fit" crop, like object-fit: cover, but
  // recentered on the estimated subject instead of the image's geometric
  // center when a focus hint is available) — falls back to the geometric
  // center when there's no hint, same as before.
  const applyNaturalSize = (img: HTMLImageElement) => {
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    if (!w || !h) return;
    setNatural({ w, h });
    const s = Math.max(viewportW / w, viewportH / h);
    const cx = initialFocus ? initialFocus.xPct * w : w / 2;
    const cy = initialFocus ? initialFocus.yPct * h : h / 2;
    setOffset(clampOffset({ x: viewportW / 2 - cx * s, y: viewportH / 2 - cy * s }, w * s, h * s));
  };

  // New image (or a different variant picked from the batch, or the target
  // size/ratio changing — see IdPhotoStudio's size switcher) — reset the
  // crop to a freshly-centered, un-zoomed view. A `data:` URI often finishes
  // decoding synchronously, so the <img> (same DOM node, just a new `src`)
  // can already be `complete` by the time this runs and never fire another
  // `load` event — check directly instead of relying solely on onLoad,
  // otherwise the crop box is left blank with nothing to confirm.
  useEffect(() => {
    setZoom(1);
    setNatural(null);
    setOffset({ x: 0, y: 0 });
    const img = imgElRef.current;
    if (img && img.complete && img.naturalWidth > 0) {
      applyNaturalSize(img);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageDataUrl, aspectRatio]);

  const handleZoomChange = (requestedZoom: number) => {
    if (!natural) {
      setZoom(requestedZoom);
      return;
    }
    const nextZoom = Math.min(requestedZoom, effectiveMaxZoom);
    const s = baseScale * nextZoom;
    setZoom(nextZoom);
    setOffset((prev) => clampOffset(prev, natural.w * s, natural.h * s));
  };

  const handlePointerDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture(e.pointerId);
    dragRef.current = { startX: e.clientX, startY: e.clientY, startOffset: offset };
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!dragRef.current || !natural) return;
    const dx = e.clientX - dragRef.current.startX;
    const dy = e.clientY - dragRef.current.startY;
    const next = {
      x: dragRef.current.startOffset.x + dx,
      y: dragRef.current.startOffset.y + dy,
    };
    setOffset(clampOffset(next, displayedW, displayedH));
  };

  const handlePointerUp = () => {
    dragRef.current = null;
  };

  const handleConfirm = async () => {
    if (!natural || isConfirming) return;
    setIsConfirming(true);
    try {
      const cropRect = {
        x: -offset.x / scale,
        y: -offset.y / scale,
        width: viewportW / scale,
        height: viewportH / scale,
      };
      const dataUrl = await cropImageToSize(imageDataUrl, cropRect, outputWidthPx, outputHeightPx);
      onConfirm(dataUrl);
    } catch (err) {
      console.error("Failed to crop image:", err);
    } finally {
      setIsConfirming(false);
    }
  };

  return (
    <div className="flex flex-col items-center gap-3">
      <p className="text-xs text-gray-400 text-center max-w-xs">
        Kéo để di chuyển, dùng thanh trượt để phóng to — canh mặt vào giữa khung, đầu chạm gần đường gióng trên cùng.
      </p>
      <div
        className="relative rounded-xl overflow-hidden border-2 border-justice-blue shadow-lg touch-none select-none cursor-move bg-gray-900"
        style={{ width: viewportW, height: viewportH }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerUp}
      >
        <img
          ref={(el) => {
            imgElRef.current = el;
            // Mounting straight onto an already-complete image (very common
            // for data: URIs, which need no network round-trip) — same
            // fallback as the effect above, for the very first mount.
            if (el && el.complete && el.naturalWidth > 0 && !natural) {
              applyNaturalSize(el);
            }
          }}
          src={imageDataUrl}
          alt="Ảnh gốc"
          draggable={false}
          onLoad={(e) => applyNaturalSize(e.currentTarget)}
          style={{
            position: "absolute",
            left: offset.x,
            top: offset.y,
            width: displayedW || undefined,
            height: displayedH || undefined,
            maxWidth: "none",
          }}
        />
        {guide && (
          <div className="absolute inset-0 pointer-events-none">
            <div
              className="absolute inset-x-0 border-t border-dashed border-legal-gold"
              style={{ top: `${guide.topPct}%` }}
            />
            <div
              className="absolute inset-x-0 border-t border-dashed border-legal-gold"
              style={{ top: `${guide.bottomPct}%` }}
            />
            <div className="absolute inset-y-0 left-1/2 border-l border-dashed border-white/50" />
          </div>
        )}
      </div>
      <div className="w-full max-w-[300px] flex items-center gap-2">
        <span className="text-xs text-gray-400">🔍</span>
        <input
          type="range"
          min={1}
          max={effectiveMaxZoom}
          step={0.05}
          value={effectiveZoom}
          onChange={(e) => handleZoomChange(Number(e.target.value))}
          className="flex-1 accent-justice-blue cursor-pointer"
        />
      </div>
      {sourceResolutionTooLow && (
        <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-1.5 max-w-[300px] text-center">
          ⚠️ Ảnh gốc hơi thiếu chi tiết cho cỡ ảnh này — chọn độ phân giải "4K" ở mục Độ phân giải rồi tạo lại để nét hơn.
        </p>
      )}
      <button
        type="button"
        onClick={handleConfirm}
        disabled={!natural || isConfirming}
        className="px-4 py-2 bg-justice-blue text-white rounded-xl text-sm font-bold shadow-md hover:bg-blue-800 transition-colors disabled:opacity-50 cursor-pointer"
      >
        {isConfirming ? "Đang xử lý..." : "✓ Xác nhận cỡ ảnh"}
      </button>
    </div>
  );
}
