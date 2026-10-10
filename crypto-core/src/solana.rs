//! Solana: base58, деривация адресов и подпись транзакций.
//!
//! Приватная часть выводится внутри ядра: HKDF-SHA256(KEK, "sitee-solana-v1",
//! "path:<m/44'/501'/<n>'/0'>", 32) → seed ed25519 → публичный ключ → base58.
//! Наружу отдаётся только адрес и подпись (docs/solana.md §3, §5).
//!
//! Важно: адрес — это base58 **публичного** ключа (как в настоящем Solana и
//! в Go-бэкенде), а не base58 seed.

use crate::ed25519;
use crate::envelope::Core;
use crate::hkdf::hkdf_sha256;
use crate::{Error, Result, SOLANA_PATH_PREFIX, SOLANA_SALT};

const B58: &[u8; 58] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/// Идентификатор системной программы Solana (32 нулевых байта).
pub const SYSTEM_PROGRAM_ID: [u8; 32] = [0u8; 32];

/// Максимальный размер подписываемого сообщения (пакет Solana — 1232 байта).
pub const MAX_TX_SIZE: usize = 1232;

/// Целевое назначение операции (проверяется до подписи, docs/solana.md §7).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Purpose {
    Withdraw,
    Sweep,
    Fee,
}

impl Purpose {
    pub fn as_str(&self) -> &'static str {
        match self {
            Purpose::Withdraw => "withdraw",
            Purpose::Sweep => "sweep",
            Purpose::Fee => "fee",
        }
    }

    /// Разбор строкового обозначения из запроса Go-сервиса.
    pub fn parse(s: &str) -> Option<Purpose> {
        match s {
            "withdraw" => Some(Purpose::Withdraw),
            "sweep" => Some(Purpose::Sweep),
            "fee" => Some(Purpose::Fee),
            _ => None,
        }
    }
}

/// Политика подписи: лимиты и whitelist проверяются внутри ядра.
#[derive(Debug, Clone)]
pub struct SignPolicy {
    /// Разрешённые назначения.
    pub allowed_purposes: Vec<Purpose>,
    /// Максимум лампортов за одну операцию.
    pub max_lamports_per_op: u64,
    /// Белый список адресов получателей (пустой = любой).
    pub whitelist: Vec<String>,
}

impl Default for SignPolicy {
    fn default() -> Self {
        SignPolicy {
            allowed_purposes: vec![Purpose::Withdraw, Purpose::Sweep, Purpose::Fee],
            max_lamports_per_op: 500 * 1_000_000_000,
            whitelist: Vec::new(),
        }
    }
}

/// Аккаунт: путь деривации, публичный ключ и base58-адрес.
#[derive(Debug, Clone)]
pub struct Account {
    pub path: String,
    pub public_key: [u8; 32],
    pub address: String,
}

/// Выводит аккаунт по пути деривации.
pub fn derive_account(core: &Core, path: &str) -> Result<Account> {
    if path.trim().is_empty() {
        return Err(Error::Other("пустой путь деривации".into()));
    }
    let seed = hkdf_sha256(
        core.kek(),
        SOLANA_SALT.as_bytes(),
        format!("path:{path}").as_bytes(),
        32,
    );
    let mut seed32 = [0u8; 32];
    seed32.copy_from_slice(&seed);
    let public_key = ed25519::public_key_from_seed(&seed32);
    Ok(Account {
        path: path.to_string(),
        public_key,
        address: base58_encode(&public_key),
    })
}

/// Только адрес (приватный ключ даже не материализуется наружу).
pub fn address_of(core: &Core, path: &str) -> Result<String> {
    Ok(derive_account(core, path)?.address)
}

/// Путь депозитного адреса пользователя: m/44'/501'/<index>'/0'.
pub fn deposit_path(index: u64) -> String {
    format!("{SOLANA_PATH_PREFIX}{index}'/0'")
}

/// Подпись транзакции: проверяет политику и возвращает base58-подпись.
pub fn sign_transaction(
    core: &Core,
    path: &str,
    tx: &[u8],
    purpose: Purpose,
    policy: &SignPolicy,
) -> Result<String> {
    if !policy.allowed_purposes.contains(&purpose) {
        return Err(Error::Other(format!(
            "назначение «{}» не разрешено политикой",
            purpose.as_str()
        )));
    }
    if tx.is_empty() {
        return Err(Error::Other("пустая транзакция".into()));
    }
    if tx.len() > MAX_TX_SIZE {
        return Err(Error::Other(format!(
            "транзакция {} байт больше лимита {MAX_TX_SIZE}",
            tx.len()
        )));
    }
    let seed = hkdf_sha256(
        core.kek(),
        SOLANA_SALT.as_bytes(),
        format!("path:{path}").as_bytes(),
        32,
    );
    let mut seed32 = [0u8; 32];
    seed32.copy_from_slice(&seed);
    let sig = ed25519::sign(&seed32, tx);
    Ok(base58_encode(&sig))
}

