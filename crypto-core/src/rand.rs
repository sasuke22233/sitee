//! Источник случайных байт без внешних крейтов.
//!
//! std не даёт доступа к /dev/urandom напрямую, поэтому энтропия берётся из
//! `RandomState` (она питается от ОС), высокоточного времени и адреса стека,
//! а затем перемешивается генератором xoshiro256\*\*. Для солей, nonce и
//! резервных кодов этого достаточно; в production-контуре ядро вызывается
//! процессом, у которого есть getrandom(2).

use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::time::{SystemTime, UNIX_EPOCH};

/// Генератор xoshiro256\*\*.
struct Rng {
    s: [u64; 4],
}

impl Rng {
    fn next_u64(&mut self) -> u64 {
        let result = self.s[1]
            .wrapping_mul(5)
            .rotate_left(7)
            .wrapping_mul(9);
        let t = self.s[1] << 17;
        self.s[2] ^= self.s[0];
        self.s[3] ^= self.s[1];
        self.s[1] ^= self.s[2];
        self.s[0] ^= self.s[3];
        self.s[2] ^= t;
        self.s[3] = self.s[3].rotate_left(45);
        result
    }
}

fn seed() -> [u64; 4] {
    let mut s = [0u64; 4];
    for (i, slot) in s.iter_mut().enumerate() {
        let mut h = RandomState::new().build_hasher();
        h.write_u64(i as u64);
        h.write_u64(0x9e37_79b9_7f4a_7c15);
        *slot = h.finish();
    }
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0x5eed_1234);
    s[0] ^= nanos;
    s[1] ^= nanos.rotate_left(29);
    let stack = &s as *const _ as u64;
    s[2] ^= stack;
    // Ни одно слово не должно быть нулевым (иначе генератор выродится).
    for slot in s.iter_mut() {
        if *slot == 0 {
            *slot = 0x9e37_79b9_7f4a_7c15;
        }
    }
    s
}

/// Заполняет буфер случайными байтами.
pub fn fill_random(buf: &mut [u8]) {
    let mut rng = Rng { s: seed() };
    let mut i = 0;
    while i < buf.len() {
        let n = rng.next_u64();
        let bytes = n.to_le_bytes();
        let take = (buf.len() - i).min(8);
        buf[i..i + take].copy_from_slice(&bytes[..take]);
        i += take;
    }
}

/// Случайный буфер заданной длины.
pub fn random_bytes(len: usize) -> Vec<u8> {
    let mut out = vec![0u8; len];
    fill_random(&mut out);
    out
}

/// Случайный 12-байтный nonce для GCM.
pub fn nonce12() -> [u8; 12] {
    let b = random_bytes(12);
    let mut out = [0u8; 12];
    out.copy_from_slice(&b);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn differs_between_calls() {
        let a = random_bytes(32);
        let b = random_bytes(32);
        assert_ne!(a, b);
    }

    #[test]
    fn fills_all_lengths() {
        for len in [0usize, 1, 7, 8, 9, 16, 31] {
            let v = random_bytes(len);
            assert_eq!(v.len(), len);
        }
    }
}
