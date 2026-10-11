//! Конверт шифрования v1 и ключи доменов.
//!
//! Формат (совпадает с Go `cryptod` и Node `tools/preview/crypto.mjs`):
//! ```text
//! [0]       версия = 0x01
//! [1:9]     key_id  — 8 байт, версия DEK домена
//! [9:21]    nonce   — 12 байт GCM
//! [21:]     ciphertext || tag(16)
//! AAD       = "<domain>:<object_id>"
//! ```
//! В БД хранится base64 всей структуры. Смена KEK делает старые key_id
//! невалидными — это и есть механизм ротации (docs/security.md §3).

use crate::base64;
use crate::gcm;
use crate::hkdf::hkdf_sha256;
use crate::rand::nonce12;
use crate::sha256::sha256;
use crate::{timing_safe_equal, to_hex, Error, Result, DEK_SALT, ENVELOPE_VERSION};

/// Длина ключевого идентификатора.
pub const KEY_ID_LEN: usize = 8;
/// Длина nonce.
pub const NONCE_LEN: usize = 12;
/// Длина тега GCM.
pub const TAG_LEN: usize = 16;
/// Длина заголовка конверта.
pub const HEADER_LEN: usize = 1 + KEY_ID_LEN + NONCE_LEN;
/// Соль для ключа служебной подписи.
pub const SIGN_SALT: &str = "sitee-sign-v1";
/// Контекст ключа служебной подписи.
pub const SIGN_INFO: &str = "service-hmac";

/// Ядро криптографии: держит KEK окружения и выводит из него рабочие ключи.
pub struct Core {
    kek: [u8; 32],
    fp: String,
}

impl Core {
    /// Создаёт ядро из 32-байтного KEK (hex из окружения декодирует вызывающий).
    pub fn new(kek: &[u8]) -> Result<Core> {
        if kek.len() != 32 {
            return Err(Error::BadKeyLength {
                expected: 32,
                got: kek.len(),
            });
        }
        let mut k = [0u8; 32];
        k.copy_from_slice(kek);
        let fp = to_hex(&sha256(&k)[..8]);
        Ok(Core { kek: k, fp })
    }

    /// Короткий отпечаток KEK для логов (не раскрывает ключ).
    pub fn fingerprint(&self) -> &str {
        &self.fp
    }

    /// Доступ к KEK (только внутри крейта; наружу не отдаётся).
    pub(crate) fn kek(&self) -> &[u8; 32] {
        &self.kek
    }

    /// Рабочий ключ домена: HKDF-SHA256(KEK, "sitee-dek-v1", "domain:"+домен).
    pub fn domain_key(&self, domain: &str) -> [u8; 32] {
        let info = format!("domain:{domain}");
        let out = hkdf_sha256(&self.kek, DEK_SALT.as_bytes(), info.as_bytes(), 32);
        let mut k = [0u8; 32];
        k.copy_from_slice(&out);
        k
    }

    /// Идентификатор версии ключа домена: SHA-256("sitee-keyid-v1:…")[:8].
    pub fn key_id(&self, domain: &str) -> [u8; 8] {
        let pre = format!("sitee-keyid-v1:{domain}:{}", self.fp);
        let d = sha256(pre.as_bytes());
        let mut id = [0u8; 8];
        id.copy_from_slice(&d[..8]);
        id
    }

    /// Шифрование в конверт v1, результат — base64.
    pub fn encrypt(&self, domain: &str, object_id: &str, plaintext: &[u8]) -> Result<String> {
        let nonce = nonce12();
        self.encrypt_with_nonce(domain, object_id, plaintext, &nonce)
    }

    /// Шифрование с заданным nonce.
    ///
    /// Нужно для тестов интероперабельности: `encrypt` берёт nonce из
    /// `rand`, поэтому его результат невоспроизводим, и сравнить байты с
    /// эталоном Go/Node невозможно. Боевой код использует только `encrypt`.
    pub fn encrypt_with_nonce(
        &self,
        domain: &str,
        object_id: &str,
        plaintext: &[u8],
        nonce: &[u8; NONCE_LEN],
    ) -> Result<String> {
        let dek = self.domain_key(domain);
        let aad = format!("{domain}:{object_id}");
        let body = gcm::aes256_gcm_encrypt(&dek, nonce, plaintext, aad.as_bytes())?;
        let mut env = Vec::with_capacity(HEADER_LEN + body.len());
        env.push(ENVELOPE_VERSION);
        env.extend_from_slice(&self.key_id(domain));
        env.extend_from_slice(nonce);
        env.extend_from_slice(&body);
        Ok(base64::encode(&env))
    }

