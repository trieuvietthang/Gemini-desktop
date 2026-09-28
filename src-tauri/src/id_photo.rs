use crate::gemini_client::request_one_image;
use crate::{load_api_key, Attachment};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::Emitter;

// Base task description for every ID/portrait-photo generation. Unlike the
// composite feature (image_studio.rs), there is no background photo to merge
// into — the model generates a fresh studio-style portrait of the same
// person, framed and lit to the caller-supplied spec.
const BASE_PROMPT: &str = r#"Bạn là nhiếp ảnh gia studio chuyên nghiệp, chuyên chụp ảnh thẻ và ảnh chân dung đúng chuẩn.

Ảnh đính kèm là (một hoặc nhiều) ẢNH CHÂN DUNG của một người cần chụp ảnh thẻ/chân dung mới.

Nhiệm vụ: tạo ra MỘT bức ảnh chân dung studio hoàn chỉnh của đúng người này, đúng khung hình, phông nền và phong cách theo yêu cầu bên dưới. Không trả lời bằng văn bản, chỉ trả về ảnh kết quả."#;

// Same non-negotiable identity bar as image_studio.rs's COMPOSITE_PROMPT,
// worded for a freshly-generated studio portrait rather than a composite.
// Kept as its own copy (not shared) so tuning the composite feature's prompt
// can never accidentally change this one or vice versa.
const FACE_FIDELITY_CLAUSE: &str = r#"YÊU CẦU QUAN TRỌNG NHẤT — TÁI TẠO CHÍNH XÁC KHUÔN MẶT (bắt buộc tuân thủ tuyệt đối, ưu tiên cao hơn mọi yêu cầu khác):
Khuôn mặt trong ảnh kết quả phải GIỐNG HỆT 100% khuôn mặt trong (các) ảnh chân dung gốc — phải là cùng một con người, nhận ra được ngay. Giữ nguyên tuyệt đối mọi đặc điểm nhận dạng: hình dạng và tỷ lệ khuôn mặt, cấu trúc xương (gò má, quai hàm, cằm, trán), hình dáng và khoảng cách hai mắt, màu mắt, hình dáng mũi, hình dáng và độ dày môi, lông mày, nước da, cùng mọi nốt ruồi, nếp nhăn, sẹo, râu hay đặc điểm riêng khác. TUYỆT ĐỐI KHÔNG được làm đẹp, trẻ hoá, thay đổi giới tính/độ tuổi/dân tộc, không "vẽ lại" thành một gương mặt tương tự hay một người trông na ná. Đây là tiêu chí nghiệm thu bắt buộc: nếu khuôn mặt kết quả không được nhận ra là cùng một người thì coi như thất bại."#;

// Addresses the most common failure mode of this kind of generation: a
// correctly-identity-preserved face that still reads as "pasted on" because
// its tone/lighting/sharpness don't match the freshly-generated neck, ears
// and body around it. Ranked right after face fidelity since a technically
// accurate but visibly-composited face defeats the point of a "real photo".
const REALISM_CLAUSE: &str = r#"YÊU CẦU BẮT BUỘC VỀ TÍNH CHÂN THỰC (ưu tiên ngay sau yêu cầu giữ khuôn mặt ở trên):
Kết quả phải trông như MỘT BỨC ẢNH CHỤP THẬT bằng máy ảnh trong studio, tuyệt đối không được có cảm giác "ảnh ghép" hay chắp vá kỹ thuật số. Cụ thể:
- Tông da & màu sắc: vùng da mặt (giữ nguyên từ ảnh gốc) phải cùng tông màu, cùng độ sáng, cùng nhiệt độ màu (ấm/lạnh) với vùng cổ, tai và phần cơ thể được tạo mới bên dưới — không được để mặt sáng/tối hơn hoặc ngả màu khác (vàng/hồng/xanh) so với phần còn lại của ảnh.
- Ánh sáng: nguồn sáng, hướng sáng và độ mềm/cứng của bóng trên mặt phải nhất quán với ánh sáng chiếu lên cổ, vai và trang phục, như thể toàn bộ người được chụp dưới cùng một hệ thống đèn studio duy nhất.
- Độ nét & nhiễu hạt (grain): độ nét và mức nhiễu trên khuôn mặt phải tương đồng với phần còn lại của ảnh — không có vùng nào sắc nét bất thường hoặc mờ khác biệt rõ rệt so với xung quanh.
- Đường chuyển tiếp: vùng chuyển giữa mặt, cổ và tóc phải liền mạch tự nhiên, không có viền sáng/tối, không có ranh giới màu da đột ngột, không răng cưa hay vệt lạ quanh đường viền khuôn mặt/tóc."#;

