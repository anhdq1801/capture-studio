//! Client for the optional "Upload to Cloud" backend (see `server/`). Everything else in this
//! app is fully offline — this is the only module that makes network calls, and only when the
//! user explicitly logs in / uploads an item.

use crate::library::{default_library_dir, LibraryState};
use crate::models::{AccountStatus, MediaItem};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use tokio::fs::File;
use tokio_util::codec::{BytesCodec, FramedRead};

/// Set this to your deployed Worker URL (see server/README.md `npm run deploy`).
const API_BASE: &str = "https://capture-studio-api.YOUR_SUBDOMAIN.workers.dev";

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Session {
    token: String,
    email: String,
}

pub type CloudState = Mutex<Option<Session>>;

fn session_path() -> PathBuf {
    default_library_dir().join(".session.json")
}

/// Called once at startup (see lib.rs) so a previous login survives an app restart.
pub fn load_session() -> Option<Session> {
    let s = std::fs::read_to_string(session_path()).ok()?;
    serde_json::from_str(&s).ok()
}

fn save_session(session: &Session) -> Result<(), String> {
    let json = serde_json::to_string(session).map_err(|e| e.to_string())?;
    std::fs::write(session_path(), json).map_err(|e| e.to_string())
}

fn clear_session() {
    let _ = std::fs::remove_file(session_path());
}

#[derive(Deserialize)]
struct AuthResponse {
    token: String,
    email: String,
}

#[derive(Deserialize)]
struct ErrorResponse {
    error: String,
}

async fn parse_json<T: for<'de> Deserialize<'de>>(res: reqwest::Response) -> Result<T, String> {
    let status = res.status();
    let text = res.text().await.map_err(|e| e.to_string())?;
    if status.is_success() {
        serde_json::from_str::<T>(&text).map_err(|e| format!("Unexpected response: {e}"))
    } else {
        let msg = serde_json::from_str::<ErrorResponse>(&text)
            .map(|e| e.error)
            .unwrap_or(text);
        Err(msg)
    }
}

fn require_token(cloud: &tauri::State<'_, CloudState>) -> Result<String, String> {
    let guard = cloud.lock().map_err(|e| e.to_string())?;
    guard
        .as_ref()
        .map(|s| s.token.clone())
        .ok_or_else(|| "Not logged in".to_string())
}

async fn fetch_account_status(token: &str) -> Result<AccountStatus, String> {
    let res = Client::new()
        .get(format!("{API_BASE}/account/status"))
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    parse_json(res).await
}

// ---- Auth commands ----

