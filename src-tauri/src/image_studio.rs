use crate::{load_api_key, Attachment};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

// Embeds the full "realistic composite" checklist so every generation is held
// to the same bar regardless of what the user types in "extra instructions".
const COMPOSITE_PROMPT: &str = r#"Bạn là chuyên gia ghép ảnh chân dung vào ảnh nền một cách chân thực tuyệt đối.

Ảnh đầu tiên là ẢNH NỀN (một buổi họp mặt gia đình, công ty hoặc bạn bè).
Ảnh thứ hai là ẢNH CHÂN DUNG của một người cần được ghép vào ảnh nền.

Nhiệm vụ: tạo ra MỘT bức ảnh ghép hoàn chỉnh, trong đó người trong ảnh chân dung xuất hiện trong ảnh nền một cách tự nhiên và chân thực đến tuyệt đối, như thể họ thực sự có mặt lúc chụp. Không trả lời bằng văn bản, chỉ trả về ảnh kết quả.

YÊU CẦU QUAN TRỌNG NHẤT — TÁI TẠO CHÍNH XÁC KHUÔN MẶT (bắt buộc tuân thủ tuyệt đối, ưu tiên cao hơn mọi yêu cầu khác):
Khuôn mặt của người được ghép phải GIỐNG HỆT 100% khuôn mặt trong ảnh chân dung — phải là cùng một con người, nhận ra được ngay. Giữ nguyên tuyệt đối mọi đặc điểm nhận dạng: hình dạng và tỷ lệ khuôn mặt, cấu trúc xương (gò má, quai hàm, cằm, trán), hình dáng và khoảng cách hai mắt, màu mắt, hình dáng mũi, hình dáng và độ dày môi, lông mày, kiểu tóc và chân tóc, nước da, cùng mọi nốt ruồi, nếp nhăn, sẹo, râu hay đặc điểm riêng khác. TUYỆT ĐỐI KHÔNG được làm đẹp, trẻ hoá, thay đổi giới tính/độ tuổi/dân tộc, không "vẽ lại" thành một gương mặt tương tự hay một người trông na ná. Nếu buộc phải xoay đầu hoặc đổi biểu cảm cho khớp bối cảnh, vẫn phải bảo toàn tuyệt đối danh tính để bất kỳ ai nhìn vào cũng khẳng định đó đúng là người trong ảnh chân dung. Đây là tiêu chí nghiệm thu bắt buộc: nếu khuôn mặt kết quả không được nhận ra là cùng một người thì coi như thất bại.

Các yêu cầu bắt buộc khác:

1. Tỷ lệ & góc chụp: Người được ghép có kích thước hợp lý so với người khác, bàn ghế, không gian trong ảnh (không quá to hoặc quá nhỏ). Góc chụp (từ trên xuống, ngang, từ dưới lên) và hướng cơ thể (quay mặt, xoay vai) phải tương đồng với góc chụp và cách mọi người ngồi/đứng trong ảnh nền.

2. Phối cảnh: Đường chân trời, hướng bàn ghế, tường... phải khớp với vị trí người được ghép. Người được ghép phải đứng/ngồi trên một mặt phẳng hợp lý (sàn, nền, ghế) — không trôi lơ lửng, không chìm xuống nền.

3. Ánh sáng & bóng đổ: Hướng sáng trên mặt/người được ghép phải trùng với hướng sáng trong ảnh nền. Độ sáng tối (brightness/contrast) không được khác biệt rõ so với những người khác. Cần có bóng đổ hợp lý trên sàn/bàn/ghế, độ mềm/cứng của bóng tương tự bóng của các đối tượng khác trong ảnh.

4. Màu sắc & nhiệt độ màu: Nhiệt độ màu (ấm/lạnh) của người được ghép phải giống với ảnh nền. Độ bão hòa màu của da, quần áo phải tương đương những người khác trong ảnh (không rực hơn hẳn). Toàn bộ bức ảnh phải có một tông màu thống nhất.

5. Độ nét, nhiễu & chất lượng: Độ nét của người được ghép phải gần giống người khác trong ảnh nền (không quá sắc, không quá mờ). Mức độ noise/grain tương tự ảnh nền, kể cả khi phóng to. Không được có vùng vỡ hình, răng cưa ở mép cơ thể, tay, tóc.

