//! Eingebauter SSH-Server für Tests: nimmt genau einen Schlüssel an und schickt alle Daten zurück.
#![allow(dead_code)]

use std::{path::PathBuf, sync::Arc, time::Duration};

use russh::{
    keys::{ssh_key::LineEnding, Algorithm, PrivateKey, PublicKey},
    server::{self, Auth, Msg, Server as _, Session, VerifiedPublicKey},
    Channel, ChannelId,
};
use tokio::net::TcpListener;

#[derive(Clone)]
struct Echo {
    allowed: PublicKey,
}

impl server::Server for Echo {
    type Handler = Self;
    fn new_client(&mut self, _: Option<std::net::SocketAddr>) -> Self {
        self.clone()
    }
}

impl server::Handler for Echo {
    type Error = russh::Error;

    async fn auth_publickey(&mut self, _user: &str, key: VerifiedPublicKey<'_>) -> Result<Auth, Self::Error> {
        Ok(if key.public_key.key_data() == self.allowed.key_data() { Auth::Accept } else { Auth::reject() })
    }

    async fn channel_open_session(
        &mut self,
        _channel: Channel<Msg>,
        reply: server::ChannelOpenHandle,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        reply.accept().await;
        Ok(())
    }

    async fn data(&mut self, channel: ChannelId, data: &[u8], session: &mut Session) -> Result<(), Self::Error> {
        session.data(channel, data.to_vec())?;
        Ok(())
    }
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

/// Startet den Server auf einem freien Port und gibt Port und Host-Schlüssel zurück.
pub async fn start_server(allowed: PublicKey, port: u16) -> (u16, PublicKey) {
    let host_key = new_key();
    let public = host_key.public_key().clone();
    let config = Arc::new(server::Config {
        keys: vec![host_key],
        auth_rejection_time: Duration::from_millis(10),
        auth_rejection_time_initial: Some(Duration::ZERO),
        ..Default::default()
    });
    let socket = TcpListener::bind(("127.0.0.1", port)).await.unwrap();
    let port = socket.local_addr().unwrap().port();
    tokio::spawn(async move {
        let mut server = Echo { allowed };
        server.run_on_socket(config, &socket).await.unwrap();
    });
    (port, public)
}
