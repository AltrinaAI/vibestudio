//! The secret-storage interface + platform strategy, in the [`crate::agents`]
//! spirit: one capability, wired for the platforms that have it and degrading to
//! a built-in default everywhere else.
//!
//! The mobile switchboard needs to keep SSH connection profiles and their
//! private keys. The *ideal* home for a private key is an OS keystore (the iOS /
//! macOS Keychain), but not every platform VibeStudio runs on has one wired up
//! (Android has no backend yet; a headless Linux box or the standalone dev
//! server may have no Secret Service). So this module defines:
//!
//! - [`SecureStore`] — the interface every backend implements,
//! - [`SshProfile`] — the non-secret half of a saved connection,
//! - [`FileSecureStore`] — the always-available fallback: profiles as JSON, keys
//!   in a sibling `0600` file. Its trust model is the same as `~/.ssh/id_ed25519`
//!   (a private file on a machine the user controls) — sufficient for a
//!   self-hosted server or a dev loop, and the honest floor when there is no
//!   OS keystore to lean on.
//! - [`resolve`] — the selection policy: use the platform's native store if the
//!   caller wired one, else the file fallback.
//!
//! The native backends live where their platform deps do (the Apple Keychain
//! impl is in `client/desktop`, behind the same one-way dependency rule as the
//! notifier/editor). The caller passes its `platform_native()` result to
//! [`resolve`]; this crate owns only the fallback and the policy, so it stays
//! pure. Adding a new platform's native store = wiring one more arm there and
//! passing it in — nothing here changes.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/// A saved SSH connection profile (the mobile switchboard's equivalent of a
/// `~/.ssh/config` entry — iOS has no `~/.ssh`). The non-secret half only: the
/// private key lives in the keystore behind [`SecureStore`], keyed by `id`.
#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct SshProfile {
    /// Stable connection id, `user@host:port` — the exact string the UI passes to
    /// `/api/remote/connect`, so the switchboard can resolve credentials from it.
    pub id: String,
    pub host: String,
    pub port: u16,
    pub user: String,
}

/// Credential storage for the mobile switchboard's russh transport: connection
/// profiles plus their private keys. A server without one (desktop, standalone
/// without `--mobile-dev`) 404s the profile routes and the SPA never shows the
/// credential UI. Reached only over the pinned-local `/api/remote/profiles*`
/// routes — a device's credentials never leave it.
pub trait SecureStore: Send + Sync {
    fn list_profiles(&self) -> Result<Vec<SshProfile>, String>;
    fn get_profile(&self, id: &str) -> Result<Option<SshProfile>, String>;
    /// Persist the profile and stash `private_key` (OpenSSH text) under the
    /// profile's id. Overwrites an existing profile.
    fn put_profile(&self, profile: &SshProfile, private_key: &str) -> Result<(), String>;
    /// Remove the profile and its key. Ok if absent.
    fn delete_profile(&self, id: &str) -> Result<(), String>;
    /// The OpenSSH private key for `id`, or `None` if there is no entry.
    fn get_private_key(&self, id: &str) -> Result<Option<String>, String>;
}

/// Select the SecureStore to use: the platform's native keystore when the caller
/// wired one (iOS/macOS Keychain), else the file fallback under `config_dir`.
///
/// The fallback also catches a native store that failed to initialise — e.g. an
/// iOS Keychain that won't open — so the app degrades to an app-private sandbox
/// file instead of failing to start. That's a deliberate robustness-over-purity
/// call: the loss is at-rest encryption, not confidentiality (the sandbox file
/// is already private to the app / the user's account).
pub fn resolve(
    native: Option<Arc<dyn SecureStore>>,
    config_dir: &Path,
) -> Result<Arc<dyn SecureStore>, String> {
    match native {
        Some(s) => Ok(s),
        None => Ok(Arc::new(FileSecureStore::new(config_dir)?)),
    }
}

/// The built-in fallback: profiles in `<dir>/ssh_profiles.json` (same shape the
/// Keychain store uses), private keys in `<dir>/ssh_keys.json` at `0600`. Both
/// writes are temp-then-rename so a mid-write crash can't truncate either file.
pub struct FileSecureStore {
    profiles_path: PathBuf,
    keys_path: PathBuf,
    /// Serialises read-modify-write across both files.
    lock: Mutex<()>,
}

impl FileSecureStore {
    pub fn new(dir: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(dir).map_err(|e| format!("Couldn't create the config dir: {e}"))?;
        Ok(Self {
            profiles_path: dir.join("ssh_profiles.json"),
            keys_path: dir.join("ssh_keys.json"),
            lock: Mutex::new(()),
        })
    }

    fn read_profiles(&self) -> Result<Vec<SshProfile>, String> {
        read_json(&self.profiles_path, "saved connections")
    }

    fn read_keys(&self) -> Result<std::collections::BTreeMap<String, String>, String> {
        read_json(&self.keys_path, "saved keys")
    }

    fn write_profiles(&self, profiles: &[SshProfile]) -> Result<(), String> {
        write_json(&self.profiles_path, profiles, false)
    }

    fn write_keys(&self, keys: &std::collections::BTreeMap<String, String>) -> Result<(), String> {
        // 0600: the keys file holds private-key material.
        write_json(&self.keys_path, keys, true)
    }
}

impl SecureStore for FileSecureStore {
    fn list_profiles(&self) -> Result<Vec<SshProfile>, String> {
        let _g = self.lock.lock().unwrap();
        self.read_profiles()
    }

