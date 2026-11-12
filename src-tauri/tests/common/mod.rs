//! Eingebauter SSH-Server für Tests: nimmt genau einen Schlüssel oder das Testpasswort an, schickt Shell-Eingaben zurück
//! und reicht SFTP an den `sftp-server` von Git für Windows weiter (falls installiert).
#![allow(dead_code)]

use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    process::Stdio,
    sync::Arc,
    time::Duration,
};

use russh::{
    keys::{ssh_key::LineEnding, Algorithm, PrivateKey, PublicKey},
    server::{self, Auth, Msg, Server as _, Session, VerifiedPublicKey},
    Channel, ChannelId, MethodKind, MethodSet,
};
use tokio::net::TcpListener;

pub const SFTP_SERVER: &str = "C:/Program Files/Git/usr/lib/ssh/sftp-server.exe";
/// Das einzige Passwort, das der Testserver annimmt (für jeden Benutzer).
pub const PASSWORD: &str = "testpasswort";
const BASH: &str = "C:/Program Files/Git/usr/bin/bash.exe";

struct Echo {
    allowed: PublicKey,
    /// Ob Anmeldung mit Passwort erlaubt ist.
    password: bool,
    /// Startordner für SFTP.
    dir: PathBuf,
    /// Geöffnete Kanäle, bis feststeht, ob sie Shell oder SFTP werden.
    pending: HashMap<ChannelId, Channel<Msg>>,
    shells: HashSet<ChannelId>,
}

impl Echo {
    fn new(allowed: PublicKey, password: bool, dir: PathBuf) -> Self {
        Self { allowed, password, dir, pending: HashMap::new(), shells: HashSet::new() }
    }
}

impl server::Server for Echo {
    type Handler = Self;
    fn new_client(&mut self, _: Option<std::net::SocketAddr>) -> Self {
        Echo::new(self.allowed.clone(), self.password, self.dir.clone())
    }
}

impl server::Handler for Echo {
    type Error = russh::Error;

    async fn auth_publickey(&mut self, _user: &str, key: VerifiedPublicKey<'_>) -> Result<Auth, Self::Error> {
        Ok(if key.public_key.key_data() == self.allowed.key_data() { Auth::Accept } else { Auth::reject() })
    }

    async fn auth_password(&mut self, _user: &str, password: &str) -> Result<Auth, Self::Error> {
        Ok(if self.password && password == PASSWORD {
            Auth::Accept
        } else {
            // Wie OpenSSH: nach einem falschen Passwort bleibt die Methode im Angebot (russh striche sie sonst).
            Auth::Reject { proceed_with_methods: Some(methods(self.password)), partial_success: false }
        })
    }

    async fn channel_open_session(
        &mut self,
        channel: Channel<Msg>,
        reply: server::ChannelOpenHandle,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.pending.insert(channel.id(), channel);
        reply.accept().await;
        Ok(())
    }

    async fn shell_request(&mut self, channel: ChannelId, session: &mut Session) -> Result<(), Self::Error> {
        self.pending.remove(&channel);
        self.shells.insert(channel);
        session.channel_success(channel)?;
        Ok(())
    }

    async fn subsystem_request(&mut self, id: ChannelId, name: &str, session: &mut Session) -> Result<(), Self::Error> {
        let (Some(channel), "sftp") = (self.pending.remove(&id), name) else {
            session.channel_failure(id)?;
            return Ok(());
        };
        let Ok(mut child) = tokio::process::Command::new(SFTP_SERVER)
            .arg("-d")
            .arg(&self.dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
        else {
            session.channel_failure(id)?;
            return Ok(());
        };
        session.channel_success(id)?;
        let (mut stdin, mut stdout) = (child.stdin.take().unwrap(), child.stdout.take().unwrap());
        let (mut from_client, mut to_client) = tokio::io::split(channel.into_stream());
        tokio::spawn(async move {
            tokio::select! {
                _ = tokio::io::copy(&mut from_client, &mut stdin) => {}
                _ = tokio::io::copy(&mut stdout, &mut to_client) => {}
            }
            drop(child);
        });
        Ok(())
    }

    async fn exec_request(&mut self, id: ChannelId, command: &[u8], session: &mut Session) -> Result<(), Self::Error> {
        self.pending.remove(&id);
        let command = String::from_utf8_lossy(command).into_owned();
        let Ok(out) = tokio::process::Command::new(BASH).arg("-c").arg(command).output().await else {
            session.channel_failure(id)?;
            return Ok(());
        };
        session.channel_success(id)?;
        session.data(id, out.stdout)?;
        session.extended_data(id, 1, out.stderr)?;
        session.exit_status_request(id, out.status.code().unwrap_or(1) as u32)?;
        session.eof(id)?;
        session.close(id)?;
        Ok(())
    }

    async fn data(&mut self, channel: ChannelId, data: &[u8], session: &mut Session) -> Result<(), Self::Error> {
        if data == [4] {
            // Strg+D beendet die Shell, wie `exit` auf einem echten Server.
            session.close(channel)?;
        } else if self.shells.contains(&channel) {
            session.data(channel, data.to_vec())?;
        }
        Ok(())
    }
}

fn methods(password: bool) -> MethodSet {
    let kinds: &[MethodKind] =
        if password { &[MethodKind::PublicKey, MethodKind::Password] } else { &[MethodKind::PublicKey] };
    MethodSet::from(kinds)
}

pub fn new_key() -> PrivateKey {
    PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap()
}

pub fn temp(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("lotse-echo-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    dir.join(name)
}

pub fn write_key(name: &str, key: &PrivateKey) -> String {
    let path = temp(name);
    std::fs::write(&path, key.to_openssh(LineEnding::LF).unwrap().as_bytes()).unwrap();
    path.to_string_lossy().into_owned()
}

/// Startet den Server (Port 0 = freier Port) und gibt Port und Host-Schlüssel zurück.
/// `dir` ist der Startordner für SFTP.
pub async fn start_server(allowed: PublicKey, port: u16, dir: PathBuf) -> (u16, PublicKey) {
    start(allowed, true, port, dir).await
}

/// Wie `start_server`, aber der Server erlaubt nur Schlüssel, kein Passwort.
pub async fn start_key_only_server(allowed: PublicKey, dir: PathBuf) -> (u16, PublicKey) {
    start(allowed, false, 0, dir).await
}

async fn start(allowed: PublicKey, password: bool, port: u16, dir: PathBuf) -> (u16, PublicKey) {
    let host_key = new_key();
    let public = host_key.public_key().clone();
    let config = Arc::new(server::Config {
        keys: vec![host_key],
        methods: methods(password),
        auth_rejection_time: Duration::from_millis(10),
        auth_rejection_time_initial: Some(Duration::ZERO),
        ..Default::default()
    });
    let socket = TcpListener::bind(("127.0.0.1", port)).await.unwrap();
    let port = socket.local_addr().unwrap().port();
    tokio::spawn(async move {
        let mut server = Echo::new(allowed, password, dir);
        server.run_on_socket(config, &socket).await.unwrap();
    });
    (port, public)
}