6. Mép ghép & occlusion: Không được để lại viền sáng/tối quanh người được ghép; mép tóc, vai, tay phải trông tự nhiên. Không được sót lại nền cũ của ảnh chân dung (màu tường khác, mép vật thể lạ). Quan hệ che khuất phải hợp lý — nếu người đó đứng sau ghế hoặc người khác, phần bị che phải đúng vị trí.

7. Ngôn ngữ cơ thể & ngữ cảnh: Nét mặt, tư thế phải phù hợp bối cảnh (họp, chụp tập thể, gia đình...) — không mang dáng vẻ "selfie" giữa một khung cảnh trang trọng. Hướng mắt và hướng cơ thể phải tương đồng với cả nhóm (nhìn về camera hoặc nhìn về slide/bàn tùy bối cảnh). Vị trí người được ghép trong nhóm không được trái logic (không chen vào chỗ không có ghế hoặc không có chỗ trống)."#;

#[derive(Serialize, Deserialize, Clone)]
pub struct HistoryEntry {
    pub id: String,
    pub mime_type: String,
    /// Base64, no data URL prefix.
    pub data: String,
    pub extra_instructions: String,
    pub resolution: String,
    pub aspect_ratio: String,
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
    extra_instructions: String,
    resolution: String,
    aspect_ratio: String,
}

fn history_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("image_history");
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

// Persists the generated image + its parameters as a new history entry and
// returns it. Every successful generation goes through here so history is
// never out of sync with what the user actually saw.
fn persist_history_entry(
    app: &tauri::AppHandle,
    mime_type: String,
    data: String,
    extra_instructions: String,
    resolution: String,
    aspect_ratio: String,
) -> Result<HistoryEntry, String> {
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
        extra_instructions: extra_instructions.clone(),
        resolution: resolution.clone(),
        aspect_ratio: aspect_ratio.clone(),
    };

    let mut index = load_index(app);
    index.entries.insert(0, meta);
    save_index(app, &index)?;

    Ok(HistoryEntry {
        id,
        mime_type,
        data,
        extra_instructions,
        resolution,
        aspect_ratio,
    })
}

