//! HTTP-сервис crypto-core.
//!
//! Go-бэкенд обращается сюда, когда задан `CRYPTO_CORE_URL`
//! (docs/architecture.md §2.2): скоринг антифрода, проверка лимитов и
//! крипто-операции. Если ядро недоступно, Go переключается на встроенный
//! fallback — поэтому форматы обязаны совпадать побайтово.
//!
//! Запуск: `crypto-core 0.0.0.0:8091`, KEK — из `SITEED_KEK_HEX` (64 hex).

use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use sitee_crypto_core::base64;
use sitee_crypto_core::envelope::Core;
use sitee_crypto_core::fraud::{self, Signals};
use sitee_crypto_core::json::{self, Value};
use sitee_crypto_core::ratelimit::{self, Limiter};
use sitee_crypto_core::solana;
use sitee_crypto_core::totp;

/// Максимальный размер тела запроса (1 МиБ).
const MAX_BODY: usize = 1 << 20;

fn main() {
    let addr = std::env::args()
        .nth(1)
        .or_else(|| std::env::var("CRYPTO_CORE_ADDR").ok())
        .unwrap_or_else(|| "0.0.0.0:8091".to_string());
    let kek_hex = std::env::var("SITEED_KEK_HEX").unwrap_or_default();
    let kek = hex_bytes(&kek_hex).filter(|v| v.len() == 32);
    let kek = match kek {
        Some(v) => v,
        None => {
            eprintln!("SITEED_KEK_HEX должен содержать 32 байта (64 hex-символа)");
            std::process::exit(2);
        }
    };
    let core = match Core::new(&kek) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("crypto-core: {e}");
            std::process::exit(2);
        }
    };
    let core = Arc::new(core);
    let limiter = Arc::new(Mutex::new(Limiter::new()));
    let listener = match TcpListener::bind(&addr) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("crypto-core: не слушать {addr}: {e}");
            std::process::exit(1);
        }
    };
    eprintln!("crypto-core слушает {addr} (KEK fp={})", core.fingerprint());
    for stream in listener.incoming() {
        match stream {
            Ok(mut s) => {
                let core = Arc::clone(&core);
                let limiter = Arc::clone(&limiter);
                thread::spawn(move || {
                    if let Err(e) = serve(&mut s, &core, &limiter) {
                        eprintln!("crypto-core: соединение: {e}");
                    }
                });
            }
            Err(e) => eprintln!("crypto-core: accept: {e}"),
        }
    }
}

/// Обслуживает одно соединение: читает запрос и отвечает.
fn serve(
    stream: &mut std::net::TcpStream,
    core: &Core,
    limiter: &Mutex<Limiter>,
) -> std::io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(15)))?;
    let mut buf: Vec<u8> = Vec::with_capacity(4096);
    let mut chunk = [0u8; 8192];
    let split = loop {
        let n = stream.read(&mut chunk)?;
        if n == 0 {
            break None;
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(pos) = find(&buf, b"\r\n\r\n") {
            let head = String::from_utf8_lossy(&buf[..pos]).to_string();
            let len = header(&head, "content-length")
                .and_then(|v| v.trim().parse::<usize>().ok())
                .unwrap_or(0);
            if buf.len() >= pos + 4 + len || buf.len() > MAX_BODY {
                break Some(pos);
            }
        } else if buf.len() > MAX_BODY {
            break None;
        }
    };
    let pos = match split {
        Some(p) => p,
        None => return respond(stream, 400, "{\"error\":\"bad request\"}"),
    };
    let head = String::from_utf8_lossy(&buf[..pos]).to_string();
    let body = String::from_utf8_lossy(&buf[pos + 4..]).to_string();
    let mut lines = head.lines();
    let request_line = lines.next().unwrap_or_default();
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let path = parts.next().unwrap_or("").to_string();
    let (status, payload) = route(&method, &path, &body, core, limiter);
    respond(stream, status, &payload)
}

