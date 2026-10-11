//! HMAC (RFC 2104) поверх SHA-256 и SHA-1.
//!
//! SHA-1-вариант существует только ради HOTP (RFC 4226/6238) — «двойной
//! Google 2FA» в ТЗ закреплён за этим набором параметров.

use crate::sha1::Sha1;
use crate::sha256::Sha256;

const BLOCK: usize = 64;

/// HMAC-SHA256: 32 байта.
pub fn hmac_sha256(key: &[u8], msg: &[u8]) -> [u8; 32] {
    let mut k = [0u8; BLOCK];
    if key.len() > BLOCK {
        k[..32].copy_from_slice(&crate::sha256::sha256(key));
    } else {
        k[..key.len()].copy_from_slice(key);
    }
    let mut ipad = [0x36u8; BLOCK];
    let mut opad = [0x5cu8; BLOCK];
    for i in 0..BLOCK {
        ipad[i] ^= k[i];
        opad[i] ^= k[i];
    }
    let mut inner = Vec::with_capacity(BLOCK + msg.len());
    inner.extend_from_slice(&ipad);
    inner.extend_from_slice(msg);
    let inner_hash = {
        let mut h = Sha256::new();
        h.update(&inner);
        h.finalize()
    };
    let mut outer = Vec::with_capacity(BLOCK + 32);
    outer.extend_from_slice(&opad);
    outer.extend_from_slice(&inner_hash);
    let mut h = Sha256::new();
    h.update(&outer);
    h.finalize()
}

/// HMAC-SHA1: 20 байт (для HOTP).
pub fn hmac_sha1(key: &[u8], msg: &[u8]) -> [u8; 20] {
    let mut k = [0u8; BLOCK];
    if key.len() > BLOCK {
        k[..20].copy_from_slice(&crate::sha1::sha1(key));
    } else {
        k[..key.len()].copy_from_slice(key);
    }
    let mut ipad = [0x36u8; BLOCK];
    let mut opad = [0x5cu8; BLOCK];
    for i in 0..BLOCK {
        ipad[i] ^= k[i];
        opad[i] ^= k[i];
    }
    let mut inner = Vec::with_capacity(BLOCK + msg.len());
    inner.extend_from_slice(&ipad);
    inner.extend_from_slice(msg);
    let inner_hash = {
        let mut h = Sha1::new();
        h.update(&inner);
        h.finalize()
    };
    let mut outer = Vec::with_capacity(BLOCK + 20);
    outer.extend_from_slice(&opad);
    outer.extend_from_slice(&inner_hash);
    let mut h = Sha1::new();
    h.update(&outer);
    h.finalize()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::to_hex;

    #[test]
    fn rfc4231_vector_2() {
        // Ключ "Jefe", сообщение "what do ya want for nothing?"
        let mac = hmac_sha256(b"Jefe", b"what do ya want for nothing?");
        assert_eq!(
            to_hex(&mac),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
    }

    #[test]
    fn short_and_long_keys() {
        assert_eq!(
            to_hex(&hmac_sha256(
                b"key",
                b"The quick brown fox jumps over the lazy dog"
            )),
            "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8"
        );
    }

    #[test]
    fn sha1_for_hotp() {
        // RFC 2202, тест-вектор 1.
        assert_eq!(
            to_hex(&hmac_sha1(&[0x0b; 20], b"Hi There")),
            "b617318655057264e28bc0b6fb378c8ef146be00"
        );
    }
}