/// base58-кодирование (алфавит Bitcoin/Solana).
pub fn base58_encode(data: &[u8]) -> String {
    let zeros = data.iter().take_while(|&&b| b == 0).count();
    let mut buf = data.to_vec();
    let mut start = zeros;
    let mut digits: Vec<u8> = Vec::with_capacity(data.len() * 138 / 100 + 1);
    while start < buf.len() {
        let mut rem: u32 = 0;
        for i in start..buf.len() {
            let cur = ((rem as u32) << 8) | buf[i] as u32;
            buf[i] = (cur / 58) as u8;
            rem = cur % 58;
        }
        digits.push(rem as u8);
        while start < buf.len() && buf[start] == 0 {
            start += 1;
        }
    }
    let mut out = String::with_capacity(zeros + digits.len());
    for _ in 0..zeros {
        out.push('1');
    }
    for d in digits.iter().rev() {
        out.push(B58[*d as usize] as char);
    }
    out
}

/// Проверка whitelist получателей: пустой список означает «любой адрес».
pub fn check_whitelist(policy: &SignPolicy, to: &str) -> Result<()> {
    if policy.whitelist.is_empty() || policy.whitelist.iter().any(|a| a == to) {
        Ok(())
    } else {
        Err(Error::Other("адрес получателя не в whitelist".into()))
    }
}

/// Проверка формата адреса Solana: 32–44 символа base58.
pub fn is_valid_address(addr: &str) -> bool {
    if addr.len() < 32 || addr.len() > 44 {
        return false;
    }
    addr.bytes().all(|b| B58.contains(&b))
}

/// Компактное кодирование u16 (shortvec) — формат Solana.
pub fn compact_u16(mut v: u16, out: &mut Vec<u8>) {
    loop {
        let mut byte = (v & 0x7f) as u8;
        v >>= 7;
        if v == 0 {
            out.push(byte);
            return;
        }
        byte |= 0x80;
        out.push(byte);
    }
}

/// Длина компактного u16 в байтах.
pub fn compact_u16_len(v: u16) -> usize {
    if v < 0x80 {
        1
    } else {
        2
    }
}