/// Маршрутизация.
fn route(
    method: &str,
    path: &str,
    body: &str,
    core: &Core,
    limiter: &Mutex<Limiter>,
) -> (u16, String) {
    if method == "GET" && (path == "/healthz" || path == "/") {
        return (200, "{\"status\":\"ok\"}".to_string());
    }
    if method != "POST" {
        return (405, "{\"error\":\"method not allowed\"}".to_string());
    }
    let req = match json::parse(body) {
        Ok(v) => v,
        Err(e) => return (400, format!("{{\"error\":\"bad json: {e}\"}}")),
    };
    let str_field = |key: &str| -> Option<String> {
        req.get(key).and_then(|v| v.as_str()).map(|s| s.to_string())
    };
    let num_field = |key: &str| -> Option<f64> { req.get(key).and_then(|v| v.as_f64()) };

    match path {
        "/v1/fraud/score" => {
            let signals = Signals {
                login_fails: num_field("login_fails").unwrap_or(0.0) as i32,
                ip_reputation: str_field("ip_reputation").unwrap_or_else(|| "clean".into()),
                geo_mismatch: req.get("geo_mismatch").and_then(|v| v.as_bool()).unwrap_or(false),
                new_device: req.get("new_device").and_then(|v| v.as_bool()).unwrap_or(false),
                account_age_hours: num_field("account_age_hours").unwrap_or(0.0) as i64,
                weak_password: req
                    .get("weak_password")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false),
                dispute_rate_pct: num_field("dispute_rate_pct").unwrap_or(0.0) as i32,
                registration_burst: num_field("registration_burst").unwrap_or(0.0) as i32,
                message_rate_per_min: num_field("message_rate_per_min").unwrap_or(0.0) as i32,
            };
            let res = fraud::score(&signals);
            let reasons: Vec<Value> = res.reasons.iter().cloned().map(Value::Str).collect();
            (
                200,
                Value::Obj(vec![
                    ("score".into(), Value::Num(res.score as f64)),
                    ("action".into(), Value::Str(res.action)),
                    ("reasons".into(), Value::Arr(reasons)),
                ])
                .to_string(),
            )
        }
        "/v1/ratelimit/check" => {
            let key = str_field("key").unwrap_or_default();
            let profile = match str_field("profile").as_deref() {
                Some("auth") => ratelimit::PROFILE_AUTH,
                Some("2fa") => ratelimit::PROFILE_2FA,
                Some("payment") => ratelimit::PROFILE_PAYMENT,
                Some("write") => ratelimit::PROFILE_WRITE,
                Some("admin") => ratelimit::PROFILE_ADMIN,
                Some("ws-connect") => ratelimit::PROFILE_WS_CONN,
                Some("ws-msg") => ratelimit::PROFILE_WS_MSG,
                Some("register") => ratelimit::PROFILE_REGISTER,
                Some("search") => ratelimit::PROFILE_SEARCH,
                _ => ratelimit::PROFILE_PUBLIC,
            };
            let mut guard = match limiter.lock() {
                Ok(g) => g,
                Err(p) => p.into_inner(),
            };
            let d = guard.allow(&key, profile);
            (
                200,
                Value::Obj(vec![
                    ("allowed".into(), Value::Bool(d.allowed)),
                    ("remaining".into(), Value::Num(d.remaining as f64)),
                    ("retry_after_secs".into(), Value::Num(d.retry_after_secs as f64)),
                    ("blocked".into(), Value::Bool(d.blocked)),
                    ("limit".into(), Value::Num(d.limit as f64)),
                    ("profile".into(), Value::Str(d.profile.to_string())),
                ])
                .to_string(),
            )
        }
        "/v1/crypto/encrypt" => {
            let (domain, object_id, plaintext) = match (
                str_field("domain"),
                str_field("object_id"),
                str_field("plaintext_b64"),
            ) {
                (Some(d), Some(o), Some(p)) => (d, o, p),
                _ => return (400, "{\"error\":\"нужны domain, object_id, plaintext_b64\"}".into()),
            };
            let plaintext = match base64::decode(&plaintext) {
                Ok(v) => v,
                Err(e) => return (400, format!("{{\"error\":\"{e}\"}}")),
            };
            match core.encrypt(&domain, &object_id, &plaintext) {
                Ok(blob) => json_ok(vec![("blob".into(), Value::Str(blob))]),
                Err(e) => (500, format!("{{\"error\":\"{e}\"}}")),
            }
        }
        "/v1/crypto/decrypt" => {
            let (domain, object_id, blob) = match (
                str_field("domain"),
                str_field("object_id"),
                str_field("blob"),
            ) {
                (Some(d), Some(o), Some(b)) => (d, o, b),
                _ => return (400, "{\"error\":\"нужны domain, object_id, blob\"}".into()),
            };
            match core.decrypt(&domain, &object_id, &blob) {
                Ok(bytes) => json_ok(vec![("plaintext_b64".into(), Value::Str(base64::encode(&bytes)))]),
                Err(e) => (400, format!("{{\"error\":\"{e}\"}}")),
            }
        }
        "/v1/crypto/blind-index" => {
            let value = str_field("value").unwrap_or_default();
            let idx = sitee_crypto_core::blind::blind_index_with(core, &value);
            json_ok(vec![("index".into(), Value::Str(idx))])
        }
        "/v1/crypto/password/hash" => {
            let password = str_field("password").unwrap_or_default();
            let check = req
                .get("policy")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let result = if check {
                sitee_crypto_core::pbkdf2::hash_password_checked(&password)
            } else {
                Ok(sitee_crypto_core::pbkdf2::hash_password(&password))
            };
            match result {
                Ok(encoded) => json_ok(vec![("encoded".into(), Value::Str(encoded))]),
                Err(e) => (400, format!("{{\"error\":\"{e}\"}}")),
            }
        }
        "/v1/crypto/password/verify" => {
            let password = str_field("password").unwrap_or_default();
            let encoded = str_field("encoded").unwrap_or_default();
            let ok = sitee_crypto_core::pbkdf2::verify_password(&password, &encoded);
            json_ok(vec![("ok".into(), Value::Bool(ok))])
        }
        "/v1/solana/address" => {
            let path = str_field("path").unwrap_or_default();
            match solana::address_of(core, &path) {
                Ok(address) => json_ok(vec![("address".into(), Value::Str(address))]),
                Err(e) => (400, format!("{{\"error\":\"{e}\"}}")),
            }
        }
        "/v1/solana/sign" => {
            let path = str_field("path").unwrap_or_default();
            let message = str_field("message_b64").unwrap_or_default();
            let purpose = str_field("purpose").unwrap_or_else(|| "withdraw".into());
            let purpose = match solana::Purpose::parse(&purpose) {
                Some(p) => p,
                None => return (400, "{\"error\":\"неизвестное назначение\"}".into()),
            };
            let message = match base64::decode(&message) {
                Ok(v) => v,
                Err(e) => return (400, format!("{{\"error\":\"{e}\"}}")),
            };
            let policy = solana::SignPolicy::default();
            match solana::sign_transaction(core, &path, &message, purpose, &policy) {
                Ok(sig) => json_ok(vec![("signature".into(), Value::Str(sig))]),
                Err(e) => (400, format!("{{\"error\":\"{e}\"}}")),
            }
        }
        "/v1/totp/validate" => {
            let secret = str_field("secret_b32").unwrap_or_default();
            let code = str_field("code").unwrap_or_default();
            let at = num_field("at").unwrap_or(0.0) as u64;
            let secret = match totp::decode_base32(&secret) {
                Ok(v) => v,
                Err(e) => return (400, format!("{{\"error\":\"{e}\"}}")),
            };
            match totp::validate_totp(&secret, &code, at, 1) {
                Some(step) => json_ok(vec![
                    ("ok".into(), Value::Bool(true)),
                    ("step".into(), Value::Num(step as f64)),
                ]),
                None => (200, "{\"ok\":false,\"step\":0}".to_string()),
            }
        }
        "/v1/totp/generate" => {
            let secret = str_field("secret_b32").unwrap_or_default();
            let at = num_field("at").unwrap_or(0.0) as u64;
            let secret = match totp::decode_base32(&secret) {
                Ok(v) => v,
                Err(e) => return (400, format!("{{\"error\":\"{e}\"}}")),
            };
            let code = totp::generate_totp(&secret, at);
            json_ok(vec![("code".into(), Value::Str(code))])
        }
        _ => (404, "{\"error\":\"not found\"}".to_string()),
    }
}

