//! Маскировка сторон спора (FR-DSP-03): покупатель и продавец видят друг
//! друга под стабильными псевдонимами, арбитр — реальные идентификаторы.
//!
//! `HMAC-SHA256("sitee-dispute-alias-v1:<salt>", user_id)` → 3 символа из
//! алфавита без похожих glyph (0/O, 1/I/L). Соль спора делает псевдоним
//! непереносимым между спорами.

use crate::hmac::hmac_sha256;

/// Алфавит псевдонимов: без 0, O, 1, I, L.
const ALPHABET: &[u8; 32] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/// Роль участника в споре.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Party {
    Buyer,
    Shop,
    Other,
}

/// Стабильный псевдоним участника в рамках спора.
pub fn alias_for(salt: &str, user_id: &str, role: Party) -> String {
    let key = format!("sitee-dispute-alias-v1:{salt}");
    let mac = hmac_sha256(key.as_bytes(), user_id.as_bytes());
    let mut code = String::with_capacity(3);
    for i in 0..3 {
        code.push(ALPHABET[(mac[i] as usize) % ALPHABET.len()] as char);
    }
    match role {
        Party::Buyer => format!("Покупатель #{code}"),
        Party::Shop => format!("Продавец #{code}"),
        Party::Other => format!("Участник #{code}"),
    }
}

/// Код псевдонима без префикса роли (для логов и сверки).
pub fn alias_code(salt: &str, user_id: &str) -> String {
    let key = format!("sitee-dispute-alias-v1:{salt}");
    let mac = hmac_sha256(key.as_bytes(), user_id.as_bytes());
    let mut code = String::with_capacity(3);
    for i in 0..3 {
        code.push(ALPHABET[(mac[i] as usize) % ALPHABET.len()] as char);
    }
    code
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stable_per_dispute_salt() {
        let a = alias_for("d1", "usr_1", Party::Buyer);
        assert_eq!(a, alias_for("d1", "usr_1", Party::Buyer));
        assert!(a.starts_with("Покупатель #"));
        // Другой спор — другой псевдоним.
        assert_ne!(a, alias_for("d2", "usr_1", Party::Buyer));
        // Роль меняет префикс, но не код.
        let shop = alias_for("d1", "usr_1", Party::Shop);
        assert!(shop.starts_with("Продавец #"));
        assert_eq!(&a[a.len() - 3..], &shop[shop.len() - 3..]);
    }

    #[test]
    fn alphabet_has_no_ambiguous_glyphs() {
        for ch in b"0O1IL" {
            assert!(!ALPHABET.contains(ch));
        }
    }
}
