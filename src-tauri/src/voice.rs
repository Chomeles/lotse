//! Spracheingabe: Whisper-Modelle verwalten (herunterladen, löschen) und Sprache auf dem eigenen Rechner
//! in Text wandeln. Nichts davon verlässt den Rechner, nur das Modell wird einmalig geladen.

use std::{
    fs,
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};

use serde::Serialize;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContextParameters};

pub use whisper_rs::WhisperContext;

const SOURCE: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";

pub struct Model {
    pub id: &'static str,
    pub name: &'static str,
    pub note: &'static str,
    pub file: &'static str,
    /// Größe der fertigen Datei. Daran erkennt Hostess, ob das Modell vollständig da ist.
    pub bytes: u64,
}

/// Vom kleinsten zum größten.
pub const MODELS: [Model; 4] = [
    Model {
        id: "base",
        name: "Klein",
        note: "Schnell, macht bei Deutsch und Fachwörtern spürbar Fehler",
        file: "ggml-base.bin",
        bytes: 147_951_465,
    },
    Model {
        id: "small",
        name: "Mittel",
        note: "Gut für Deutsch und Englisch",
        file: "ggml-small.bin",
        bytes: 487_601_967,
    },
    Model {
        id: "turbo-q5",
        name: "Groß",
        note: "Sehr genau, braucht einen kräftigen Rechner",
        file: "ggml-large-v3-turbo-q5_0.bin",
        bytes: 574_041_195,
    },
    Model {
        id: "turbo",
        name: "Maximal",
        note: "Beste Erkennung, am langsamsten",
        file: "ggml-large-v3-turbo.bin",
        bytes: 1_624_555_275,
    },
];

#[derive(Debug, Serialize)]
pub struct ModelInfo {
    pub id: &'static str,
    pub name: &'static str,
    pub note: &'static str,
    pub bytes: u64,
    pub installed: bool,
    /// Schon geladene Bytes eines angefangenen Downloads.
    pub loaded: u64,
    /// Ob gerade ein Download läuft. Das weiß nur der Aufrufer.
    pub downloading: bool,
}

pub fn find(id: &str) -> Result<&'static Model, String> {
    MODELS.iter().find(|model| model.id == id).ok_or_else(|| "Dieses Sprachmodell gibt es nicht.".to_string())
}

/// Ein angefangener Download liegt neben dem fertigen Namen.
fn part(dir: &Path, model: &Model) -> PathBuf {
    dir.join(format!("{}.part", model.file))
}

fn size(path: &Path) -> u64 {
    fs::metadata(path).map_or(0, |meta| meta.len())
}

/// Installiert heißt: die Datei liegt in `dir` und hat genau die erwartete Größe.
pub fn installed(dir: &Path, model: &Model) -> bool {
    size(&dir.join(model.file)) == model.bytes
}

pub fn list(dir: &Path) -> Vec<ModelInfo> {
    MODELS
        .iter()
        .map(|m| ModelInfo {
            id: m.id,
            name: m.name,
            note: m.note,
            bytes: m.bytes,
            installed: installed(dir, m),
            loaded: size(&part(dir, m)),
            downloading: false,
        })
        .collect()
}

/// Lädt das Modell nach `dir` und setzt dabei einen angefangenen Download fort. Liefert `false`, wenn über
/// `cancel` abgebrochen wurde. Blockiert, gehört also in `spawn_blocking`.
pub fn download(dir: &Path, model: &Model, cancel: &AtomicBool) -> Result<bool, String> {
    // Eine zu große .part passt zu keinem Stand des Modells: von vorn.
    let have = Some(size(&part(dir, model))).filter(|have| *have <= model.bytes).unwrap_or(0);
    if have == model.bytes {
        return store(dir, model, io::empty(), true, cancel);
    }
    // Ohne Komprimierung, sonst stimmen die Bytes nicht mit der Stelle in der Datei überein.
    let mut request = ureq::get(format!("{SOURCE}/{}", model.file)).header("Accept-Encoding", "identity");
    if have > 0 {
        request = request.header("Range", format!("bytes={have}-"));
    }
    let response =
        request.config().timeout_connect(Some(Duration::from_secs(20))).build().call().map_err(|e| match e {
            ureq::Error::StatusCode(code) => {
                format!("huggingface.co hat mit dem Fehler {code} geantwortet. Versuch es später noch einmal.")
            }
            _ => "huggingface.co ist nicht erreichbar. Prüfe deine Internetverbindung.".to_string(),
        })?;
    // 206 heißt: der Server schickt nur den Rest. Sonst kommt die ganze Datei, also von vorn.
    let resume = response.status() == 206;
    store(dir, model, response.into_body().into_reader(), resume, cancel)
}

