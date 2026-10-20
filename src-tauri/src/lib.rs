// Thin desktop/Android shell around the web app. All app logic — storage in
// IndexedDB and GitHub sync — lives in the frontend (src/lib/backend/idb.ts),
// so the browser and the native app behave identically. The only native
// piece is clipboard image access, which webviews can't do reliably on
// Wayland.

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};

// Read an image from the system clipboard and return it as a base64-encoded PNG.
// Returns None if the clipboard contains no image.
#[tauri::command]
fn read_clipboard_image() -> Result<Option<String>, String> {
    let mut cb = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    match cb.get_image() {
        Ok(img) => {
            let mut png: Vec<u8> = Vec::new();
            let mut enc = png::Encoder::new(std::io::Cursor::new(&mut png), img.width as u32, img.height as u32);
            enc.set_color(png::ColorType::Rgba);
            enc.set_depth(png::BitDepth::Eight);
            let mut w = enc.write_header().map_err(|e| e.to_string())?;
            w.write_image_data(&img.bytes).map_err(|e| e.to_string())?;
            drop(w);
            Ok(Some(B64.encode(&png)))
        }
        Err(_) => Ok(None),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![read_clipboard_image])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
