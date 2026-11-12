fn main() {
    // Die Oberfläche wird beim Kompilieren eingebettet: bei Änderungen in ui/ neu bauen.
    println!("cargo:rerun-if-changed=../ui");
    tauri_build::build()
}