/// Schreibt nach `<datei>.part` (`resume`: hängt an) und benennt nur um, wenn alles da ist: unter dem fertigen
/// Namen liegt nie ein halbes Modell. Bei Abbruch oder Fehler bleibt die .part zum Fortsetzen liegen.
/// `cancel` wird zwischen den Blöcken geprüft.
// shortcut: Geprüft wird nur die Größe, keine Prüfsumme. Die Quelle ist fest und kommt über HTTPS.
fn store(dir: &Path, model: &Model, mut from: impl Read, resume: bool, cancel: &AtomicBool) -> Result<bool, String> {
    let disk = |e: io::Error| match e.kind() {
        io::ErrorKind::StorageFull => "Der Datenträger ist voll. Schaffe Platz und setze den Download fort.".to_string(),
        _ => format!("Das Modell ließ sich nicht speichern: {e}"),
    };
    let part = part(dir, model);
    fs::create_dir_all(dir).map_err(disk)?;
    let mut to =
        fs::OpenOptions::new().create(true).write(true).append(resume).truncate(!resume).open(&part).map_err(disk)?;
    let mut done = if resume { size(&part) } else { 0 };
    let mut buf = vec![0; 64 * 1024];
    while done <= model.bytes {
        if cancel.load(Ordering::Relaxed) {
            return Ok(false);
        }
        let n = from
            .read(&mut buf)
            .map_err(|_| "Die Verbindung ist abgerissen. Der Download lässt sich fortsetzen.".to_string())?;
        if n == 0 {
            break;
        }
        to.write_all(&buf[..n]).map_err(disk)?;
        done += n as u64;
    }
    drop(to);
    if done > model.bytes {
        let _ = fs::remove_file(&part);
        return Err("Der Server hat eine andere Datei geschickt als erwartet.".into());
    }
    if done < model.bytes {
        return Err("Der Download ist unvollständig. Er lässt sich fortsetzen.".into());
    }
    fs::rename(&part, dir.join(model.file)).map_err(disk)?;
    Ok(true)
}

/// Löscht das Modell und einen angefangenen Download.
pub fn delete(dir: &Path, model: &Model) -> Result<(), String> {
    for path in [dir.join(model.file), part(dir, model)] {
        match fs::remove_file(path) {
            Err(e) if e.kind() != io::ErrorKind::NotFound => {
                return Err(format!("Das Modell ließ sich nicht löschen: {e}"))
            }
            _ => {}
        }
    }
    Ok(())
}

/// Lädt ein Modell in den Arbeitsspeicher. Dauert je nach Größe einige Sekunden.
pub fn load(path: &Path) -> Result<WhisperContext, String> {
    WhisperContext::new_with_params(path, WhisperContextParameters::default())
        .map_err(|e| format!("Das Sprachmodell ließ sich nicht laden: {e}"))
}

/// Wandelt Sprache in Text. `samples`: 16 kHz, mono. Die Sprache erkennt Whisper selbst.
pub fn transcribe(context: &WhisperContext, samples: &[f32]) -> Result<String, String> {
    let failed = |e| format!("Die Spracherkennung ist fehlgeschlagen: {e}");
    // Whisper verarbeitet nichts unter einer Sekunde, also mit Stille auffüllen.
    let mut samples = samples.to_vec();
    samples.resize(samples.len().max(17_600), 0.0);
    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_language(Some("auto"));
    params.set_n_threads(std::thread::available_parallelism().map_or(4, |n| n.get() as i32));
    // Keine Geräusch-Vermerke wie „[Musik]“: der Text landet im Terminal.
    params.set_suppress_nst(true);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    params.set_print_special(false);
    let mut state = context.create_state().map_err(failed)?;
    state.full(params, &samples).map_err(failed)?;
    let mut text = String::new();
    for segment in (0..state.full_n_segments()).filter_map(|i| state.get_segment(i)) {
        text.push_str(&segment.to_str_lossy().map_err(failed)?);
    }
    // Bei Stille liefert Whisper Platzhalter wie „[BLANK_AUDIO]“ oder „(Musik)“: das ist kein gesprochener Text.
    let text = text.trim();
    let placeholder = (text.starts_with('[') && text.ends_with(']')) || (text.starts_with('(') && text.ends_with(')'));
    Ok(if placeholder { String::new() } else { text.to_string() })
}

