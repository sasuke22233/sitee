// SITEE crypto core — базовые примитивы, реализованные только на std.
//
// Почему вручную: ядро не тянет внешние крейты, поэтому SHA-256, SHA-512,
// HMAC, HKDF и PBKDF2 написаны здесь. Форматы совпадают с Go (backend/internal/
// cryptod) и с preview-зеркалом (tools/preview/crypto.mjs) — это проверяется
// тестами tests/interop.rs.

pub mod base64;
pub mod json;
pub mod rand;
pub mod sha1;
pub mod sha256;
pub mod sha512;
pub mod hmac;
pub mod hkdf;
pub mod pbkdf2;
pub mod aes256;
pub mod gcm;
pub mod envelope;
pub mod blind;
pub mod totp;
pub mod ed25519;
pub mod solana;
pub mod safety;
pub mod audit;
pub mod dispute;
pub mod fraud;
pub mod ratelimit;

pub use crate::envelope::Core;
pub use crate::fraud::{score as fraud_score, Signals as FraudSignals};
pub use crate::pbkdf2::{hash_password, verify_password};
pub use crate::totp::{generate_totp, validate_totp};

/// Домены шифрования. У каждого своя область: ключ материала отличается,
/// поэтому шифртекст одного домена невозможно подставить в другой (AAD).
pub const DOMAINS: [&str; 7] = [
    "pii",
    "2fa",
    "msg",
    "product_stock",
    "dispute",
    "wallet",
    "audit",
];

/// Версия конверта: 0x01 ‖ key_id(8) ‖ nonce(12) ‖ ct + tag(16).
pub const ENVELOPE_VERSION: u8 = 0x01;

/// Соль для деривации рабочих ключей (DEK) из KEK.
pub const DEK_SALT: &str = "sitee-dek-v1";

/// Соль для ключа слепых индексов.
pub const INDEX_SALT: &str = "sitee-idx-v1";
pub const INDEX_INFO: &str = "blind-index";

/// Соль и info для ключей Solana.
pub const SOLANA_SALT: &str = "sitee-solana-v1";
pub const SOLANA_PATH_PREFIX: &str = "m/44'/501'/";

/// Итерации PBKDF2 для паролей (такое же значение в Go и Node).
pub const PBKDF2_ITERATIONS: u32 = 210_000;

/// Параметры TOTP по RFC 6238.
pub const TOTP_PERIOD: u64 = 30;
pub const TOTP_DIGITS: u32 = 6;

/// Предфикс формата пароля: pbkdf2-sha256$210000$salt_b64raw$hash_b64raw
pub const PASSWORD_PREFIX: &str = "pbkdf2-sha256";

/// Результат любой операции ядра.
pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Error {
    /// KEK имеет неверную длину (ожидается 32 байта для AES-256).
    BadKeyLength { expected: usize, got: usize },
    /// Конверт повреждён или имеет другую версию.
    BadEnvelope(String),
    /// Проверка тега GCM не прошла — данные подменены.
    Integrity(String),
    /// Не удалось раскодировать base64.
    Base64(String),
    /// Неверная длина секрета TOTP (base32).
    BadSecret(String),
    /// Неверный код TOTP (длина/символы).
    BadCode(String),
    /// Подпись или ключ ed25519 неверной длины.
    BadSignature(String),
    /// Прочее.
    Other(String),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::BadKeyLength { expected, got } => {
                write!(f, "неверная длина ключа: ожидалось {expected}, получено {got}")
            }
            Error::BadEnvelope(m) => write!(f, "некорректный конверт: {m}"),
            Error::Integrity(m) => write!(f, "нарушена целостность: {m}"),
            Error::Base64(m) => write!(f, "ошибка base64: {m}"),
            Error::BadSecret(m) => write!(f, "некорректный секрет: {m}"),
            Error::BadCode(m) => write!(f, "некорректный код: {m}"),
            Error::BadSignature(m) => write!(f, "ошибка подписи: {m}"),
            Error::Other(m) => write!(f, "{m}"),
        }
    }
}

impl std::error::Error for Error {}

/// Постоянное по времени сравнение (защита от timing-атак).
pub fn timing_safe_equal(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for i in 0..a.len() {
        diff |= a[i] ^ b[i];
    }
    diff == 0
}

/// hex-кодирование (строчные буквы).
pub fn to_hex(bytes: &[u8]) -> String {
    const TABLE: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        out.push(TABLE[(b >> 4) as usize] as char);
        out.push(TABLE[(b & 0x0f) as usize] as char);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_encoding() {
        assert_eq!(to_hex(&[0x00, 0x0f, 0xff, 0x10]), "000fff10");
    }

    #[test]
    fn timing_safe_equal_works() {
        assert!(timing_safe_equal(b"abc", b"abc"));
        assert!(!timing_safe_equal(b"abc", b"abd"));
        assert!(!timing_safe_equal(b"abc", b"ab"));
        assert!(!timing_safe_equal(b"ab", b"abc"));
    }
}
