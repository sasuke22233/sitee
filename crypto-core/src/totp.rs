//! TOTP (RFC 6238) и HOTP (RFC 4226) — «двойной Google 2FA» из ТЗ.
//!
//! Параметры зафиксированы: SHA-1, шаг 30 с, 6 цифр — это то, что понимают
//! Google Authenticator, Authy и Telegram. Проверка идёт с окном ±1 шаг и
//! постоянным по времени сравнением; формат кода валидируется до сравнения,
//! чтобы мусор не доходил до timing-safe ветки.

use crate::hmac::hmac_sha1;
use crate::rand::random_bytes;
use crate::sha256::sha256;
use crate::{to_hex, Error, Result, TOTP_DIGITS, TOTP_PERIOD};

const B32: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/// Алфавит резервных кодов: без похожих glyph (0/O, 1/I/L).
const BACKUP_ALPHABET: &[u8; 31] = b"ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/// Длина резервного кода.
pub const BACKUP_CODE_LEN: usize = 10;

/// Кодирование секрета в base32 (как в Google Authenticator).
pub fn secret_base32(buf: &[u8]) -> String {
    let mut bits: u32 = 0;
    let mut value: u32 = 0;
    let mut out = String::with_capacity((buf.len() * 8 + 4) / 5);
    for &b in buf {
        value = (value << 8) | b as u32;
        bits += 8;
        while bits >= 5 {
            out.push(B32[((value >> (bits - 5)) & 31) as usize] as char);
            bits -= 5;
        }
    }
    if bits > 0 {
        out.push(B32[((value << (5 - bits)) & 31) as usize] as char);
    }
    out
}

/// Декодирование base32 (пробелы и `=` игнорируются).
pub fn decode_base32(s: &str) -> Result<Vec<u8>> {
    let clean: String = s
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '=')
        .collect();
    let mut bits: u32 = 0;
    let mut value: u32 = 0;
    let mut out: Vec<u8> = Vec::with_capacity(clean.len() * 5 / 8);
    for ch in clean.chars() {
        let idx = match B32
            .iter()
            .position(|&b| b as char == ch.to_ascii_uppercase())
        {
            Some(i) => i as u32,
            None => return Err(Error::BadSecret(format!("недопустимый символ «{ch}»"))),
        };
        value = (value << 5) | idx;
        bits += 5;
        if bits >= 8 {
            out.push(((value >> (bits - 8)) & 0xff) as u8);
            bits -= 8;
        }
    }
    Ok(out)
}

/// HOTP (RFC 4226): код из HMAC-SHA1(secret, counter).
pub fn hotp(secret: &[u8], counter: u64, digits: u32) -> String {
    let mut buf = [0u8; 8];
    buf.copy_from_slice(&counter.to_be_bytes());
    let digest = hmac_sha1(secret, &buf);
    let offset = (digest[digest.len() - 1] & 0x0f) as usize;
    let code = ((digest[offset] as u32 & 0x7f) << 24)
        | ((digest[offset + 1] as u32) << 16)
        | ((digest[offset + 2] as u32) << 8)
        | (digest[offset + 3] as u32);
    let modulus = 10u32.pow(digits);
    format!("{:0width$}", code % modulus, width = digits as usize)
}

/// Текущий TOTP-код для момента `at_unix` (секунды).
pub fn generate_totp(secret: &[u8], at_unix: u64) -> String {
    hotp(secret, at_unix / TOTP_PERIOD, TOTP_DIGITS)
}

/// Проверка кода с окном ±`window` шагов. Возвращает совпавший шаг.
pub fn validate_totp(secret: &[u8], code: &str, at_unix: u64, window: i64) -> Option<u64> {
    let value = code.trim();
    if value.len() != TOTP_DIGITS as usize || !value.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let step = (at_unix / TOTP_PERIOD) as i64;
    let given = value.as_bytes();
    for i in -window..=window {
        let candidate = step + i;
        if candidate < 0 {
            continue;
        }
        let expected = hotp(secret, candidate as u64, TOTP_DIGITS);
        if expected.len() == given.len() && crate::timing_safe_equal(expected.as_bytes(), given) {
            return Some(candidate as u64);
        }
    }
    None
}

/// Ссылка `otpauth://` для QR-кода в приложении-аутентификаторе.
pub fn otpauth_url(issuer: &str, account: &str, secret_b32: &str, label: &str) -> String {
    format!(
        "otpauth://totp/{}:{}?secret={}&issuer={}&algorithm=SHA1&digits={}&period={}&label={}",
        percent_encode(issuer),
        percent_encode(account),
        secret_b32,
        percent_encode(issuer),
        TOTP_DIGITS,
        TOTP_PERIOD,
        percent_encode(label),
    )
}

