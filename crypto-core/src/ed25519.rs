//! ed25519 (RFC 8032) на std: подпись, проверка, вывод публичного ключа.
//!
//! Арифметика поля GF(2^255-19) — четыре 64-битных лимба с редукцией через
//! 2^256 ≡ 38 (mod p); умножение — schoolbook с 128-битными промежуточными.
//! Точки — в расширенных координатах (X:Y:Z:T). Нужен для адресов и подписи
//! транзакций Solana (docs/solana.md §3): приватный ключ не покидает ядро.

use crate::sha512::sha512;
use crate::{Error, Result};

/// Элемент поля: 4 лимба по 64 бита, младший первым.
type Fe = [u64; 4];

const P: Fe = [
    0xffffffffffffffed,
    0xffffffffffffffff,
    0xffffffffffffffff,
    0x7fffffffffffffff,
];
const PM2: Fe = [0xffffffffffffffeb, 0xffffffffffffffff, 0xffffffffffffffff, 0x7fffffffffffffff];
const EXPSQRT: Fe = [0xfffffffffffffffd, 0xffffffffffffffff, 0xffffffffffffffff, 0x0fffffffffffffff];
const SQRTM1: Fe = [0xc4ee1b274a0ea0b0, 0x2f431806ad2fe478, 0x2b4d00993dfbd7a7, 0x2b8324804fc1df0b];
const D: Fe = [0x75eb4dca135978a3, 0x00700a4d4141d8ab, 0x8cc740797779e898, 0x52036cee2b6ffe73];
const TWOD: Fe = [0xebd69b9426b2f159, 0x00e0149a8283b156, 0x198e80f2eef3d130, 0x2406d9dc56dffce7];
const L: Fe = [0x5812631a5cf5d3ed, 0x14def9dea2f79cd6, 0x0000000000000000, 0x1000000000000000];

/// Точка в расширенных однородных координатах (x = X/Z, y = Y/Z).
#[derive(Clone, Copy)]
struct Point {
    x: Fe,
    y: Fe,
    z: Fe,
    t: Fe,
}

fn fe_zero() -> Fe {
    [0, 0, 0, 0]
}

fn fe_one() -> Fe {
    [1, 0, 0, 0]
}

fn fe_from_u64(v: u64) -> Fe {
    [v, 0, 0, 0]
}

/// Читает 32 байт (little-endian) как элемент поля без редукции.
fn fe_from_bytes_le(b: &[u8]) -> Fe {
    let mut f = [0u64; 4];
    for i in 0..4 {
        let mut buf = [0u8; 8];
        buf.copy_from_slice(&b[8 * i..8 * i + 8]);
        f[i] = u64::from_le_bytes(buf);
    }
    f
}

/// Вычитает p, если значение больше либо равно p.
fn sub_p_if_ge(r: &mut Fe) {
    let mut out = [0u64; 4];
    let mut borrow: u64 = 0;
    for i in 0..4 {
        let (d, b1) = r[i].overflowing_sub(P[i]);
        let (d2, b2) = d.overflowing_sub(borrow);
        out[i] = d2;
        borrow = (b1 as u64) + (b2 as u64);
    }
    if borrow == 0 {
        *r = out;
    }
}

/// Редукция 512-битного произведения: 2^256 ≡ 38 (mod p).
fn reduce512(t: &[u64; 8]) -> Fe {
    let mut lo = [t[0], t[1], t[2], t[3]];
    let mut hi = [t[4], t[5], t[6], t[7]];
    for _ in 0..8 {
        if hi == [0, 0, 0, 0] {
            break;
        }
        let mut carry: u128 = 0;
        for i in 0..4 {
            let cur = (lo[i] as u128) + 38u128 * (hi[i] as u128) + carry;
            lo[i] = cur as u64;
            carry = cur >> 64;
        }
        hi = [carry as u64, 0, 0, 0];
    }
    for _ in 0..2 {
        sub_p_if_ge(&mut lo);
    }
    lo
}

fn fe_mul(a: &Fe, b: &Fe) -> Fe {
    let mut t = [0u64; 8];
    for i in 0..4 {
        let mut carry: u128 = 0;
        for j in 0..4 {
            let idx = i + j;
            let cur = (t[idx] as u128) + (a[i] as u128) * (b[j] as u128) + carry;
            t[idx] = cur as u64;
            carry = cur >> 64;
        }
        let mut k = i + 4;
        while carry > 0 && k < 8 {
            let cur = (t[k] as u128) + carry;
            t[k] = cur as u64;
            carry = cur >> 64;
            k += 1;
        }
    }
    reduce512(&t)
}