    /// Удобная обёртка для строк.
    pub fn encrypt_string(&self, domain: &str, object_id: &str, plaintext: &str) -> Result<String> {
        self.encrypt(domain, object_id, plaintext.as_bytes())
    }

    /// Расшифровка конверта. Ошибка при чужом key_id, версии или теге.
    pub fn decrypt(&self, domain: &str, object_id: &str, blob: &str) -> Result<Vec<u8>> {
        let raw = base64::decode(blob)?;
        if raw.len() < HEADER_LEN + TAG_LEN || raw[0] != ENVELOPE_VERSION {
            return Err(Error::BadEnvelope(
                "неверная версия или недостаточная длина".into(),
            ));
        }
        let key_id = &raw[1..1 + KEY_ID_LEN];
        if !timing_safe_equal(key_id, &self.key_id(domain)) {
            return Err(Error::BadEnvelope(
                "key_id не принадлежит домену (ротация KEK?)".into(),
            ));
        }
        let mut nonce = [0u8; NONCE_LEN];
        nonce.copy_from_slice(&raw[1 + KEY_ID_LEN..HEADER_LEN]);
        let dek = self.domain_key(domain);
        let aad = format!("{domain}:{object_id}");
        gcm::aes256_gcm_decrypt(&dek, &nonce, &raw[HEADER_LEN..], aad.as_bytes())
    }

    /// Расшифровка в строку UTF-8.
    pub fn decrypt_string(&self, domain: &str, object_id: &str, blob: &str) -> Result<String> {
        let bytes = self.decrypt(domain, object_id, blob)?;
        String::from_utf8(bytes).map_err(|e| Error::Other(format!("не UTF-8: {e}")))
    }

    /// Расшифровка без ошибки: `None`, если конверт не наш.
    pub fn try_decrypt(&self, domain: &str, object_id: &str, blob: &str) -> Option<Vec<u8>> {
        self.decrypt(domain, object_id, blob).ok()
    }

    /// HMAC для служебных подписей (идемпотентность, вебхуки).
    pub fn service_hmac(&self, msg: &[u8]) -> [u8; 32] {
        let key = hkdf_sha256(&self.kek, SIGN_SALT.as_bytes(), SIGN_INFO.as_bytes(), 32);
        crate::hmac::hmac_sha256(&key, msg)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::DOMAINS;

    #[test]
    fn envelope_roundtrip_all_domains() {
        let core = Core::new(&[0x5au8; 32]).unwrap();
        for domain in DOMAINS {
            let blob = core
                .encrypt_string(domain, "obj_1", "секрет")
                .expect("шифрование");
            assert_eq!(
                core.decrypt_string(domain, "obj_1", &blob).unwrap(),
                "секрет"
            );
            // Другой объект — отказ (AAD привязан к object_id).
            assert!(core.try_decrypt(domain, "obj_2", &blob).is_none());
            // Чужой домен — отказ по key_id. Домен выбираем гарантированно
            // другим: с фиксированным "wallet" проверка ломалась ровно на той
            // итерации, где domain == "wallet" (это не чужой домен).
            let other = DOMAINS
                .iter()
                .find(|d| **d != domain)
                .copied()
                .expect("доменов больше одного");
            assert!(core.try_decrypt(other, "obj_1", &blob).is_none());
        }
    }

    #[test]
    fn wrong_kek_rejected() {
        let a = Core::new(&[1u8; 32]).unwrap();
        let b = Core::new(&[2u8; 32]).unwrap();
        let blob = a.encrypt_string("pii", "u1", "data").unwrap();
        assert!(b.try_decrypt("pii", "u1", &blob).is_none());
        assert_ne!(a.fingerprint(), b.fingerprint());
    }

    #[test]
    fn bad_length_key() {
        assert!(Core::new(&[0u8; 16]).is_err());
    }
}
