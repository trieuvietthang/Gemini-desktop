import { useRef } from "react";
import type { UploadedImage } from "../lib/imageUtils";

// Single-image upload slot (background, outfit, ...): empty dashed box that
// turns into a thumbnail with a hover-to-remove button once filled.
export function UploadZone({
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

// Multi-image uploader that accepts several photos of the same person
// (different angles/expressions) to sharpen face fidelity.
export function MultiUploadZone({
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
          {img.warnings && img.warnings.length > 0 && (
            <div
              title={img.warnings.map((w) => w.message).join("\n")}
              className="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-legal-gold text-[10px] flex items-center justify-center cursor-help shadow"
            >
              ⚠️
            </div>
          )}
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
