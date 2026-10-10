//! PBKDF2-HMAC-SHA256 (RFC 8018) и формат хранения паролей.
//!
//! Формат строки: `pbkdf2-sha256$<итерации>$<salt_b64>$<hash_b64>` —
//! побайтово как в Go (`cryptod.HashPassword`) и Node (`crypto.mjs`).

use crate::base64;
use crate::hmac::hmac_sha256;
use crate::rand::random_bytes;
use crate::{timing_safe_equal, Error, Result, PBKDF2_ITERATIONS};

const SALT_LEN: usize = 16;
const HASH_LEN: usize = 32;

/// Выводит `key_len` байт (RFC 8018, шаги 1–7).
pub fn pbkdf2_sha256(password: &[u8], salt: &[u8], iter: u32, key_len: usize) -> Vec<u8> {
    let mut out: Vec<u8> = Vec::with_capacity(key_len + 32);
    let mut block: u32 = 1;
    while out.len() < key_len {
        let mut idx = [0u8; 4];
        idx.copy_from_slice(&block.to_be_bytes());
        let mut input = Vec::with_capacity(salt.len() + 4);
        input.extend_from_slice(salt);
        input.extend_from_slice(&idx);
        let mut u = hmac_sha256(password, &input);
        let mut acc = u;
        for _ in 1..iter.max(1) {
            u = hmac_sha256(password, &u);
            for i in 0..32 {
                acc[i] ^= u[i];
            }
        }
        out.extend_from_slice(&acc);
        block += 1;
    }
    out.truncate(key_len);
    out
}

/// Политика паролей (docs/security.md §2): длина, регистр, цифра, спецсимвол,
/// отсутствие «слабых» слов. Возвращает текст ошибки или `None`.
pub fn password_policy(pw: &str) -> Option<String> {
    let chars: Vec<char> = pw.chars().collect();
    if chars.len() < 10 {
        return Some("пароль должен быть не короче 10 символов".into());
    }
    if chars.len() > 128 {
        return Some("пароль длиннее 128 символов".into());
    }
    if !chars.iter().any(|c| c.is_lowercase()) {
        return Some("пароль должен содержать строчную букву".into());
    }
    if !chars.iter().any(|c| c.is_uppercase()) {
        return Some("пароль должен содержать заглавную букву".into());
    }
    if !chars.iter().any(|c| c.is_numeric()) {
        return Some("пароль должен содержать цифру".into());
    }
    if !chars.iter().any(|c| !c.is_alphanumeric()) {
        return Some("пароль должен содержать спецсимвол".into());
    }
    let lower = pw.to_lowercase();
    for weak in ["password", "qwerty", "123456", "sitee", "admin"] {
        if lower.contains(weak) {
            return Some(format!("пароль содержит слабое слово «{weak}»"));
        }
    }
    None
}

/// Хеш пароля со случайной солью (для регистрации и смены пароля).
pub fn hash_password(password: &str) -> String {
    let salt = random_bytes(SALT_LEN);
    let hash = pbkdf2_sha256(password.as_bytes(), &salt, PBKDF2_ITERATIONS, HASH_LEN);
    format!(
        "pbkdf2-sha256${PBKDF2_ITERATIONS}${}${}",
        base64::encode(&salt),
        base64::encode(&hash)
    )
}

/// Проверка пароля против сохранённой строки (сравнение за постоянное время).
pub fn verify_password(password: &str, encoded: &str) -> bool {
    let parts: Vec<&str> = encoded.split('$').collect();
    if parts.len() != 4 || parts[0] != "pbkdf2-sha256" {
        return false;
    }
    let iter: u32 = match parts[1].parse() {
        Ok(v) if v > 0 => v,
        _ => return false,
    };
    let salt = match base64::decode(parts[2]) {
        Ok(v) => v,
        Err(_) => return false,
    };
    let expected = match base64::decode(parts[3]) {
        Ok(v) => v,
        Err(_) => return false,
    };
    if expected.is_empty() || expected.len() > 1024 {
        return false;
    }
    let actual = pbkdf2_sha256(password.as_bytes(), &salt, iter, expected.len());
    timing_safe_equal(&actual, &expected)
}

/// Нужно ли перехешировать при входе (итерации ниже текущих).
pub fn needs_rehash(encoded: &str) -> bool {
    match encoded.split('$').nth(1).and_then(|v| v.parse::<u32>().ok()) {
        Some(iter) => iter < PBKDF2_ITERATIONS,
        None => true,
    }
}

/// Хеш пароля с ошибкой при несоответствии политике (как в Go API).
pub fn hash_password_checked(password: &str) -> Result<String> {
    match password_policy(password) {
        Some(msg) => Err(Error::Other(msg)),
        None => Ok(hash_password(password)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rfc6070_vector() {
        // PBKDF2-HMAC-SHA1 из RFC 6070 для сверки алгоритма на SHA-1
        // здесь не применим, поэтому проверяем SHA-256 известным вектором:
        // password="password", salt="salt", c=1, dkLen=32.
        let dk = pbkdf2_sha256(b"password", b"salt", 1, 32);
        assert_eq!(
            crate::to_hex(&dk),
            "120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b"
        );
    }

    #[test]
    fn password_roundtrip() {
        let enc = hash_password("SuperSecret#2026");
        assert!(enc.starts_with("pbkdf2-sha256$"));
        assert!(verify_password("SuperSecret#2026", &enc));
        assert!(!verify_password("SuperSecret#2027", &enc));
        assert!(!needs_rehash(&enc));
    }

    #[test]
    fn policy_rejects_weak() {
        assert!(password_policy("short").is_some());
        assert!(password_policy("alllowercase1!").is_some());
        assert!(password_policy("ALLUPPERCASE1!").is_some());
        assert!(password_policy("NoDigitsHere!!").is_some());
        assert!(password_policy("NoSpecial1234").is_some());
        assert!(password_policy("MyPassword#2026").is_some());
        assert!(password_policy("Str0ng#Passphrase").is_none());
    }

    #[test]
    fn malformed_encoded_rejected() {
        assert!(!verify_password("x", ""));
        assert!(!verify_password("x", "md5$1$aa$bb"));
        assert!(!verify_password("x", "pbkdf2-sha256$0$aa$bb"));
        assert!(needs_rehash("pbkdf2-sha256$1000$aa$bb"));
    }
}