#[tauri::command]
pub async fn cloud_signup(
    cloud: tauri::State<'_, CloudState>,
    email: String,
    password: String,
) -> Result<AccountStatus, String> {
    let res = Client::new()
        .post(format!("{API_BASE}/auth/signup"))
        .json(&serde_json::json!({ "email": email, "password": password }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let auth: AuthResponse = parse_json(res).await?;
    finish_login(cloud, auth).await
}

#[tauri::command]
pub async fn cloud_login(
    cloud: tauri::State<'_, CloudState>,
    email: String,
    password: String,
) -> Result<AccountStatus, String> {
    let res = Client::new()
        .post(format!("{API_BASE}/auth/login"))
        .json(&serde_json::json!({ "email": email, "password": password }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let auth: AuthResponse = parse_json(res).await?;
    finish_login(cloud, auth).await
}

async fn finish_login(
    cloud: tauri::State<'_, CloudState>,
    auth: AuthResponse,
) -> Result<AccountStatus, String> {
    let session = Session { token: auth.token, email: auth.email };
    save_session(&session)?;
    let status = fetch_account_status(&session.token).await?;
    *cloud.lock().map_err(|e| e.to_string())? = Some(session);
    Ok(status)
}

#[tauri::command]
pub fn cloud_logout(cloud: tauri::State<'_, CloudState>) -> Result<(), String> {
    clear_session();
    *cloud.lock().map_err(|e| e.to_string())? = None;
    Ok(())
}

#[tauri::command]
pub async fn get_account_status(
    cloud: tauri::State<'_, CloudState>,
) -> Result<Option<AccountStatus>, String> {
    let token = {
        let guard = cloud.lock().map_err(|e| e.to_string())?;
        guard.as_ref().map(|s| s.token.clone())
    };
    match token {
        None => Ok(None),
        Some(t) => fetch_account_status(&t).await.map(Some),
    }
}

// ---- Billing commands ----

#[derive(Deserialize)]
struct CheckoutUrlResponse {
    #[serde(alias = "approvalUrl", alias = "checkoutUrl")]
    url: String,
}

async fn post_for_checkout_url(
    token: &str,
    path: &str,
    body: serde_json::Value,
) -> Result<String, String> {
    let res = Client::new()
        .post(format!("{API_BASE}{path}"))
        .bearer_auth(token)
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let parsed: CheckoutUrlResponse = parse_json(res).await?;
    Ok(parsed.url)
}

#[tauri::command]
pub async fn create_paypal_subscription(
    cloud: tauri::State<'_, CloudState>,
    tier: String,
    interval: String,
) -> Result<String, String> {
    let token = require_token(&cloud)?;
    post_for_checkout_url(
        &token,
        "/billing/paypal/create-subscription",
        serde_json::json!({ "tier": tier, "interval": interval }),
    )
    .await
}

#[tauri::command]
pub async fn create_payos_payment(
    cloud: tauri::State<'_, CloudState>,
    tier: String,
    interval: String,
) -> Result<String, String> {
    let token = require_token(&cloud)?;
    post_for_checkout_url(
        &token,
        "/billing/payos/create-payment",
        serde_json::json!({ "tier": tier, "interval": interval }),
    )
    .await
}

/// Close the account and erase what the server holds: uploaded files, their links, and the
/// email address. The local session is dropped afterwards whatever the server said — the
/// token is worthless either way, and leaving it behind would show a signed-in account that
/// no longer exists.
///
/// Files in the local library are untouched. This deletes the cloud copies only.
#[tauri::command]
pub async fn delete_account(cloud: tauri::State<'_, CloudState>) -> Result<(), String> {
    let token = require_token(&cloud)?;
    let res = Client::new()
        .post(format!("{API_BASE}/account/delete"))
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let outcome: Result<serde_json::Value, String> = parse_json(res).await;

    clear_session();
    *cloud.lock().map_err(|e| e.to_string())? = None;

    outcome.map(|_| ())
}

/// The plan ladder. Unauthenticated on the server, so this needs no token — someone deciding
/// whether to sign up has to be able to see the prices first.
#[tauri::command]
pub async fn get_pricing() -> Result<crate::models::Pricing, String> {
    let res = Client::new()
        .get(format!("{API_BASE}/pricing"))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    parse_json(res).await
}

// ---- Upload ----

fn content_type_for(file_name: &str) -> &'static str {
    let ext = file_name.rsplit('.').next().unwrap_or("").to_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "mp4" => "video/mp4",
        _ => "application/octet-stream",
    }
}

#[derive(Deserialize)]
struct PresignResponse {
    #[serde(rename = "uploadUrl")]
    upload_url: String,
    #[serde(rename = "publicUrl")]
    public_url: String,
    #[serde(rename = "r2Key")]
    r2_key: String,
}

#[tauri::command]
pub async fn upload_item(
    cloud: tauri::State<'_, CloudState>,
    library: tauri::State<'_, LibraryState>,
    id: String,
) -> Result<MediaItem, String> {
    let token = require_token(&cloud)?;

    let (path, file_name, size_bytes) = {
        let lib = library.lock().map_err(|e| e.to_string())?;
        let item = lib.get(&id).ok_or_else(|| "Item not found".to_string())?;
        (lib.path_of(&item.file_name), item.file_name.clone(), item.size_bytes)
    };
    let content_type = content_type_for(&file_name);

    let presign_res = Client::new()
        .post(format!("{API_BASE}/upload/presign"))
        .bearer_auth(&token)
        .json(&serde_json::json!({
            "itemId": id,
            "fileName": file_name,
            "contentType": content_type,
            "sizeBytes": size_bytes,
        }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let presign: PresignResponse = parse_json(presign_res).await?;

    // Stream the file straight into the PUT body so large recordings never get fully
    // buffered in memory.
    let file = File::open(&path).await.map_err(|e| e.to_string())?;
    let stream = FramedRead::new(file, BytesCodec::new());
    let body = reqwest::Body::wrap_stream(stream);

    let put_res = Client::new()
        .put(&presign.upload_url)
        .header("content-type", content_type)
        .header("content-length", size_bytes)
        .body(body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !put_res.status().is_success() {
        return Err(format!("Upload failed: {}", put_res.status()));
    }

    let confirm_res = Client::new()
        .post(format!("{API_BASE}/upload/confirm"))
        .bearer_auth(&token)
        .json(&serde_json::json!({
            "itemId": id,
            "r2Key": presign.r2_key,
        }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !confirm_res.status().is_success() {
        return Err("Upload succeeded but could not be confirmed".to_string());
    }

    let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
    let public_url = presign.public_url;
    let mut lib = library.lock().map_err(|e| e.to_string())?;
    lib.update(&id, move |item| {
        item.cloud_url = Some(public_url);
        item.uploaded_at = Some(now);
    })
    .ok_or_else(|| "Item not found".to_string())
}

/// Delete an item's cloud copy, best-effort.
///
/// Called when the item is deleted locally. Failure is deliberately not fatal — the user
/// asked to delete a local file and should not be blocked by being offline or logged out.
/// Anything missed here is caught by the server's nightly sweep once the subscription lapses.
pub async fn delete_cloud_copy(token: &str, item_id: &str) -> Result<(), String> {
    let res = Client::new()
        .post(format!("{API_BASE}/upload/delete"))
        .bearer_auth(token)
        .json(&serde_json::json!({ "itemId": item_id }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if res.status().is_success() {
        Ok(())
    } else {
        Err(format!("Cloud delete failed: {}", res.status()))
    }
}

/// The stored session token, if there is one. `None` simply means "not logged in".
pub fn current_token(cloud: &tauri::State<'_, CloudState>) -> Option<String> {
    cloud.lock().ok().and_then(|g| g.as_ref().map(|s| s.token.clone()))
}