    fn get_profile(&self, id: &str) -> Result<Option<SshProfile>, String> {
        let _g = self.lock.lock().unwrap();
        Ok(self.read_profiles()?.into_iter().find(|p| p.id == id))
    }

    fn put_profile(&self, profile: &SshProfile, private_key: &str) -> Result<(), String> {
        let _g = self.lock.lock().unwrap();
        // Key first: if it can't be written, no profile is left pointing at a key
        // that isn't there (mirrors the Keychain store's ordering).
        let mut keys = self.read_keys()?;
        keys.insert(profile.id.clone(), private_key.to_string());
        self.write_keys(&keys)?;
        let mut profiles = self.read_profiles()?;
        profiles.retain(|p| p.id != profile.id);
        profiles.push(profile.clone());
        self.write_profiles(&profiles)
    }

    fn delete_profile(&self, id: &str) -> Result<(), String> {
        let _g = self.lock.lock().unwrap();
        let mut keys = self.read_keys()?;
        if keys.remove(id).is_some() {
            self.write_keys(&keys)?;
        }
        let mut profiles = self.read_profiles()?;
        profiles.retain(|p| p.id != id);
        self.write_profiles(&profiles)
    }

    fn get_private_key(&self, id: &str) -> Result<Option<String>, String> {
        let _g = self.lock.lock().unwrap();
        Ok(self.read_keys()?.remove(id))
    }
}

/// Read a JSON file, treating "not found" as an empty value (`T::default`).
fn read_json<T: serde::de::DeserializeOwned + Default>(path: &Path, what: &str) -> Result<T, String> {
    match std::fs::read_to_string(path) {
        Ok(s) => serde_json::from_str(&s).map_err(|e| format!("The {what} file is unreadable: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(T::default()),
        Err(e) => Err(format!("Couldn't read the {what}: {e}")),
    }
}

/// Serialise `value` to `path` via a temp file + rename. When `private`, the
/// temp file is created `0600` on Unix before the rename so the secret is never
/// briefly world-readable.
fn write_json<T: serde::Serialize + ?Sized>(path: &Path, value: &T, private: bool) -> Result<(), String> {
    let json = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, &json).map_err(|e| format!("Couldn't write {}: {e}", path.display()))?;
    if private {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))
                .map_err(|e| format!("Couldn't secure {}: {e}", tmp.display()))?;
        }
    }
    std::fs::rename(&tmp, path).map_err(|e| format!("Couldn't write {}: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store(tag: &str) -> (FileSecureStore, PathBuf) {
        let dir = std::env::temp_dir().join(format!("vibestudio-filestore-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        (FileSecureStore::new(&dir).unwrap(), dir)
    }

    fn profile(id: &str) -> SshProfile {
        SshProfile { id: id.into(), host: "pi.local".into(), port: 22, user: "harvey".into() }
    }

    #[test]
    fn roundtrip_put_get_overwrite_delete() {
        let (s, dir) = store("roundtrip");
        let id = "harvey@pi.local:22";

        assert!(s.list_profiles().unwrap().is_empty());
        assert_eq!(s.get_private_key(id).unwrap(), None);
        s.delete_profile(id).expect("deleting a missing profile is fine");

        s.put_profile(&profile(id), "-----KEY ONE-----").unwrap();
        assert_eq!(s.list_profiles().unwrap().len(), 1);
        assert_eq!(s.get_profile(id).unwrap().unwrap().host, "pi.local");
        assert_eq!(s.get_private_key(id).unwrap().as_deref(), Some("-----KEY ONE-----"));

        s.put_profile(&profile(id), "-----KEY TWO-----").unwrap();
        assert_eq!(s.list_profiles().unwrap().len(), 1, "overwrite must not duplicate");
        assert_eq!(s.get_private_key(id).unwrap().as_deref(), Some("-----KEY TWO-----"));

        s.delete_profile(id).unwrap();
        assert!(s.list_profiles().unwrap().is_empty());
        assert_eq!(s.get_private_key(id).unwrap(), None);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn keys_live_in_a_separate_file_never_the_profiles_json() {
        let (s, dir) = store("split");
        let id = "harvey@pi.local:22";
        s.put_profile(&profile(id), "TOP-SECRET-KEY-BYTES").unwrap();
        let profiles = std::fs::read_to_string(&s.profiles_path).unwrap();
        assert!(!profiles.contains("TOP-SECRET"), "key must never land in the profiles JSON: {profiles}");
        assert!(std::fs::read_to_string(&s.keys_path).unwrap().contains("TOP-SECRET"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(unix)]
    #[test]
    fn keys_file_is_0600() {
        use std::os::unix::fs::PermissionsExt;
        let (s, dir) = store("perms");
        s.put_profile(&profile("harvey@pi.local:22"), "k").unwrap();
        let mode = std::fs::metadata(&s.keys_path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600, "keys file must be owner-only");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn resolve_uses_file_fallback_when_no_native() {
        let dir = std::env::temp_dir().join(format!("vibestudio-resolve-{}", std::process::id()));
        let store = resolve(None, &dir).unwrap();
        store.put_profile(&profile("u@h:22"), "key").unwrap();
        assert_eq!(store.get_private_key("u@h:22").unwrap().as_deref(), Some("key"));
        let _ = std::fs::remove_dir_all(dir);
    }
}
