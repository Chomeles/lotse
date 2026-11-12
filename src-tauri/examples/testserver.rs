//! Testserver zum Ausprobieren der Oberfläche: `cargo run --example testserver`.
//! Lauscht auf 127.0.0.1:2222, legt einen Testschlüssel an und schickt alle Eingaben zurück.

#[path = "../tests/common/mod.rs"]
mod common;

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let key = common::new_key();
    let plain = common::write_key("id_test", &key);
    let locked = common::write_key("id_test_passphrase", &key.encrypt(&mut rand::rng(), "geheim").unwrap());
    let dir = common::temp("dateien");
    std::fs::create_dir_all(&dir).unwrap();
    let (port, _) = common::start_server(key.public_key().clone(), 2222, dir.clone()).await;
    println!("Testserver auf 127.0.0.1:{port}, Benutzer beliebig, Passwort \"{}\"", common::PASSWORD);
    println!("Schlüssel ohne Passphrase: {plain}");
    println!("Schlüssel mit Passphrase \"geheim\": {locked}");
    println!("SFTP-Startordner: {}", dir.display());
    std::future::pending::<()>().await;
}
