//! AES-256-GCM (SP 800-38D): шифрование с аутентификацией.
//!
//! GHASH считаем по-сырьевому (умножение в GF(2^128) по ГОСТ-подобной
//! таблице R = 0xE1‖0^120), CTR — блочным шифром AES-256. Скорость ниже
//! аппаратных CLMUL, но зависимостей нет и поведение предсказуемо.

use crate::aes256::{encrypt_block, key_expansion, ROUND_KEYS};
use crate::{timing_safe_equal, Error, Result};

const MASK: u128 = (1u128 << 128) - 1;
/// Многочлен редукции GF(2^128): x^128 + x^7 + x^2 + x + 1.
const R: u128 = 0xe100_0000_0000_0000_0000_0000_0000_0000;

/// Умножение в поле GF(2^128) (битовый порядок как в спецификации GCM).
fn gf_mul(x: u128, y: u128) -> u128 {
    let mut z: u128 = 0;
    let mut v = x & MASK;
    for i in 0..128 {
        if (y >> (127 - i)) & 1 == 1 {
            z ^= v;
        }
        let lsb = v & 1;
        v >>= 1;
        if lsb == 1 {
            v ^= R;
        }
    }
    z & MASK
}

/// GHASH по данным, длина которых кратна 16 байтам.
fn ghash(h: u128, data: &[u8]) -> u128 {
    let mut y: u128 = 0;
    let mut off = 0;
    while off < data.len() {
        let mut b = [0u8; 16];
        b.copy_from_slice(&data[off..off + 16]);
        y ^= u128::from_be_bytes(b);
        y = gf_mul(y, h);
        off += 16;
    }
    y
}

/// Инкремент последних 32 бит счётчика (inc32).
fn inc32(block: &mut [u8; 16]) {
    let mut i = 15;
    while i >= 12 {
        block[i] = block[i].wrapping_add(1);
        if block[i] != 0 {
            break;
        }
        i -= 1;
    }
}

/// GCTR: шифрование гаммой CTR с начальным блоком `icb`.
fn gctr(rk: &[u32; ROUND_KEYS], icb: &[u8; 16], data: &[u8]) -> Vec<u8> {
    let mut out = vec![0u8; data.len()];
    let mut cb = *icb;
    let mut off = 0;
    while off < data.len() {
        let ks = encrypt_block(rk, &cb);
        inc32(&mut cb);
        let n = (data.len() - off).min(16);
        for i in 0..n {
            out[off + i] = data[off + i] ^ ks[i];
        }
        off += n;
    }
    out
}

/// Предварительный счётчик J0 для 96-битного nonce (SP 800-38D §5.2.1.1):
/// `nonce ‖ 0^31 ‖ 1`.
///
/// Нестандартная длина IV намеренно не поддерживается: в SITEE nonce всегда
/// 12 случайных байт (формат конверта), а сборка J0 через GHASH у распространённых
/// реализаций расходится с формулой NIST — тихо неверный тег опаснее отказа.
fn j0(iv: &[u8]) -> Result<[u8; 16]> {
    if iv.len() != 12 {
        return Err(Error::Other(format!(
            "gcm: nonce должен быть 12 байт, получено {}",
            iv.len()
        )));
    }
    let mut out = [0u8; 16];
    out[..12].copy_from_slice(&iv[..12]);
    out[15] = 1;
    Ok(out)
}

/// Подблок S = GHASH(H, A‖pad‖C‖pad‖[len(A)]64‖[len(C)]64).
fn s_block(h: u128, aad: &[u8], ct: &[u8]) -> u128 {
    let apad = (16 - aad.len() % 16) % 16;
    let cpad = (16 - ct.len() % 16) % 16;
    let mut buf = Vec::with_capacity(aad.len() + apad + ct.len() + cpad + 16);
    buf.extend_from_slice(aad);
    buf.extend(std::iter::repeat(0u8).take(apad));
    buf.extend_from_slice(ct);
    buf.extend(std::iter::repeat(0u8).take(cpad));
    let mut lenblk = [0u8; 16];
    lenblk[4..8].copy_from_slice(&((aad.len() as u64) * 8).to_be_bytes());
    lenblk[12..16].copy_from_slice(&((ct.len() as u64) * 8).to_be_bytes());
    buf.extend_from_slice(&lenblk);
    ghash(h, &buf)
}