#[derive(Serialize, Deserialize, Clone)]
pub struct IdPhotoHistoryEntry {
    pub id: String,
    pub mime_type: String,
    /// Base64, no data URL prefix.
    pub data: String,
    pub label: String,
}

#[derive(Serialize, Deserialize, Clone, Default)]
struct HistoryIndex {
    entries: Vec<HistoryMeta>,
}

#[derive(Serialize, Deserialize, Clone)]
struct HistoryMeta {
    id: String,
    mime_type: String,
    file_name: String,
    label: String,
}

fn history_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("id_photo_history");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn history_index_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(history_dir(app)?.join("index.json"))
}

fn load_index(app: &tauri::AppHandle) -> HistoryIndex {
    history_index_path(app)
        .ok()
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|d| serde_json::from_str(&d).ok())
        .unwrap_or_default()
}

fn save_index(app: &tauri::AppHandle, index: &HistoryIndex) -> Result<(), String> {
    let path = history_index_path(app)?;
    let data = serde_json::to_string_pretty(index).map_err(|e| e.to_string())?;
    fs::write(path, data).map_err(|e| e.to_string())
}

fn ext_for_mime(mime: &str) -> &'static str {
    match mime {
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        _ => "png",
    }
}

fn persist_history_entry(
    app: &tauri::AppHandle,
    mime_type: String,
    data: String,
    label: String,
) -> Result<IdPhotoHistoryEntry, String> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};

    let dir = history_dir(app)?;
    let id = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis()
        .to_string();
    let ext = ext_for_mime(&mime_type);
    let file_name = format!("{id}.{ext}");

    let bytes = STANDARD.decode(&data).map_err(|e| e.to_string())?;
    fs::write(dir.join(&file_name), &bytes).map_err(|e| e.to_string())?;

    let meta = HistoryMeta {
        id: id.clone(),
        mime_type: mime_type.clone(),
        file_name,
        label: label.clone(),
    };

    let mut index = load_index(app);
    index.entries.insert(0, meta);
    save_index(app, &index)?;

    Ok(IdPhotoHistoryEntry {
        id,
        mime_type,
        data,
        label,
    })
}

// Builds the outfit portion of the prompt: an outfit photo (if provided)
// takes precedence as the visual reference, an optional text description is
// layered on top either way, and with neither the subject's original outfit
// is kept as-is.
fn build_outfit_instruction(outfit: &Option<Attachment>, outfit_description: &str) -> String {
    let mut parts = Vec::new();
    if outfit.is_some() {
        parts.push(
            "Người dùng đã cung cấp thêm một ẢNH TRANG PHỤC riêng (ảnh cuối cùng đính kèm) — hãy dùng đúng bộ trang phục trong ảnh đó cho người trong ảnh kết quả, thay vì trang phục trong ảnh chân dung gốc.".to_string(),
        );
    }
    if !outfit_description.trim().is_empty() {
        parts.push(format!(
            "Mô tả trang phục mong muốn (ưu tiên áp dụng, kết hợp cùng ảnh trang phục nếu có): {}",
            outfit_description.trim()
        ));
    }
    if parts.is_empty() {
        "Không có yêu cầu trang phục riêng — giữ nguyên trang phục người đó đang mặc trong ảnh chân dung gốc, chỉnh trang lại gọn gàng nếu cần.".to_string()
    } else {
        parts.join("\n")
    }
}