// One API call: sends the prepared body and returns (mime_type, base64 data)
// of the first image part, or a human-readable error.
async fn request_one_image(
    client: &reqwest::Client,
    url: &str,
    api_key: &str,
    body: &serde_json::Value,
) -> Result<(String, String), String> {
    let res = client
        .post(url)
        .header("X-goog-api-key", api_key)
        .json(body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = res.status();
    let resp_body: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;

    if !status.is_success() {
        let msg = resp_body["error"]["message"]
            .as_str()
            .unwrap_or("Unknown error");
        return Err(msg.to_string());
    }

    let response_parts = resp_body["candidates"][0]["content"]["parts"]
        .as_array()
        .cloned()
        .unwrap_or_default();

    // Google's REST responses use camelCase (`inlineData`/`mimeType`) even
    // though snake_case is also accepted on the way in.
    for part in &response_parts {
        let inline = part.get("inlineData").or_else(|| part.get("inline_data"));
        if let Some(inline) = inline {
            let mime_type = inline["mimeType"]
                .as_str()
                .or_else(|| inline["mime_type"].as_str())
                .unwrap_or("image/png")
                .to_string();
            if let Some(data) = inline["data"].as_str() {
                return Ok((mime_type, data.to_string()));
            }
        }
    }

    let text_fallback = response_parts
        .iter()
        .find_map(|p| p["text"].as_str())
        .unwrap_or("Model không trả về ảnh nào.");
    Err(text_fallback.to_string())
}

#[tauri::command]
pub async fn generate_composite_image(
    app: tauri::AppHandle,
    background: Attachment,
    persons: Vec<Attachment>,
    outfit: Option<Attachment>,
    extra_instructions: String,
    resolution: String,
    aspect_ratio: String,
    variant_count: u32,
) -> Result<Vec<HistoryEntry>, String> {
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

    let mut prompt = COMPOSITE_PROMPT.to_string();
    if persons.len() > 1 {
        prompt.push_str(&format!(
            "\n\nNgười dùng cung cấp {} ẢNH CHÂN DUNG của CÙNG MỘT NGƯỜI ở các góc/biểu cảm khác nhau. Hãy tổng hợp thông tin từ tất cả các ảnh này để tái tạo khuôn mặt chính xác và nhất quán nhất — chúng đều là cùng một người, không phải nhiều người khác nhau.",
            persons.len()
        ));
    }
    if outfit.is_some() {
        prompt.push_str(
            "\n\nNgười dùng đã cung cấp thêm một ẢNH TRANG PHỤC riêng — hãy dùng bộ trang phục trong ảnh đó cho người được ghép, thay vì trang phục trong ảnh chân dung gốc.",
        );
    } else {
        prompt.push_str(
            "\n\nKhông có ảnh trang phục riêng — giữ nguyên trang phục người đó đang mặc trong ảnh chân dung.",
        );
    }
    // Persistent per-user addendum from Settings, applied to every generation.
    if !settings.image_extra_instruction.trim().is_empty() {
        prompt.push_str(&format!(
            "\n\nChỉ dẫn cố định của người dùng (luôn áp dụng):\n{}",
            settings.image_extra_instruction.trim()
        ));
    }
    if !extra_instructions.trim().is_empty() {
        prompt.push_str(&format!(
            "\n\nYêu cầu bổ sung từ người dùng (ưu tiên áp dụng nếu không mâu thuẫn với các yêu cầu ở trên):\n{}",
            extra_instructions.trim()
        ));
    }

    let mut parts = vec![serde_json::json!({ "text": prompt })];
    parts.push(serde_json::json!({
        "inline_data": { "mime_type": background.mime_type, "data": background.data }
    }));
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

    // "auto" isn't a real aspect ratio value the API accepts — omit the field
    // entirely so the model infers a ratio from the input images instead.
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

    // Variants are independent generations of the same request — one API call
    // each (this is why cost scales with the count). Done sequentially to stay
    // gentle on rate limits.
    let client = reqwest::Client::new();
    let mut entries = Vec::new();
    let mut last_error: Option<String> = None;
    for _ in 0..variant_count {
        match request_one_image(&client, &url, &api_key, &body).await {
            Ok((mime_type, data)) => {
                let entry = persist_history_entry(
                    &app,
                    mime_type,
                    data,
                    extra_instructions.clone(),
                    resolution.clone(),
                    aspect_ratio.clone(),
                )?;
                entries.push(entry);
            }
            Err(e) => last_error = Some(e),
        }
    }

    if entries.is_empty() {
        return Err(last_error.unwrap_or_else(|| "Không tạo được ảnh nào.".to_string()));
    }
    Ok(entries)
}

#[tauri::command]
pub fn list_image_history(app: tauri::AppHandle) -> Result<Vec<HistoryEntry>, String> {
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
        entries.push(HistoryEntry {
            id: meta.id,
            mime_type: meta.mime_type,
            data: STANDARD.encode(bytes),
            extra_instructions: meta.extra_instructions,
            resolution: meta.resolution,
            aspect_ratio: meta.aspect_ratio,
        });
    }
    Ok(entries)
}

// Writing the image through a native "Save As" dialog + Rust `fs::write`
// instead of an `<a download>` in the webview: WebView2 (the Tauri webview on
// Windows) silently ignores `download`-attribute clicks on data URLs, so the
// browser-style approach never produced a file. Returns the saved path, or
// `None` if the user cancelled the dialog.
#[tauri::command]
pub fn save_image_file(
    app: tauri::AppHandle,
    data: String,
    suggested_name: String,
) -> Result<Option<String>, String> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use tauri_plugin_dialog::DialogExt;

    let bytes = STANDARD.decode(&data).map_err(|e| e.to_string())?;
    let ext = suggested_name
        .rsplit('.')
        .next()
        .unwrap_or("png")
        .to_lowercase();

    let file_path = app
        .dialog()
        .file()
        .set_file_name(&suggested_name)
        .add_filter("Ảnh", &[ext.as_str()])
        .blocking_save_file();

    match file_path {
        Some(fp) => {
            let path = fp
                .as_path()
                .ok_or_else(|| "Đường dẫn không hợp lệ".to_string())?
                .to_path_buf();
            fs::write(&path, &bytes).map_err(|e| e.to_string())?;
            Ok(Some(path.to_string_lossy().to_string()))
        }
        None => Ok(None),
    }
}

#[tauri::command]
pub fn delete_image_history_entry(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let dir = history_dir(&app)?;
    let mut index = load_index(&app);
    if let Some(pos) = index.entries.iter().position(|m| m.id == id) {
        let meta = index.entries.remove(pos);
        let _ = fs::remove_file(dir.join(&meta.file_name));
        save_index(&app, &index)?;
    }
    Ok(())
}