fn json_ok(fields: Vec<(String, Value)>) -> (u16, String) {
    (200, Value::Obj(fields).to_string())
}

/// Ответ клиенту.
fn respond(stream: &mut std::net::TcpStream, status: u16, body: &str) -> std::io::Result<()> {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        404 => "Not Found",
        405 => "Method Not Allowed",
        _ => "Internal Server Error",
    };
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes())?;
    stream.write_all(body.as_bytes())?;
    stream.flush()
}

/// Значение заголовка (без учёта регистра).
fn header(head: &str, name: &str) -> Option<String> {
    for line in head.lines().skip(1) {
        if let Some((k, v)) = line.split_once(':') {
            if k.trim().eq_ignore_ascii_case(name) {
                return Some(v.trim().to_string());
            }
        }
    }
    None
}

/// Поиск подстроки в байтах.
fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    (0..=haystack.len() - needle.len()).find(|&i| &haystack[i..i + needle.len()] == needle)
}

/// hex → байты.
fn hex_bytes(s: &str) -> Option<Vec<u8>> {
    let s = s.trim();
    if s.len() % 2 != 0 {
        return None;
    }
    let mut out = Vec::with_capacity(s.len() / 2);
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let hi = (bytes[i] as char).to_digit(16)?;
        let lo = (bytes[i + 1] as char).to_digit(16)?;
        out.push((hi * 16 + lo) as u8);
        i += 2;
    }
    Some(out)
}
