//! The shell's half of [`skill_server::SecureStore`] — the mobile switchboard's
//! SSH credential store. Profiles (host/port/user — nothing secret) live as JSON
//! in the app config dir; **private keys live in the OS Keychain** via the
//! `keyring` crate (Security.framework on iOS and macOS), keyed by the profile's
//! connection id. Same one-way dependency rule as `ShellNotifier`: the trait is
//! the server's, the OS-keystore implementation is the client shell's.
//!
//! Compiled for macOS as well as iOS so the exact Keychain code path is
//! unit-testable on a Mac; only the mobile setup wires it into the server.
use std::path::PathBuf;
use std::sync::Mutex;

use skill_server::{SecureStore, SshProfile};

/// Keychain service the keys are filed under (one generic-password item per
/// profile id). Namespaced by bundle id so nothing else collides with it.
const SERVICE: &str = "one.vibestudio.app.ssh-keys";

pub struct KeychainStore {
    /// The non-secret profile list (JSON). Never holds key material.
    profiles_path: PathBuf,
    /// Keychain service name (a test substitutes its own to stay isolated).
    service: String,
    /// Serializes read-modify-write of the profiles file.
    lock: Mutex<()>,
}

impl KeychainStore {
    pub fn new() -> Result<Self, String> {
        Ok(Self {
            profiles_path: skill_core::paths::ensure_config_dir()?.join("ssh_profiles.json"),
            service: SERVICE.into(),
            lock: Mutex::new(()),
        })
    }

    fn read(&self) -> Result<Vec<SshProfile>, String> {
        match std::fs::read_to_string(&self.profiles_path) {
            Ok(s) => serde_json::from_str(&s)
                .map_err(|e| format!("The saved-connections file is unreadable: {e}")),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
            Err(e) => Err(format!("Couldn't read the saved connections: {e}")),
        }
    }

    /// Write-temp-then-rename so a mid-write crash can't truncate the list.
    fn write(&self, profiles: &[SshProfile]) -> Result<(), String> {
        let json = serde_json::to_string_pretty(profiles).map_err(|e| e.to_string())?;
        let tmp = self.profiles_path.with_extension("json.tmp");
        std::fs::write(&tmp, json).map_err(|e| format!("Couldn't save the connection: {e}"))?;
        std::fs::rename(&tmp, &self.profiles_path)
            .map_err(|e| format!("Couldn't save the connection: {e}"))
    }

    fn entry(&self, id: &str) -> Result<keyring::Entry, String> {
        keyring::Entry::new(&self.service, id)
            .map_err(|e| format!("The keystore is unavailable: {e}"))
    }
}

impl SecureStore for KeychainStore {
    fn list_profiles(&self) -> Result<Vec<SshProfile>, String> {
        let _g = self.lock.lock().unwrap();
        self.read()
    }

    fn get_profile(&self, id: &str) -> Result<Option<SshProfile>, String> {
        let _g = self.lock.lock().unwrap();
        Ok(self.read()?.into_iter().find(|p| p.id == id))
    }

    fn put_profile(&self, profile: &SshProfile, private_key: &str) -> Result<(), String> {
        let _g = self.lock.lock().unwrap();
        // Key first: if the Keychain refuses, no profile is left pointing at a
        // key that isn't there.
        self.entry(&profile.id)?
            .set_password(private_key)
            .map_err(|e| format!("Couldn't store the key in the keystore: {e}"))?;
        let mut profiles = self.read()?;
        profiles.retain(|p| p.id != profile.id);
        profiles.push(profile.clone());
        self.write(&profiles)
    }

    fn delete_profile(&self, id: &str) -> Result<(), String> {
        let _g = self.lock.lock().unwrap();
        match self.entry(id)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(e) => return Err(format!("Couldn't remove the key from the keystore: {e}")),
        }
        let mut profiles = self.read()?;
        profiles.retain(|p| p.id != id);
        self.write(&profiles)
    }

    fn get_private_key(&self, id: &str) -> Result<Option<String>, String> {
        match self.entry(id)?.get_password() {
            Ok(key) => Ok(Some(key)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(format!("Couldn't read the key from the keystore: {e}")),
        }
    }
}

// Round-trips against the REAL keychain (macOS here; the same Security.framework
// path serves iOS), under a test-only service name and a temp profiles file so
// nothing touches the app's real store.
#[cfg(test)]
mod tests {
    use super::*;

    fn test_store(tag: &str) -> KeychainStore {
        let dir = std::env::temp_dir().join(format!("vibestudio-securestore-{}-{tag}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        KeychainStore {
            profiles_path: dir.join("ssh_profiles.json"),
            service: format!("one.vibestudio.test.{}-{tag}", std::process::id()),
            lock: Mutex::new(()),
        }
    }

    fn profile(id: &str) -> SshProfile {
        SshProfile { id: id.into(), host: "pi.local".into(), port: 22, user: "harvey".into() }
    }

    #[test]
    fn keychain_roundtrip_put_get_overwrite_delete() {
        let store = test_store("roundtrip");
        let id = "harvey@pi.local:22";

        // Empty store: no profiles, no key, delete is a no-op.
        assert!(store.list_profiles().unwrap().is_empty());
        assert_eq!(store.get_private_key(id).unwrap(), None);
        store.delete_profile(id).expect("deleting a missing profile is fine");

        // Put → both halves land.
        store.put_profile(&profile(id), "-----KEY ONE-----").unwrap();
        assert_eq!(store.list_profiles().unwrap().len(), 1);
        assert_eq!(store.get_profile(id).unwrap().unwrap().host, "pi.local");
        assert_eq!(store.get_private_key(id).unwrap().as_deref(), Some("-----KEY ONE-----"));

        // Overwrite: still ONE profile, the key is the new one.
        store.put_profile(&profile(id), "-----KEY TWO-----").unwrap();
        assert_eq!(store.list_profiles().unwrap().len(), 1, "overwrite must not duplicate");
        assert_eq!(store.get_private_key(id).unwrap().as_deref(), Some("-----KEY TWO-----"));

        // Delete removes both halves.
        store.delete_profile(id).unwrap();
        assert!(store.list_profiles().unwrap().is_empty());
        assert_eq!(store.get_private_key(id).unwrap(), None);

        let _ = std::fs::remove_dir_all(store.profiles_path.parent().unwrap());
    }

    #[test]
    fn profiles_file_never_contains_key_material() {
        let store = test_store("no-key-on-disk");
        let id = "harvey@pi.local:22";
        store.put_profile(&profile(id), "TOP-SECRET-KEY-BYTES").unwrap();
        let on_disk = std::fs::read_to_string(&store.profiles_path).unwrap();
        assert!(!on_disk.contains("TOP-SECRET"), "key must never land in the JSON: {on_disk}");
        store.delete_profile(id).unwrap();
        let _ = std::fs::remove_dir_all(store.profiles_path.parent().unwrap());
    }
}
