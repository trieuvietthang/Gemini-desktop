// Shared low-level Gemini image-generation HTTP call, used by every feature
// that generates an image (image_studio, id_photo, ...) so the request/parse
// logic for Google's REST response shape only lives once.

// One API call: sends the prepared body and returns (mime_type, base64 data)
// of the first image part, or a human-readable error.
pub(crate) async fn request_one_image(
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