#[tauri::command]
pub async fn generate_id_photo(
    app: tauri::AppHandle,
    persons: Vec<Attachment>,
    outfit: Option<Attachment>,
    outfit_description: String,
    hairstyle_instruction: String,
    framing_instruction: String,
    background_instruction: String,
    style_instruction: String,
    extra_instructions: String,
    aspect_ratio: String,
    resolution: String,
    variant_count: u32,
    label: String,
) -> Result<Vec<IdPhotoHistoryEntry>, String> {
    let api_key =
        load_api_key(&app).ok_or_else(|| "Chưa cấu hình Gemini API key".to_string())?;
    if persons.is_empty() {
        return Err("Cần ít nhất một ảnh chân dung.".to_string());
    }
    let settings = crate::load_settings(&app);
    let model = if settings.image_model.trim().is_empty() {
        crate::DEFAULT_IMAGE_MODEL.to_string()
    } else {
        settings.image_model.trim().to_string()
    };
    let variant_count = variant_count.clamp(1, 4);

    let mut prompt = format!("{BASE_PROMPT}\n\n{FACE_FIDELITY_CLAUSE}\n\n{REALISM_CLAUSE}");
    if persons.len() > 1 {
        prompt.push_str(&format!(
            "\n\nNgười dùng cung cấp {} ẢNH CHÂN DUNG của CÙNG MỘT NGƯỜI ở các góc/biểu cảm khác nhau. Hãy tổng hợp thông tin từ tất cả các ảnh này để tái tạo khuôn mặt chính xác và nhất quán nhất — chúng đều là cùng một người, không phải nhiều người khác nhau.",
            persons.len()
        ));
    }
    if !framing_instruction.trim().is_empty() {
        prompt.push_str(&format!("\n\nKhung hình: {}", framing_instruction.trim()));
    }
    if !background_instruction.trim().is_empty() {
        prompt.push_str(&format!("\n\nPhông nền: {}", background_instruction.trim()));
    }
    if !style_instruction.trim().is_empty() {
        prompt.push_str(&format!("\n\nPhong cách & biểu cảm: {}", style_instruction.trim()));
    }
    prompt.push_str(&format!(
        "\n\n{}",
        build_outfit_instruction(&outfit, &outfit_description)
    ));
    prompt.push_str(&format!(
        "\n\nKiểu tóc: {}",
        if hairstyle_instruction.trim().is_empty() {
            "Giữ nguyên kiểu tóc trong ảnh chân dung gốc."
        } else {
            hairstyle_instruction.trim()
        }
    ));
    if !extra_instructions.trim().is_empty() {
        prompt.push_str(&format!(
            "\n\nYêu cầu bổ sung từ người dùng (ưu tiên áp dụng nếu không mâu thuẫn với các yêu cầu ở trên):\n{}",
            extra_instructions.trim()
        ));
    }

    let mut parts = vec![serde_json::json!({ "text": prompt })];
    for person in &persons {
        parts.push(serde_json::json!({
            "inline_data": { "mime_type": person.mime_type, "data": person.data }
        }));
    }
    if let Some(o) = &outfit {
        parts.push(serde_json::json!({
            "inline_data": { "mime_type": o.mime_type, "data": o.data }
        }));
    }

    // Higher resolutions give the client-side crop step (CropGuide.tsx) more
    // native pixels to work with, which matters a lot once the user zooms in
    // to align the face with the framing guide — cropping a small region out
    // of a low-res source and stretching it up to the target print size is
    // what produces visibly blocky/blurry results.
    let mut image_config = serde_json::json!({ "imageSize": resolution });
    if aspect_ratio != "auto" {
        image_config["aspectRatio"] = serde_json::json!(aspect_ratio);
    }

    let body = serde_json::json!({
        "contents": [{ "role": "user", "parts": parts }],
        "generationConfig": {
            "responseModalities": ["IMAGE"],
            "imageConfig": image_config
        }
    });

    let url =
        format!("https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent");

    // Variants are independent generations of the same request — done
    // sequentially to stay gentle on rate limits, same as image_studio.rs.
    let client = reqwest::Client::new();
    let mut entries = Vec::new();
    let mut last_error: Option<String> = None;
    for i in 0..variant_count {
        match request_one_image(&client, &url, &api_key, &body).await {
            Ok((mime_type, data)) => {
                let entry = persist_history_entry(&app, mime_type, data, label.clone())?;
                entries.push(entry);
            }
            Err(e) => last_error = Some(e),
        }
        // Lets the frontend show "Đang tạo ảnh x/y..." instead of one opaque
        // spinner for the whole batch — best-effort, a missed event just
        // means the progress text doesn't update for that step.
        let _ = app.emit(
            "id_photo_progress",
            serde_json::json!({ "done": i + 1, "total": variant_count }),
        );
    }

    if entries.is_empty() {
        return Err(last_error.unwrap_or_else(|| "Không tạo được ảnh nào.".to_string()));
    }
    Ok(entries)
}

#[tauri::command]
pub fn list_id_photo_history(app: tauri::AppHandle) -> Result<Vec<IdPhotoHistoryEntry>, String> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};

    let dir = history_dir(&app)?;
    let index = load_index(&app);

    let mut entries = Vec::new();
    for meta in index.entries {
        let path = dir.join(&meta.file_name);
        let bytes = match fs::read(&path) {
            Ok(b) => b,
            Err(_) => continue,
        };
        entries.push(IdPhotoHistoryEntry {
            id: meta.id,
            mime_type: meta.mime_type,
            data: STANDARD.encode(bytes),
            label: meta.label,
        });
    }
    Ok(entries)
}

#[tauri::command]
pub fn delete_id_photo_history_entry(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let dir = history_dir(&app)?;
    let mut index = load_index(&app);
    if let Some(pos) = index.entries.iter().position(|m| m.id == id) {
        let meta = index.entries.remove(pos);
        let _ = fs::remove_file(dir.join(&meta.file_name));
        save_index(&app, &index)?;
    }
    Ok(())
}