fn fe_add(a: &Fe, b: &Fe) -> Fe {
    let mut r = [0u64; 4];
    let mut carry: u128 = 0;
    for i in 0..4 {
        let cur = (a[i] as u128) + (b[i] as u128) + carry;
        r[i] = cur as u64;
        carry = cur >> 64;
    }
    sub_p_if_ge(&mut r);
    r
}

fn fe_sub(a: &Fe, b: &Fe) -> Fe {
    let mut r = [0u64; 4];
    let mut borrow: u64 = 0;
    for i in 0..4 {
        let (d, b1) = a[i].overflowing_sub(b[i]);
        let (d2, b2) = d.overflowing_sub(borrow);
        r[i] = d2;
        borrow = (b1 as u64) + (b2 as u64);
    }
    if borrow > 0 {
        let mut carry: u128 = 0;
        for i in 0..4 {
            let cur = (r[i] as u128) + (P[i] as u128) + carry;
            r[i] = cur as u64;
            carry = cur >> 64;
        }
    }
    r
}

fn fe_neg(a: &Fe) -> Fe {
    fe_sub(&fe_zero(), a)
}

fn fe_sqr(a: &Fe) -> Fe {
    fe_mul(a, a)
}

/// Возведение в степень показателем, заданным четырьмя лимбами.
fn fe_pow(a: &Fe, e: &Fe) -> Fe {
    let mut r = fe_one();
    let mut started = false;
    for i in (0..256).rev() {
        let bit = (e[i / 64] >> (i % 64)) & 1;
        if started {
            r = fe_sqr(&r);
            if bit == 1 {
                r = fe_mul(&r, a);
            }
        } else if bit == 1 {
            r = *a;
            started = true;
        }
    }
    r
}

/// Обращение по малой теореме Ферма: a^(p-2).
fn fe_inv(a: &Fe) -> Fe {
    fe_pow(a, &P_MINUS_2)
}

/// Квадратный корень (p ≡ 5 mod 8): x = u·v³·(u·v⁷)^((p-5)/8).
fn fe_sqrt_ratio(u: &Fe, v: &Fe) -> Option<Fe> {
    let v3 = fe_mul(&fe_sqr(v), v);
    let v7 = fe_mul(&fe_sqr(&v3), v);
    let mut x = fe_mul(&fe_mul(u, &v3), &fe_pow(&fe_mul(u, &v7), &EXPSQRT));
    if !fe_eq(&fe_mul(&fe_sqr(&x), v), u) {
        x = fe_mul(&x, &SQRT_M1);
    }
    if fe_eq(&fe_mul(&fe_sqr(&x), v), u) {
        Some(x)
    } else {
        None
    }
}

fn fe_eq(a: &Fe, b: &Fe) -> bool {
    a == b
}

/// Лексиграфическое сравнение little-endian представлений.
fn fe_cmp(a: &Fe, b: &Fe) -> std::cmp::Ordering {
    for i in (0..4).rev() {
        match a[i].cmp(&b[i]) {
            std::cmp::Ordering::Equal => continue,
            other => return other,
        }
    }
    std::cmp::Ordering::Equal
}

fn point_add(p: &Point, q: &Point) -> Point {
    let a = fe_mul(&fe_sub(&p.y, &p.x), &fe_sub(&q.y, &q.x));
    let b = fe_mul(&fe_add(&p.y, &p.x), &fe_add(&q.y, &q.x));
    let c = fe_mul(&fe_mul(&TWO_D, &p.t), &q.t);
    let d = fe_mul(&fe_mul(&fe_from_u64(2), &p.z), &q.z);
    let e = fe_sub(&b, &a);
    let f = fe_sub(&d, &c);
    let g = fe_add(&d, &c);
    let h = fe_add(&b, &a);
    Point {
        x: fe_mul(&e, &f),
        y: fe_mul(&g, &h),
        z: fe_mul(&f, &g),
        t: fe_mul(&e, &h),
    }
}

fn point_double(p: &Point) -> Point {
    let a = fe_sqr(&p.x);
    let b = fe_sqr(&p.y);
    let c = fe_mul(&fe_from_u64(2), &fe_sqr(&p.z));
    let d = fe_neg(&a);
    let e = fe_sub(&fe_sqr(&fe_add(&p.x, &p.y)), &fe_add(&a, &b));
    let g = fe_add(&d, &b);
    let f = fe_sub(&g, &c);
    let h = fe_sub(&d, &b);
    Point {
        x: fe_mul(&e, &f),
        y: fe_mul(&g, &h),
        z: fe_mul(&f, &g),
        t: fe_mul(&e, &h),
    }
}