/// Собирает сообщение транзакции перевода SOL (SystemProgram.transfer).
///
/// Раскладка — как в Solana transaction message:
/// `header(3) ‖ compact(аккаунты) ‖ ключи ‖ blockhash(32) ‖ compact(инструкции) ‖ инструкции`.
/// Данные инструкции: `u32 LE = 2` (Transfer) + `u64 LE` лампортов.
pub fn build_transfer_message(
    from: &[u8; 32],
    to: &[u8; 32],
    lamports: u64,
    recent_blockhash: &[u8; 32],
) -> Vec<u8> {
    let mut msg: Vec<u8> = Vec::with_capacity(128);
    // Заголовок: 1 обязательная подпись, 0 read-only с подписью, 1 read-only без.
    msg.extend_from_slice(&[1, 0, 1]);
    // Аккаунты: from, to, SystemProgram.
    compact_u16(3, &mut msg);
    msg.extend_from_slice(from);
    msg.extend_from_slice(to);
    msg.extend_from_slice(&SYSTEM_PROGRAM_ID);
    // Недавний блокхеш.
    msg.extend_from_slice(recent_blockhash);
    // Одна инструкция.
    compact_u16(1, &mut msg);
    msg.push(2); // program_id_index = SystemProgram
    compact_u16(2, &mut msg);
    msg.push(0); // аккаунт-источник
    msg.push(1); // аккаунт-получатель
    let mut data = Vec::with_capacity(12);
    data.extend_from_slice(&2u32.to_le_bytes());
    data.extend_from_slice(&lamports.to_le_bytes());
    compact_u16(data.len() as u16, &mut msg);
    msg.extend_from_slice(&data);
    msg
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base58_vectors() {
        assert_eq!(base58_encode(b"hello"), "Cn8eVZg");
        assert_eq!(base58_encode(&[0]), "1");
        assert_eq!(base58_encode(&[0, 0]), "11");
        assert_eq!(
            base58_encode(&[0, 1, 2, 3, 255]),
            "12VfYr"
        );
    }

    #[test]
    fn address_validation() {
        assert!(is_valid_address("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"));
        assert!(!is_valid_address("0OIl"));
        assert!(!is_valid_address("short"));
        assert!(!is_valid_address(&"1".repeat(45)));
    }

    #[test]
    fn deposit_paths() {
        assert_eq!(deposit_path(0), "m/44'/501'/0'/0'");
        assert_eq!(deposit_path(42), "m/44'/501'/42'/0'");
    }

    #[test]
    fn compact_u16_encoding() {
        let mut out = Vec::new();
        compact_u16(0, &mut out);
        compact_u16(127, &mut out);
        compact_u16(128, &mut out);
        compact_u16(300, &mut out);
        assert_eq!(out, vec![0x00, 0x7f, 0x80, 0x01, 0xac, 0x02]);
        assert_eq!(compact_u16_len(127), 1);
        assert_eq!(compact_u16_len(128), 2);
    }

    #[test]
    fn transfer_message_layout() {
        let from = [1u8; 32];
        let to = [2u8; 32];
        let bh = [3u8; 32];
        let msg = build_transfer_message(&from, &to, 1_000_000_000, &bh);
        // 3 (заголовок) + 1 (счёт) + 96 (ключи) + 32 (blockhash)
        // + 1 (счёт инструкций) + 1 (program) + 1 (счёт аккаунтов) + 2 (аккаунты)
        // + 1 (длина данных) + 12 (данные)
        assert_eq!(msg.len(), 3 + 1 + 96 + 32 + 1 + 1 + 1 + 2 + 1 + 12);
        assert_eq!(&msg[0..3], &[1, 0, 1]);
        assert_eq!(&msg[4..36], &from);
        assert_eq!(&msg[36..68], &to);
        assert_eq!(&msg[68..100], &SYSTEM_PROGRAM_ID);
        assert_eq!(&msg[100..132], &bh);
        // Данные инструкции: 02 00 00 00 + лампорты LE.
        assert_eq!(&msg[140..144], &2u32.to_le_bytes());
        assert_eq!(&msg[144..152], &1_000_000_000u64.to_le_bytes());
    }

    #[test]
    fn policy_blocks_unknown_purpose() {
        let core = Core::new(&[5u8; 32]).unwrap();
        let policy = SignPolicy {
            allowed_purposes: vec![Purpose::Withdraw],
            ..Default::default()
        };
        let acc = derive_account(&core, &deposit_path(1)).unwrap();
        assert!(sign_transaction(&core, &acc.path, b"tx", Purpose::Withdraw, &policy).is_ok());
        assert!(sign_transaction(&core, &acc.path, b"tx", Purpose::Sweep, &policy).is_err());
        assert!(sign_transaction(&core, &acc.path, b"", Purpose::Withdraw, &policy).is_err());
        assert!(sign_transaction(&core, &acc.path, &[0u8; 2000], Purpose::Withdraw, &policy).is_err());
        // Whitelist: незнакомый получатель отклоняется.
        let strict = SignPolicy {
            whitelist: vec!["9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM".into()],
            ..Default::default()
        };
        assert!(check_whitelist(&strict, "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM").is_ok());
        assert!(check_whitelist(&strict, "11111111111111111111111111111111").is_err());
        assert!(check_whitelist(&Default::default(), "любой").is_ok());
        assert_eq!(acc.address.len(), 44);
        assert!(is_valid_address(&acc.address));
    }

    #[test]
    fn signature_verifies() {
        let core = Core::new(&[7u8; 32]).unwrap();
        let acc = derive_account(&core, &deposit_path(9)).unwrap();
        let msg = build_transfer_message(&acc.public_key, &[8u8; 32], 5, &[9u8; 32]);
        let policy = SignPolicy::default();
        let sig_b58 = sign_transaction(&core, &acc.path, &msg, Purpose::Withdraw, &policy).unwrap();
        let sig = base58_decode(&sig_b58).unwrap();
        assert!(ed25519::verify(&acc.public_key, &msg, &sig));
    }
}

/// base58-декодирование (нужно тестам и проверке входящих адресов).
pub fn base58_decode(s: &str) -> Result<Vec<u8>> {
    let mut num: Vec<u8> = vec![0];
    for ch in s.bytes() {
        let idx = match B58.iter().position(|&b| b == ch) {
            Some(i) => i,
            None => return Err(Error::Base64("не base58 символ".into())),
        };
        let mut carry = idx as u32;
        for byte in num.iter_mut() {
            let cur = (*byte as u32) * 58 + carry;
            *byte = (cur & 0xff) as u8;
            carry = cur >> 8;
        }
        while carry > 0 {
            num.push((carry & 0xff) as u8);
            carry >>= 8;
        }
    }
    let zeros = s.bytes().take_while(|&b| b == b'1').count();
    let mut out = vec![0u8; zeros];
    out.extend(num.iter().rev());
    Ok(out)
}