/// Шифрование: возвращает `ciphertext || tag(16)`.
pub fn aes256_gcm_encrypt(
    key: &[u8; 32],
    iv: &[u8],
    plaintext: &[u8],
    aad: &[u8],
) -> Result<Vec<u8>> {
    let rk = key_expansion(key);
    let h = u128::from_be_bytes(encrypt_block(&rk, &[0u8; 16]));
    let j0 = j0(iv)?;
    let ct = gctr(&rk, &inc32_of(&j0), plaintext);
    let s = s_block(h, aad, &ct);
    let tag = gctr(&rk, &j0, &s.to_be_bytes());
    let mut out = Vec::with_capacity(ct.len() + 16);
    out.extend_from_slice(&ct);
    out.extend_from_slice(&tag);
    Ok(out)
}

/// Расшифровка с проверкой тега. Ошибка `Integrity`, если данные подменены.
pub fn aes256_gcm_decrypt(
    key: &[u8; 32],
    iv: &[u8],
    ct_with_tag: &[u8],
    aad: &[u8],
) -> Result<Vec<u8>> {
    if ct_with_tag.len() < 16 {
        return Err(Error::Integrity("gcm: данные короче тега".into()));
    }
    let rk = key_expansion(key);
    let h = u128::from_be_bytes(encrypt_block(&rk, &[0u8; 16]));
    let j0 = j0(iv)?;
    let split = ct_with_tag.len() - 16;
    let ct = &ct_with_tag[..split];
    let tag = &ct_with_tag[split..];
    let s = s_block(h, aad, ct);
    let expect = gctr(&rk, &j0, &s.to_be_bytes());
    if !timing_safe_equal(tag, &expect) {
        return Err(Error::Integrity("gcm: тег не совпал".into()));
    }
    Ok(gctr(&rk, &inc32_of(&j0), ct))
}

fn inc32_of(block: &[u8; 16]) -> [u8; 16] {
    let mut b = *block;
    inc32(&mut b);
    b
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::to_hex;

    #[test]
    fn nonce_must_be_12_bytes() {
        // Нестандартная длина nonce не поддерживается намеренно.
        assert!(aes256_gcm_encrypt(&[0u8; 32], &[0u8; 16], b"x", b"").is_err());
        assert!(aes256_gcm_encrypt(&[0u8; 32], &[0u8; 8], b"x", b"").is_err());
        assert!(aes256_gcm_decrypt(&[0u8; 32], &[0u8; 16], &[0u8; 32], b"").is_err());
    }

    #[test]
    fn nist_gcm_zero_vector() {
        // AES-256, ключ 0^32, IV 0^12, пустые P и A → тег 58e2fcce… (TC.2 класса
        // «пустые данные»); сверено с node crypto в CI-векторах.
        let out = aes256_gcm_encrypt(&[0u8; 32], &[0u8; 12], b"", b"").unwrap();
        assert_eq!(to_hex(&out), "530f8afbc74536b9a963b4f1c4cb738b");
    }

    #[test]
    fn roundtrip_and_tamper() {
        let key = [7u8; 32];
        let iv = [3u8; 12];
        let pt = b"sitee: секретное сообщение чата";
        let aad = b"msg:ord_1";
        let blob = aes256_gcm_encrypt(&key, &iv, pt, aad).unwrap();
        assert_eq!(aes256_gcm_decrypt(&key, &iv, &blob, aad).unwrap().as_slice(), pt);
        let mut broken = blob.clone();
        broken[0] ^= 1;
        assert!(aes256_gcm_decrypt(&key, &iv, &broken, aad).is_err());
        // Другой AAD — тоже отказ.
        assert!(aes256_gcm_decrypt(&key, &iv, &blob, b"msg:ord_2").is_err());
    }
}
