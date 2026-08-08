//! Seller-side tool: generate the signing keypair once, then mint licence keys.
//!
//! An `example` rather than a `[[bin]]` so it never builds as part of the app — it exists on
//! your machine only, and the private key must never reach a customer's.
//!
//!   cargo run --example license_tool -- keygen
//!   CS_PRIVATE_KEY=<hex> cargo run --example license_tool -- issue commercial "Jane Doe"
//!
//! `keygen` prints the public half to paste into `PUBLIC_KEY` in `src/license.rs`, and the
//! private half to keep somewhere safe and offline. Anyone with the private key can mint
//! licences; anyone with only the public key can merely check them.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use ed25519_dalek::{Signer, SigningKey};

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn hex_decode(s: &str) -> Result<Vec<u8>, String> {
    let s = s.trim();
    if s.len() % 2 != 0 {
        return Err("private key must be an even number of hex digits".into());
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).map_err(|e| e.to_string()))
        .collect()
}

fn keygen() {
    let signing = SigningKey::generate(&mut rand_core::OsRng);
    let public = signing.verifying_key().to_bytes();

    println!("PRIVATE KEY (keep secret, never commit, never ship):");
    println!("  {}\n", hex_encode(&signing.to_bytes()));
    println!("Paste this into PUBLIC_KEY in src-tauri/src/license.rs:\n");
    println!("const PUBLIC_KEY: [u8; 32] = [");
    for chunk in public.chunks(8) {
        let row: Vec<String> = chunk.iter().map(|b| format!("0x{b:02x}")).collect();
        println!("    {},", row.join(", "));
    }
    println!("];");
}

fn issue(kind: &str, name: &str) -> Result<String, String> {
    let secret = std::env::var("CS_PRIVATE_KEY")
        .map_err(|_| "set CS_PRIVATE_KEY to the hex private key from `keygen`".to_string())?;
    let bytes = hex_decode(&secret)?;
    let bytes: [u8; 32] = bytes
        .try_into()
        .map_err(|_| "private key must be 32 bytes (64 hex digits)".to_string())?;
    let signing = SigningKey::from_bytes(&bytes);

    let kind_byte = match kind {
        "personal" => 1u8,
        "commercial" => 2u8,
        other => return Err(format!("unknown kind {other:?} — use personal or commercial")),
    };
    if name.trim().is_empty() {
        return Err("name must not be empty — it is shown in the app".into());
    }

    // Days since the Unix epoch; matches what license.rs reads back.
    let days = (chrono::Utc::now().timestamp() / 86_400) as u32;

    let mut payload = vec![1u8, kind_byte];
    payload.extend_from_slice(&days.to_le_bytes());
    payload.extend_from_slice(name.trim().as_bytes());

    let signature = signing.sign(&payload);
    let mut blob = payload;
    blob.extend_from_slice(&signature.to_bytes());
    Ok(URL_SAFE_NO_PAD.encode(blob))
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("keygen") => keygen(),
        Some("issue") => {
            let (Some(kind), Some(name)) = (args.get(1), args.get(2)) else {
                eprintln!("usage: issue <personal|commercial> \"<name or email>\"");
                std::process::exit(2);
            };
            match issue(kind, name) {
                Ok(key) => {
                    println!("Licence for {name} ({kind}):\n");
                    println!("{key}");
                }
                Err(e) => {
                    eprintln!("error: {e}");
                    std::process::exit(1);
                }
            }
        }
        _ => {
            eprintln!("usage:");
            eprintln!("  cargo run --example license_tool -- keygen");
            eprintln!(
                "  CS_PRIVATE_KEY=<hex> cargo run --example license_tool -- issue commercial \"Jane Doe\""
            );
            std::process::exit(2);
        }
    }
}