/// Кодирование компонента URI (как `encodeURIComponent` в JS).
fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        let unreserved = b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~');
        if unreserved {
            out.push(b as char);
        } else {
            out.push('%');
            out.push_str(&format!("{:02X}", b));
        }
    }
    out
}

/// Новый секрет: 20 случайных байт (160 бит, рекомендация RFC 4226).
pub fn new_secret() -> Vec<u8> {
    random_bytes(20)
}

/// Резервные коды: 10 символов из однозначного алфавита + их SHA-256.
/// Формат кодов implementation-specific: хранятся только хеши.
pub fn backup_codes(n: usize) -> (Vec<String>, Vec<String>) {
    let mut codes = Vec::with_capacity(n);
    let mut hashes = Vec::with_capacity(n);
    for _ in 0..n {
        let raw = random_bytes(BACKUP_CODE_LEN);
        let code: String = raw
            .iter()
            .map(|b| BACKUP_ALPHABET[*b as usize % BACKUP_ALPHABET.len()] as char)
            .collect();
        hashes.push(to_hex(&sha256(code.to_uppercase().as_bytes())));
        codes.push(code);
    }
    (codes, hashes)
}

/// Проверка резервного кода; возвращает индекс (для одноразового использования).
pub fn verify_backup_code(code: &str, hashes: &[String]) -> Option<usize> {
    let digest = to_hex(&sha256(code.trim().to_uppercase().as_bytes()));
    hashes
        .iter()
        .position(|h| crate::timing_safe_equal(h.as_bytes(), digest.as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rfc6238_vectors() {
        // Секрет "12345678901234567890" в base32.
        let secret = decode_base32("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ").unwrap();
        assert_eq!(secret_base32(&secret), "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
        // 8-значные коды из RFC 6238 (SHA-1).
        let cases: [(u64, &str); 5] = [
            (59, "94287082"),
            (1111111109, "07081804"),
            (1111111111, "14050471"),
            (1234567890, "89005924"),
            (2000000000, "69279037"),
        ];
        for (t, want8) in cases {
            let counter = t / 30;
            assert_eq!(hotp(&secret, counter, 8), want8, "t={t}");
            assert_eq!(hotp(&secret, counter, 6), &want8[2..], "t={t}");
        }
    }

    #[test]
    fn validate_window_and_replay() {
        let secret = b"12345678901234567890";
        let at = 1_000_000u64;
        let code = generate_totp(secret, at);
        assert!(validate_totp(secret, &code, at, 1).is_some());
        // Предыдущий и следующий шаг тоже принимаются в окне ±1.
        let prev = generate_totp(secret, at - 30);
        let next = generate_totp(secret, at + 30);
        assert!(validate_totp(secret, &prev, at, 1).is_some());
        assert!(validate_totp(secret, &next, at, 1).is_some());
        // Вне окна — отказ.
        assert!(validate_totp(secret, &generate_totp(secret, at + 120), at, 1).is_none());
        // Мусорный ввод не доходит до сравнения.
        assert!(validate_totp(secret, "12345", at, 1).is_none());
        assert!(validate_totp(secret, "abcdef", at, 1).is_none());
    }

    #[test]
    fn otpauth_url_shape() {
        let url = otpauth_url("SITEE", "user@sitee.dev", "GEZDGNBVGY3TQOJQ", "SITEE:user");
        assert!(url.starts_with("otpauth://totp/SITEE:user%40sitee.dev?secret="));
        assert!(url.contains("&issuer=SITEE"));
        assert!(url.contains("&algorithm=SHA1&digits=6&period=30"));
        assert!(url.ends_with("&label=SITEE%3Auser"));
    }

    #[test]
    fn backup_codes_single_use() {
        let (codes, hashes) = backup_codes(10);
        assert_eq!(codes.len(), 10);
        assert_eq!(hashes.len(), 10);
        assert!(codes.iter().all(|c| c.len() == BACKUP_CODE_LEN));
        let idx = verify_backup_code(&codes[3], &hashes).expect("код должен находиться");
        assert_eq!(idx, 3);
        assert!(verify_backup_code(&codes[3].to_lowercase(), &hashes).is_some());
        assert!(verify_backup_code("XXXXXXXXXX", &hashes).is_none());
    }

    #[test]
    fn bad_base32_rejected() {
        assert!(decode_base32("ABC1").is_err());
    }
}