/// Умножение точки на скаляр (двоичный метод, 256 бит).
fn scalar_mult(k: &Fe, pt: &Point) -> Point {
    let mut r = Point {
        x: fe_zero(),
        y: fe_one(),
        z: fe_one(),
        t: fe_zero(),
    };
    for i in (0..256).rev() {
        r = point_double(&r);
        if (k[i / 64] >> (i % 64)) & 1 == 1 {
            r = point_add(&r, pt);
        }
    }
    r
}

/// Базовая точка: y = 4/5, x — чётный корень.
fn base_point() -> Point {
    let y = fe_mul(&fe_from_u64(4), &fe_inv(&fe_from_u64(5)));
    let y2 = fe_sqr(&y);
    let u = fe_sub(&y2, &fe_one());
    let v = fe_add(&fe_mul(&D, &y2), &fe_one());
    let mut x = fe_sqrt_ratio(&u, &v).expect("базовая точка ed25519");
    if x[0] & 1 == 1 {
        x = fe_neg(&x);
    }
    Point {
        x,
        y,
        z: fe_one(),
        t: fe_mul(&x, &y),
    }
}

/// Кодирование точки: 32 байта, старший бит последнего — знак x.
fn encode_point(p: &Point) -> [u8; 32] {
    let zi = fe_inv(&p.z);
    let x = fe_mul(&p.x, &zi);
    let y = fe_mul(&p.y, &zi);
    let mut out = [0u8; 32];
    for i in 0..4 {
        out[8 * i..8 * i + 8].copy_from_slice(&y[i].to_le_bytes());
    }
    out[31] |= ((x[0] & 1) as u8) << 7;
    out
}

/// Декодирование точки; `None`, если точка не на кривой.
fn decode_point(bytes: &[u8]) -> Option<Point> {
    if bytes.len() < 32 {
        return None;
    }
    let sign = (bytes[31] >> 7) & 1;
    let mut yb = [0u8; 32];
    yb.copy_from_slice(&bytes[..32]);
    yb[31] &= 0x7f;
    let y = fe_from_bytes_le(&yb);
    // y должно быть меньше p (каноническая кодировка).
    if fe_cmp(&y, &P) != std::cmp::Ordering::Less {
        return None;
    }
    let y2 = fe_sqr(&y);
    let u = fe_sub(&y2, &fe_one());
    let v = fe_add(&fe_mul(&D, &y2), &fe_one());
    let mut x = fe_sqrt_ratio(&u, &v)?;
    if (x[0] & 1) as u8 != sign {
        x = fe_neg(&x);
    }
    if x == fe_zero() && sign == 1 {
        return None;
    }
    Some(Point {
        x,
        y,
        z: fe_one(),
        t: fe_mul(&x, &y),
    })
}

/// Зажим скаляра по RFC 8032: бит 254 = 1, младшие 3 бита = 0.
fn clamp_scalar(h: &[u8; 32]) -> Fe {
    let mut a = fe_from_bytes_le(h);
    a[0] &= !7u64;
    a[3] &= (1u64 << 63) - 1;
    a[3] |= 1u64 << 62;
    a
}

/// Пара «публичный ключ + Seed» — seed наружу не отдаётся.
pub struct Keypair {
    public_key: [u8; 32],
    seed: [u8; 32],
}

impl Keypair {
    /// Публичный ключ (32 байта).
    pub fn public_key(&self) -> &[u8; 32] {
        &self.public_key
    }
    /// Seed (эквивалент приватного ключа ed25519).
    pub fn seed(&self) -> &[u8; 32] {
        &self.seed
    }
}

/// Вывод публичного ключа из 32-байтного seed.
pub fn public_key_from_seed(seed: &[u8; 32]) -> [u8; 32] {
    let h = sha512(seed);
    let mut h32 = [0u8; 32];
    h32.copy_from_slice(&h[..32]);
    let a = clamp_scalar(&h32);
    encode_point(&scalar_mult(&a, &base_point()))
}

/// Создание пары из seed.
pub fn keypair_from_seed(seed: &[u8; 32]) -> Keypair {
    Keypair {
        public_key: public_key_from_seed(seed),
        seed: *seed,
    }
}

