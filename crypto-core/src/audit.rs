//! Хеш-цепочка аудит-лога (docs/security.md §10).
//!
//! Каждая запись включает `prev_hash`, поэтому подделать или вынуть запись
//! нельзя: разрыв цепочки детектируется сверкой. Формат совпадает с Go
//! (`api.auditHash`) и Node (`crypto.mjs`).

use crate::base64;
use crate::hmac::hmac_sha256;

/// Соль цепочки аудита.
pub const AUDIT_SALT: &str = "sitee-audit-v1";

/// Запись аудита. Поля `before`/`after` — произвольный JSON; `None` → `null`.
#[derive(Debug, Clone, Default)]
pub struct AuditRecord<'a> {
    pub id: &'a str,
    pub ts: &'a str,
    pub actor_id: &'a str,
    pub actor_role: &'a str,
    pub action: &'a str,
    pub object_type: &'a str,
    pub object_id: &'a str,
    pub reason: &'a str,
    pub ip: &'a str,
    pub totp_factor: Option<&'a str>,
    pub before: Option<&'a str>,
    pub after: Option<&'a str>,
    pub prev_hash: Option<&'a str>,
}

/// Канонический JSON записи — порядок ключей фиксирован.
fn canonical_json(r: &AuditRecord<'_>) -> String {
    let opt = |v: Option<&str>| match v {
        Some(s) => s.to_string(),
        None => "null".to_string(),
    };
    format!(
        "{{\"id\":{},\"ts\":{},\"actor_id\":{},\"actor_role\":{},\"action\":{},\
         \"object_type\":{},\"object_id\":{},\"reason\":{},\"ip\":{},\"totp_factor\":{},\
         \"before\":{},\"after\":{},\"prev_hash\":{}}}",
        json_str(r.id),
        json_str(r.ts),
        json_str(r.actor_id),
        json_str(r.actor_role),
        json_str(r.action),
        json_str(r.object_type),
        json_str(r.object_id),
        json_str(r.reason),
        json_str(r.ip),
        opt(r.totp_factor),
        opt(r.before),
        opt(r.after),
        opt(r.prev_hash),
    )
}

/// Строка в кавычках с экранированием (достаточно для наших полей).
fn json_str(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Хеш записи: base64(HMAC-SHA256("sitee-audit-v1", канонический JSON)).
pub fn audit_hash(r: &AuditRecord<'_>) -> String {
    let payload = canonical_json(r);
    base64::encode(&hmac_sha256(AUDIT_SALT.as_bytes(), payload.as_bytes()))
}

/// Проверка цепочки: каждая запись ссылается на хеш предыдущей.
pub fn verify_chain(records: &[AuditRecord<'_>]) -> bool {
    for (i, r) in records.iter().enumerate() {
        // Хеш предыдущей записи должен жить дольше заимствования, поэтому
        // держим его в переменной внешней области видимости.
        let prev_hash;
        let expected_prev = if i == 0 {
            None
        } else {
            prev_hash = audit_hash(&records[i - 1]);
            Some(prev_hash.as_str())
        };
        let prev = r.prev_hash;
        if prev != expected_prev {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(id: &'static str, prev: Option<&'static str>) -> AuditRecord<'static> {
        AuditRecord {
            id,
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
            after: Some("{\"title\":\"новое\"}"),
            prev_hash: prev,
        }
    }

    #[test]
    fn chain_links() {
        let r1 = rec("a1", None);
        let h1 = audit_hash(&r1);
        // Связываем через 'static-строку: в тестах утечка на один раз допустима.
        let prev: &'static str = Box::leak(h1.into_boxed_str());
        let r2 = rec("a2", Some(prev));
        assert!(verify_chain(&[r1.clone(), r2]));
        // Разрыв цепочки (вторая запись без ссылки) детектируется.
        assert!(!verify_chain(&[r1.clone(), rec("a2", None)]));
        // Первая запись не должна ссылаться на прошлое.
        assert!(!verify_chain(&[rec("a1", Some("чушь"))]));
    }

    #[test]
    fn escaping() {
        let r = AuditRecord {
            reason: "кавычка \" и перенос\n",
            ..rec("a1", None)
        };
        let h = audit_hash(&r);
        assert_eq!(h.len(), 44); // base64 от 32 байт
    }
}
