//! On-device SSH keypair generation for the mobile switchboard — the Termius flow: generate
//! a key in-app, keep the private half in the OS keystore (iOS Keychain), and show the user
//! the public half to paste into the server's `~/.ssh/authorized_keys`. Pure Rust (ed25519
//! via ssh-key, entropy via getrandom) so it cross-compiles to iOS with no extra deps.
use russh::keys::ssh_key::{private::Ed25519Keypair, HashAlg, LineEnding, PrivateKey};

/// A freshly generated keypair. The private half is OpenSSH PEM (store it in the Keychain);
/// the public half is an `authorized_keys` line (show it to the user); the fingerprint is for
/// display/confirmation.
pub struct GeneratedKey {
    pub private_openssh: String,
    pub public_openssh: String,
    pub fingerprint: String,
}

/// Generate an ed25519 keypair with `comment` as its identity label (e.g. `vibestudio@iphone`).
pub fn generate_ed25519(comment: &str) -> Result<GeneratedKey, String> {
    let mut seed = [0u8; 32];
    getrandom::getrandom(&mut seed).map_err(|e| format!("could not gather entropy: {e}"))?;
    let mut key = PrivateKey::from(Ed25519Keypair::from_seed(&seed));
    key.set_comment(comment);

    let private_openssh = key
        .to_openssh(LineEnding::LF)
        .map_err(|e| format!("could not encode the private key: {e}"))?
        .to_string();
    let public_openssh = key
        .public_key()
        .to_openssh()
        .map_err(|e| format!("could not encode the public key: {e}"))?;
    let fingerprint = key.fingerprint(HashAlg::Sha256).to_string();

    Ok(GeneratedKey { private_openssh, public_openssh, fingerprint })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generates_a_loadable_ed25519_keypair() {
        let k = generate_ed25519("vibestudio@test").expect("keygen");

        assert!(k.private_openssh.starts_with("-----BEGIN OPENSSH PRIVATE KEY-----"), "PEM private: {}", k.private_openssh);
        assert!(k.public_openssh.starts_with("ssh-ed25519 "), "authorized_keys line: {}", k.public_openssh);
        assert!(k.public_openssh.trim_end().ends_with("vibestudio@test"), "carries the comment: {}", k.public_openssh);
        assert!(k.fingerprint.starts_with("SHA256:"), "fingerprint: {}", k.fingerprint);

        // Round-trip: the private key parses back (the same path russh auth uses) and its
        // public half matches what we handed the user.
        let parsed = russh::keys::decode_secret_key(&k.private_openssh, None).expect("re-parse private key");
        assert_eq!(parsed.public_key().to_openssh().unwrap(), k.public_openssh, "public key must match the private");

        // Real entropy → two calls differ.
        let k2 = generate_ed25519("vibestudio@test").expect("keygen2");
        assert_ne!(k.private_openssh, k2.private_openssh, "each generation must be unique");
    }
}
