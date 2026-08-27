// rh.tradingbot — native shell. The window loads the local backend (which serves
// the SPA + API same-origin on :8011). Start the backend first via run-native.sh.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running rh.tradingbot");
}
