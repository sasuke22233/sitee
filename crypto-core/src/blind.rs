//! Слепой индекс (blind index) для поиска по зашифрованным полям.
//!
//! `HMAC-SHA256(HKDF(KEK, "sitee-idx-v1", "blind-index", 32), lower(trim(v)))`
//! в hex. Позволяет искать email/телефон/ник, не расшифровывая таблицу:
//! совпадение индексов = совпадение значений, но по индексу нельзя
//! восстановить значение (docs/security.md §5).

use crate::hkdf::hkdf_sha256;
use crate::hmac::hmac_sha256;
use crate::{to_hex, INDEX_INFO, INDEX_SALT};

/// Считает слепой индекс значения. Нормализация — как в Go и Node:
/// обрезка пробелов и приведение к нижнему регистру.
pub fn blind_index(kek: &[u8], value: &str) -> String {
    let key = hkdf_sha256(kek, INDEX_SALT.as_bytes(), INDEX_INFO.as_bytes(), 32);
    let normalized = value.trim().to_lowercase();
    to_hex(&hmac_sha256(&key, normalized.as_bytes()))
}

/// Удобная обёртка для уже созданного ядра.
pub fn blind_index_with(core: &crate::envelope::Core, value: &str) -> String {
    blind_index(core.kek(), value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stable_and_case_insensitive() {
        let kek = [9u8; 32];
        let a = blind_index(&kek, "User@Example.com");
        let b = blind_index(&kek, " user@example.com ");
        assert_eq!(a, b);
        assert_ne!(a, blind_index(&kek, "other@example.com"));
        assert_ne!(a, blind_index(&[8u8; 32], "user@example.com"));
        assert_eq!(a.len(), 64);
    }
}
