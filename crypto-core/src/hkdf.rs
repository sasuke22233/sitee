//! HKDF-SHA256 (RFC 5869): извлечение и расширение ключа.
//!
//! Из KEK окружения выводятся рабочие ключи (DEK) каждого домена, ключ
//! слепых индексов и ключ служебной подписи — те же соли, что в Go и Node.

use crate::hmac::hmac_sha256;

/// Максимальная длина вывода: 255 блоков по 32 байта.
pub const MAX_LEN: usize = 255 * 32;

/// Выводит `len` байт из `secret` с солью `salt` и контекстом `info`.
///
/// Пустая соль трактуется как 32 нулевых байта (как в RFC 5869 и в Go).
pub fn hkdf_sha256(secret: &[u8], salt: &[u8], info: &[u8], len: usize) -> Vec<u8> {
    assert!(len <= MAX_LEN, "hkdf: запрошено больше 255 блоков");
    let zero = [0u8; 32];
    let salt = if salt.is_empty() { &zero[..] } else { salt };
    let prk = hmac_sha256(salt, secret);
    let mut out: Vec<u8> = Vec::with_capacity(len + 32);
    let mut prev: Vec<u8> = Vec::new();
    let mut counter: u8 = 1;
    while out.len() < len {
        let mut input = Vec::with_capacity(prev.len() + info.len() + 1);
        input.extend_from_slice(&prev);
        input.extend_from_slice(info);
        input.push(counter);
        prev = hmac_sha256(&prk, &input).to_vec();
        out.extend_from_slice(&prev);
        counter = counter.wrapping_add(1);
    }
    out.truncate(len);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::to_hex;

    #[test]
    fn rfc5869_test_case_1() {
        // SHA-256, IKM = 0x0b*22, salt = 0x000102...0c, info = 0xf0f1...f9, L = 42.
        let ikm = [0x0bu8; 22];
        let salt: Vec<u8> = (0..=12u8).collect();
        let info: Vec<u8> = (0xf0u8..=0xf9u8).collect();
        let okm = hkdf_sha256(&ikm, &salt, &info, 42);
        assert_eq!(
            to_hex(&okm),
            "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865"
        );
    }
}
