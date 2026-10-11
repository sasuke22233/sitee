//! Safety number — короткий код для визуальной сверки E2EE-ключей
//! (docs/security.md §4.2). Формат: 8 групп по 5 цифр через пробел.

use crate::hmac::hmac_sha256;

/// Число групп в коде.
pub const GROUPS: usize = 8;

/// Считает safety number для пары пользователей и отпечатка ключа.
/// Порядок пары не важен: `min(uid)|max(uid)`.
pub fn safety_number(fingerprint: &str, user_a: &str, user_b: &str) -> String {
    let (lo, hi) = if user_b < user_a {
        (user_b, user_a)
    } else {
        (user_a, user_b)
    };
    let key = format!("sitee-safety-v1:{fingerprint}");
    let msg = format!("{lo}|{hi}");
    let mac = hmac_sha256(key.as_bytes(), msg.as_bytes());
    let mut groups: Vec<String> = Vec::with_capacity(GROUPS);
    let mut i = 0;
    while i + 1 < mac.len() && groups.len() < GROUPS {
        let n = ((mac[i] as u32) << 8) | mac[i + 1] as u32;
        groups.push(format!("{:05}", n % 100_000));
        i += 2;
    }
    groups.join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn order_independent_and_stable() {
        let a = safety_number("abc123", "usr_a", "usr_b");
        let b = safety_number("abc123", "usr_b", "usr_a");
        assert_eq!(a, b);
        assert_eq!(a.split(' ').count(), GROUPS);
        for g in a.split(' ') {
            assert_eq!(g.len(), 5);
            assert!(g.bytes().all(|c| c.is_ascii_digit()));
        }
        assert_ne!(a, safety_number("abc124", "usr_a", "usr_b"));
        assert_ne!(a, safety_number("abc123", "usr_a", "usr_c"));
    }
}
