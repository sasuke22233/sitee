//! Интероперабельность: Rust ⇄ Go ⇄ Node.
//!
//! Все векторы ниже сняты с эталонных реализаций (Go `backend/internal/cryptod`,
//! Node `tools/preview/crypto.mjs`, Python-модель на 4-limb арифметике,
//! сверенная с OpenSSL и RFC 8032). Если формат когда-либо разойдётся,
//! эти тесты упадут первыми.

use sitee_crypto_core::audit::AuditRecord;
use sitee_crypto_core::base64;
use sitee_crypto_core::blind::blind_index;
use sitee_crypto_core::dispute::{alias_for, Party};
use sitee_crypto_core::ed25519;
use sitee_crypto_core::envelope::Core;
use sitee_crypto_core::gcm;
use sitee_crypto_core::hkdf::hkdf_sha256;
use sitee_crypto_core::hmac::hmac_sha256;
use sitee_crypto_core::pbkdf2::{hash_password, verify_password};
use sitee_crypto_core::safety::safety_number;
use sitee_crypto_core::sha256::sha256;
use sitee_crypto_core::sha512::sha512;
use sitee_crypto_core::solana::{base58_encode, deposit_path, derive_account};
use sitee_crypto_core::to_hex;
use sitee_crypto_core::totp;

const KEK: [u8; 32] = [0x5a; 32];

