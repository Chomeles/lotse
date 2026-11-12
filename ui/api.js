// Alle Aufrufe ans Rust-Backend an einer Stelle.
const { invoke, Channel } = window.__TAURI__.core;

export const api = {
  storeLoad: () => invoke('store_load'),
  storeSave: (store) => invoke('store_save', { store }),
  hostsImport: (existing) => invoke('hosts_import', { existing }),
  knownHostRemove: (address, port) => invoke('known_host_remove', { address, port }),
  // Liefert [{ address, port, kind, fingerprint }].
  knownHostsList: () => invoke('known_hosts_list'),

  // Liefert [{ path, name, kind, fingerprint, encrypted, hosts }]. Leerer `fingerprint` = Datei fehlt oder ist nicht lesbar.
  keysList: (hosts) => invoke('keys_list', { hosts }),
  keyPublic: (path) => invoke('key_public', { path }),
  // Liefert den Pfad des neuen Schlüssels in ~/.ssh.
  keyGenerate: (name, passphrase) => invoke('key_generate', { name, passphrase }),
  keyDelete: (path) => invoke('key_delete', { path }),

  // Liefert die Verbindungsnummer. `secret` ist die Passphrase des Schlüssels oder das Passwort;
  // `remember` speichert es nach geglückter Anmeldung dauerhaft.
  // `onData` bekommt Bytes der Shell, `onClose` meldet das Ende.
  sshConnect(host, { secret, remember, trust, cols, rows }, onData, onClose) {
    const channel = new Channel();
    channel.onmessage = (msg) => {
      if (msg instanceof ArrayBuffer) onData(new Uint8Array(msg));
      else if (Array.isArray(msg)) onData(Uint8Array.from(msg));
      else if (msg?.closed) onClose();
    };
    return invoke('ssh_connect', { host, secret, remember, trust, cols, rows, onData: channel });
  },
  sshWrite: (id, data) => invoke('ssh_write', { id, data }),
  sshResize: (id, cols, rows) => invoke('ssh_resize', { id, cols, rows }),
  sshDisconnect: (id) => invoke('ssh_disconnect', { id }),

  // `path = null` ist der Startordner. Liefert { path, entries }.
  sftpList: (id, path) => invoke('sftp_list', { id, path }),
  sftpRename: (id, from, to) => invoke('sftp_rename', { id, from, to }),
  sftpMkdir: (id, path) => invoke('sftp_mkdir', { id, path }),
  sftpDelete: (id, path, isDir) => invoke('sftp_delete', { id, path, isDir }),
  // `onProgress` bekommt Prozent von 0 bis 100.
  sftpUpload: (id, local, remote, onProgress) =>
    invoke('sftp_upload', { id, local, remote, onProgress: progress(onProgress) }),
  sftpDownload: (id, remote, local, onProgress) =>
    invoke('sftp_download', { id, remote, local, onProgress: progress(onProgress) }),

  // Datei oder Bild der Zwischenablage in den Ordner `dir` auf dem Server legen. Liefert den Pfad als Text fürs
  // Terminal (pasteImage: null, wenn kein Bild da ist). `transfer` ist eine frei gewählte Nummer zum Abbrechen.
  pasteFile: (id, transfer, local, dir, onProgress) =>
    invoke('paste_file', { id, transfer, local, dir, onProgress: progress(onProgress) }),
  pasteImage: (id, transfer, dir, name, onProgress) =>
    invoke('paste_image', { id, transfer, dir, name, onProgress: progress(onProgress) }),
  transferCancel: (transfer) => invoke('transfer_cancel', { transfer }),
};

function progress(onProgress) {
  const channel = new Channel();
  channel.onmessage = onProgress;
  return channel;
}