/// Подпись сообщения: 64 байта (R ‖ S).
pub fn sign(seed: &[u8; 32], message: &[u8]) -> [u8; 64] {
    let h = sha512(seed);
    let mut h32 = [0u8; 32];
    h32.copy_from_slice(&h[..32]);
    let a = clamp_scalar(&h32);
    let public = encode_point(&scalar_mult(&a, &base_point()));

    // r = SHA-512(prefix || M) mod L
    let mut r_input = Vec::with_capacity(32 + message.len());
    r_input.extend_from_slice(&h[32..64]);
    r_input.extend_from_slice(message);
    let r = mod_l(&limbs8(&sha512(&r_input)));

    let big_r = encode_point(&scalar_mult(&r, &base_point()));

    // k = SHA-512(R || A || M) mod L
    let mut k_input = Vec::with_capacity(64 + message.len());
    k_input.extend_from_slice(&big_r);
    k_input.extend_from_slice(&public);
    k_input.extend_from_slice(message);
    let k = mod_l(&limbs8(&sha512(&k_input)));

    // S = (r + k·a) mod L — умножение скаляров, не поля!
    let ka = mod_l(&mul_wide(&k, &a));
    let s = scalar_add_mod(&r, &ka);

    let mut out = [0u8; 64];
    out[..32].copy_from_slice(&big_r);
    out[32..].copy_from_slice(&fe_to_bytes_le(&s));
    out
}

/// 64 байта → восемь 64-битных лимбов (little-endian).
fn limbs8(b: &[u8; 64]) -> [u64; 8] {
    let mut out = [0u64; 8];
    for i in 0..8 {
        let mut buf = [0u8; 8];
        buf.copy_from_slice(&b[8 * i..8 * i + 8]);
        out[i] = u64::from_le_bytes(buf);
    }
    out
}

/// Школьное умножение двух 256-битных чисел: результат 512 бит.
fn mul_wide(a: &Fe, b: &Fe) -> [u64; 8] {
    let mut t = [0u64; 8];
    for i in 0..4 {
        let mut carry: u128 = 0;
        for j in 0..4 {
            let idx = i + j;
            let cur = (t[idx] as u128) + (a[i] as u128) * (b[j] as u128) + carry;
            t[idx] = cur as u64;
            carry = cur >> 64;
        }
        let mut k = i + 4;
        while carry > 0 && k < 8 {
            let cur = (t[k] as u128) + carry;
            t[k] = cur as u64;
            carry = cur >> 64;
            k += 1;
        }
    }
    t
}

/// 512-битное значение mod L двоичным делением (сдвиг–вычитание).
fn mod_l(t: &[u64; 8]) -> Fe {
    let mut rem = [0u64; 4];
    for i in (0..512).rev() {
        let carry_out = rem[3] >> 63;
        rem[3] = (rem[3] << 1) | (rem[2] >> 63);
        rem[2] = (rem[2] << 1) | (rem[1] >> 63);
        rem[1] = (rem[1] << 1) | (rem[0] >> 63);
        rem[0] = (rem[0] << 1) | ((t[i / 64] >> (i % 64)) & 1);
        // Остаток всегда < L < 2^253, поэтому перенос из сдвига невозможен,
        // но проверяем его для устойчивости.
        if carry_out == 1 || ge_l(&rem) {
            rem = scalar_sub(&rem, &L);
        }
    }
    rem
}

/// rem >= L ?
fn ge_l(rem: &Fe) -> bool {
    fe_cmp(rem, &L) != std::cmp::Ordering::Less
}

/// Сложение скаляров mod L.
fn scalar_add_mod(a: &Fe, b: &Fe) -> Fe {
    let mut r = [0u64; 4];
    let mut carry: u128 = 0;
    for i in 0..4 {
        let cur = (a[i] as u128) + (b[i] as u128) + carry;
        r[i] = cur as u64;
        carry = cur >> 64;
    }
    while ge_l(&r) {
        r = scalar_sub(&r, &L);
    }
    r
}

/// Вычитание скаляров mod L.
fn scalar_sub(a: &Fe, b: &Fe) -> Fe {
    let mut r = [0u64; 4];
    let mut borrow: u64 = 0;
    for i in 0..4 {
        let (d, b1) = a[i].overflowing_sub(b[i]);
        let (d2, b2) = d.overflowing_sub(borrow);
        r[i] = d2;
        borrow = (b1 as u64) + (b2 as u64);
    }
    if borrow > 0 {
        let mut carry: u128 = 0;
        for i in 0..4 {
            let cur = (r[i] as u128) + (L[i] as u128) + carry;
            r[i] = cur as u64;
            carry = cur >> 64;
        }
    }
    r
}

fn fe_to_bytes_le(a: &Fe) -> [u8; 32] {
    let mut out = [0u8; 32];
    for i in 0..4 {
        out[8 * i..8 * i + 8].copy_from_slice(&a[i].to_le_bytes());
    }
    out
}