#[test]
fn sha256_matches_go_and_node() {
    assert_eq!(
        to_hex(&sha256(b"")),
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
    assert_eq!(
        to_hex(&sha256(b"abc")),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
    assert_eq!(
        to_hex(&sha256(b"The quick brown fox jumps over the lazy dog")),
        "d7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592"
    );
}

#[test]
fn sha512_matches_go_and_node() {
    assert_eq!(
        to_hex(&sha512(b"abc")),
        "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f"
    );
}

#[test]
fn hmac_hkdf_pbkdf2_match() {
    // RFC 4231, тест 2.
    assert_eq!(
        to_hex(&hmac_sha256(b"Jefe", b"what do ya want for nothing?")),
        "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
    );
    // RFC 5869, тест 1 (L = 42).
    let ikm = [0x0bu8; 22];
    let salt: Vec<u8> = (0..=12u8).collect();
    let info: Vec<u8> = (0xf0u8..=0xf9u8).collect();
    assert_eq!(
        to_hex(&hkdf_sha256(&ikm, &salt, &info, 42)),
        "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865"
    );
    // PBKDF2-HMAC-SHA256, c = 1.
    assert_eq!(
        to_hex(&sitee_crypto_core::pbkdf2::pbkdf2_sha256(
            b"password",
            b"salt",
            1,
            32
        )),
        "120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b"
    );
    // Формат строки пароля — как в Go и Node.
    let enc = hash_password("Str0ng#Passphrase");
    let parts: Vec<&str> = enc.split('$').collect();
    assert_eq!(parts.len(), 4);
    assert_eq!(parts[0], "pbkdf2-sha256");
    assert_eq!(parts[1], "210000");
    assert!(verify_password("Str0ng#Passphrase", &enc));
    assert!(!verify_password("wrong", &enc));
}

#[test]
fn aes256_gcm_matches_node() {
    // Вектор снят с node crypto (aes-256-gcm) для ключа/IV/pt/aad.
    let key = hex32("1f8e9f2c3a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5");
    let iv = hex12("000102030405060708090a0b");
    let aad = b"msg:ord_1";
    let pt = b"sitee e2ee";
    let blob = gcm::aes256_gcm_encrypt(&key, &iv, pt, aad);
    assert_eq!(
        to_hex(&blob),
        "c3453c7b3e7752cc8928ba79fe50cc1d8574f7d8687662269f06"
    );
    assert_eq!(gcm::aes256_gcm_decrypt(&key, &iv, &blob, aad).unwrap(), pt);
}

#[test]
fn envelope_matches_go_and_node() {
    // Домен pii, объект usr_1: структура конверта и AAD совпадают с эталоном.
    let core = Core::new(&KEK).unwrap();
    let blob = core.encrypt_string("pii", "usr_1", "lena@sitee.dev").unwrap();
    // Значение снято с Node-зеркала при том же KEK: форматы идентичны.
    assert_eq!(
        blob,
        "AeUe1TVIhpLNQ+j4l7ISpofiM0g6+iu+oRt0Q6yy8valRFr+weXgEbkrBn0kg6El1KAp"
    );
    let raw = base64::decode(&blob).unwrap();
    assert_eq!(raw[0], 0x01);
    assert_eq!(raw.len(), 21 + 14 + 16);
    assert_eq!(&raw[1..9], &core.key_id("pii"));
    assert_eq!(
        core.decrypt_string("pii", "usr_1", &blob).unwrap(),
        "lena@sitee.dev"
    );
    // Домен определяет ключ: чужая расшифровка невозможна.
    assert!(core.try_decrypt("wallet", "usr_1", &blob).is_none());
}

#[test]
fn blind_index_matches() {
    let idx = blind_index(&KEK, " Lena@Sitee.dev ");
    assert_eq!(
        idx,
        "e2b9e764b72338303ac8c4fe453f33f4ea0b966c961ada2981def4f00000e21d"
    );
    assert_eq!(idx.len(), 64);
    assert_eq!(idx, blind_index(&KEK, "lena@sitee.dev"));
    assert_ne!(idx, blind_index(&KEK, "lena@sitee.org"));
}

#[test]
fn totp_matches_google_authenticator() {
    let secret = totp::decode_base32("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ").unwrap();
    assert_eq!(totp::generate_totp(&secret, 59), "287082");
    assert_eq!(totp::generate_totp(&secret, 1111111109), "081804");
    assert_eq!(totp::generate_totp(&secret, 1234567890), "005924");
    assert!(totp::validate_totp(&secret, "081804", 1111111109, 1).is_some());
}

#[test]
fn ed25519_matches_rfc8032() {
    let seed = hex32("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60");
    assert_eq!(
        to_hex(&ed25519::public_key_from_seed(&seed)),
        "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a"
    );
    let sig = ed25519::sign(&seed, b"");
    assert_eq!(
        to_hex(&sig),
        "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b"
    );
    let pk = ed25519::public_key_from_seed(&seed);
    assert!(ed25519::verify(&pk, b"", &sig));
    assert!(!ed25519::verify(&pk, b"x", &sig));
}

#[test]
fn solana_address_is_base58_of_public_key() {
    let core = Core::new(&KEK).unwrap();
    let acc = derive_account(&core, &deposit_path(0)).unwrap();
    assert_eq!(acc.path, "m/44'/501'/0'/0'");
    assert_eq!(acc.address, base58_encode(&acc.public_key));
    assert!(sitee_crypto_core::solana::is_valid_address(&acc.address));
    // Тот же путь → тот же адрес (детерминизм кастодиального кошелька).
    assert_eq!(derive_account(&core, &deposit_path(0)).unwrap().address, acc.address);
    assert_ne!(derive_account(&core, &deposit_path(1)).unwrap().address, acc.address);
}

#[test]
fn domain_formats_match() {
    // Safety number: 8 групп по 5 цифр.
    let sn = safety_number("fp_abc", "usr_a", "usr_b");
    assert_eq!(sn, safety_number("fp_abc", "usr_b", "usr_a"));
    assert_eq!(sn.split(' ').count(), 8);
    // Псевдоним в споре.
    assert_eq!(
        alias_for("d1", "usr_1", Party::Buyer),
        alias_for("d1", "usr_1", Party::Buyer)
    );
    // Хеш цепочки аудита — base64 от 32 байт.
    let rec = AuditRecord {
        id: "aud_1",
        ts: "2026-01-01T00:00:00Z",
        actor_id: "usr_1",
        actor_role: "admin",
        action: "shop.update",
        object_type: "shop",
        object_id: "shop_1",
        reason: "",
        ip: "10.0.0.1",
        totp_factor: Some("ops"),
        before: None,
        after: Some("{\"title\":\"x\"}"),
        prev_hash: None,
    };
    let h = sitee_crypto_core::audit::audit_hash(&rec);
    assert_eq!(h.len(), 44);
    assert_eq!(h, sitee_crypto_core::audit::audit_hash(&rec));
}

fn hex32(s: &str) -> [u8; 32] {
    let v = hex_bytes(s);
    let mut out = [0u8; 32];
    out.copy_from_slice(&v);
    out
}

fn hex12(s: &str) -> [u8; 12] {
    let v = hex_bytes(s);
    let mut out = [0u8; 12];
    out.copy_from_slice(&v);
    out
}

fn hex_bytes(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).expect("hex"))
        .collect()
}