#[cfg(test)]
mod tests {
    use super::*;

    const TINY: Model = Model { id: "t", name: "Test", note: "", file: "tiny.bin", bytes: 5 };

    fn temp(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("hostess-voice-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn installiert_nur_mit_genau_der_groesse() {
        let dir = temp("zustand");
        assert!(!installed(&dir, &TINY));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(TINY.file), b"1234").unwrap();
        assert!(!installed(&dir, &TINY));
        fs::write(dir.join(TINY.file), b"12345").unwrap();
        assert!(installed(&dir, &TINY));
        // Löschen nimmt auch einen angefangenen Download mit. Löschen, was nicht da ist, ist kein Fehler.
        fs::write(part(&dir, &TINY), b"12").unwrap();
        delete(&dir, &TINY).unwrap();
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 0);
        delete(&dir, &TINY).unwrap();
    }

    #[test]
    fn download_laesst_sich_fortsetzen_und_ist_erst_fertig_wenn_alles_da_ist() {
        let dir = temp("download");
        let go = AtomicBool::new(false);
        let partial = || size(&part(&dir, &TINY));

        // Abgebrochen: nichts Fertiges.
        assert_eq!(store(&dir, &TINY, &b"12345"[..], false, &AtomicBool::new(true)), Ok(false));
        assert!(!installed(&dir, &TINY));

        // Die Verbindung endet zu früh: der Anfang bleibt zum Fortsetzen liegen.
        assert!(store(&dir, &TINY, &b"123"[..], false, &go).is_err());
        assert!(!installed(&dir, &TINY));
        assert_eq!(partial(), 3);

        // Fortsetzen hängt den Rest an und macht das Modell fertig.
        assert_eq!(store(&dir, &TINY, &b"45"[..], true, &go), Ok(true));
        assert_eq!(fs::read(dir.join(TINY.file)).unwrap(), b"12345");
        assert_eq!(partial(), 0);

        // Ohne Fortsetzen fängt die .part von vorn an.
        let dir = temp("download-neu");
        assert!(store(&dir, &TINY, &b"12"[..], false, &go).is_err());
        assert_eq!(store(&dir, &TINY, &b"abcde"[..], false, &go), Ok(true));
        assert_eq!(fs::read(dir.join(TINY.file)).unwrap(), b"abcde");

        // Zu viele Bytes ergeben kein Modell und keine .part.
        let dir = temp("download-zu-gross");
        assert!(store(&dir, &TINY, &b"1234567"[..], false, &go).is_err());
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 0);
    }

    /// Von Hand: `HOSTESS_VOICE_MODEL` = Modelldatei, `HOSTESS_VOICE_WAV` = Aufnahme (16 kHz, mono, 16 Bit).
    /// `cargo test voice -- --ignored --nocapture` gibt den erkannten Text aus.
    #[test]
    #[ignore]
    fn erkennt_eine_aufnahme() {
        let model = std::env::var("HOSTESS_VOICE_MODEL").expect("HOSTESS_VOICE_MODEL fehlt");
        let wav = fs::read(std::env::var("HOSTESS_VOICE_WAV").expect("HOSTESS_VOICE_WAV fehlt")).unwrap();
        // Die Samples stehen hinter dem Abschnitt „data“ und seiner Länge.
        let data = wav.windows(4).position(|w| w == b"data").expect("kein data-Abschnitt") + 8;
        let samples: Vec<f32> =
            wav[data..].chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / 32768.0).collect();
        let text = transcribe(&load(Path::new(&model)).unwrap(), &samples).unwrap();
        println!("{text}");
        assert!(!text.is_empty());
    }
}