/// Проверка подписи. Возвращает `false` при любом нарушении формата.
pub fn verify(public_key: &[u8], message: &[u8], signature: &[u8]) -> bool {
    if public_key.len() < 32 || signature.len() < 64 {
        return false;
    }
    let a = match decode_point(&public_key[..32]) {
        Some(p) => p,
        None => return false,
    };
    let mut sbuf = [0u8; 32];
    sbuf.copy_from_slice(&signature[32..64]);
    let s = fe_from_bytes_le(&sbuf);
    if ge_l(&s) {
        return false;
    }
    let big_r = match decode_point(&signature[..32]) {
        Some(p) => p,
        None => return false,
    };
    let mut k_input = Vec::with_capacity(64 + message.len());
    k_input.extend_from_slice(&signature[..32]);
    k_input.extend_from_slice(&public_key[..32]);
    k_input.extend_from_slice(message);
    let k = mod_l(&limbs8(&sha512(&k_input)));
    let left = scalar_mult(&s, &base_point());
    let right = point_add(&big_r, &scalar_mult(&k, &a));
    encode_point(&left) == encode_point(&right)
}

/// Проверка подписи массивами фиксированной длины (удобно для Solana).
pub fn verify_arrays(public_key: &[u8; 32], message: &[u8], signature: &[u8; 64]) -> bool {
    verify(public_key, message, signature)
}

/// Ошибка неверной подписи (для вызывающего кода).
pub fn ensure_signature(ok: bool) -> Result<()> {
    if ok {
        Ok(())
    } else {
        Err(Error::BadSignature("проверка ed25519 не пройдена".into()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_point_encoding() {
        assert_eq!(
            encode_point(&base_point()).to_vec(),
            vec![
                0x58, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66,
                0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66,
                0x66, 0x66, 0x66, 0x66,
            ]
        );
    }

    #[test]
    fn sign_and_verify_roundtrip() {
        let seed = [0x42u8; 32];
        let kp = keypair_from_seed(&seed);
        let msg = b"sitee: перевод в эскроу";
        let sig = sign(&seed, msg);
        assert!(verify(kp.public_key(), msg, &sig));
        // Подделка подписи
        let mut broken = sig;
        broken[10] ^= 1;
        assert!(!verify(kp.public_key(), msg, &broken));
        // Подделка сообщения
        assert!(!verify(kp.public_key(), b"sitee: другой перевод", &sig));
    }

    #[test]
    fn rfc8032_vector_1() {
        // RFC 8032, тест 1: пустое сообщение.
        let seed = [
            0x9d, 0x61, 0xb1, 0x9d, 0xef, 0xfd, 0x5a, 0x60, 0xba, 0x84, 0x4a, 0xf4, 0x92, 0xec,
            0x2c, 0xc4, 0x44, 0x49, 0xc5, 0x69, 0x7b, 0x32, 0x69, 0x19, 0x70, 0x3b, 0xac, 0x03,
            0x1c, 0xae, 0x7f, 0x60,
        ];
        let pk = public_key_from_seed(&seed);
        assert_eq!(
            pk.to_vec(),
            vec![
                0xd7, 0x5a, 0x98, 0x01, 0x82, 0xb1, 0x0a, 0xb7, 0xd5, 0x4b, 0xfe, 0xd3, 0xc9, 0x64,
                0x07, 0x3a, 0x0e, 0xe1, 0x72, 0xf3, 0xda, 0xa6, 0x23, 0x25, 0xaf, 0x02, 0x1a, 0x68,
                0xf7, 0x07, 0x51, 0x1a,
            ]
        );
        let sig = sign(&seed, b"");
        assert_eq!(
            sig.to_vec(),
            vec![
                0xe5, 0x56, 0x43, 0x00, 0xc3, 0x60, 0xac, 0x72, 0x90, 0x86, 0xe2, 0xcc, 0x80, 0x6e,
                0x82, 0x8a, 0x84, 0x87, 0x7f, 0x1e, 0xb8, 0xe5, 0xd9, 0x74, 0xd8, 0x73, 0xe0, 0x65,
                0x22, 0x49, 0x01, 0x55, 0x5f, 0xb8, 0x82, 0x15, 0x90, 0xa3, 0x3b, 0xac, 0xc6, 0x1e,
                0x39, 0x70, 0x1c, 0xf9, 0xb4, 0x6b, 0xd2, 0x5b, 0xf5, 0xf0, 0x59, 0x5b, 0xbe, 0x24,
                0x65, 0x51, 0x41, 0x43, 0x8e, 0x7a, 0x10, 0x0b,
            ]
        );
        assert!(verify(&pk, b"", &sig));
    }
}
