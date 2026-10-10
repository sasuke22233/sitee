//! Токен-бакет лимитер (docs/security.md §8) — семантика как в Go
//! (`internal/antifraud.Limiter`), поэтому оба движка согласованы.
//!
//! Профили: устойчивая скорость (LimitPerMin) + всплеск (Burst). Серия
//! отказов (BlockAfter) приводит ко временной блокировке ключа — это и есть
//! защита от брутфорса; общий лимит — от DDoS.

use std::collections::HashMap;
use std::time::{Duration, Instant};

/// Профиль лимитов.
#[derive(Debug, Clone, Copy)]
pub struct Profile {
    pub name: &'static str,
    /// Устойчивая скорость, токенов в минуту.
    pub limit_per_min: f64,
    /// Размер ведра.
    pub burst: f64,
    /// Сколько отказов подряд → временный бан.
    pub block_after: u32,
    /// Длительность бана, секунды.
    pub block_for_secs: u64,
}

/// Публичные чтения: 60/мин, всплеск 20.
pub const PROFILE_PUBLIC: Profile = Profile {
    name: "public",
    limit_per_min: 60.0,
    burst: 20.0,
    block_after: 0,
    block_for_secs: 0,
};
/// Логин: 10/мин, всплеск 5, бан 15 минут после 20 отказов.
pub const PROFILE_AUTH: Profile = Profile {
    name: "auth",
    limit_per_min: 10.0,
    burst: 5.0,
    block_after: 20,
    block_for_secs: 900,
};
/// 2FA: 12/мин, всплеск 2, бан 30 минут после 10 отказов.
pub const PROFILE_2FA: Profile = Profile {
    name: "2fa",
    limit_per_min: 12.0,
    burst: 2.0,
    block_after: 10,
    block_for_secs: 1800,
};
/// Платежи: 10/мин, всплеск 4.
pub const PROFILE_PAYMENT: Profile = Profile {
    name: "payment",
    limit_per_min: 10.0,
    burst: 4.0,
    block_after: 0,
    block_for_secs: 0,
};
/// Записи: 120/мин, всплеск 40.
pub const PROFILE_WRITE: Profile = Profile {
    name: "write",
    limit_per_min: 120.0,
    burst: 40.0,
    block_after: 0,
    block_for_secs: 0,
};
/// Админские операции: 120/мин, всплеск 40.
pub const PROFILE_ADMIN: Profile = Profile {
    name: "admin",
    limit_per_min: 120.0,
    burst: 40.0,
    block_after: 0,
    block_for_secs: 0,
};
/// WS-подключения: 5/мин, всплеск 3, бан 10 минут после 10 отказов.
pub const PROFILE_WS_CONN: Profile = Profile {
    name: "ws-connect",
    limit_per_min: 5.0,
    burst: 3.0,
    block_after: 10,
    block_for_secs: 600,
};
/// WS-сообщения: 60/мин, всплеск 20.
pub const PROFILE_WS_MSG: Profile = Profile {
    name: "ws-msg",
    limit_per_min: 60.0,
    burst: 20.0,
    block_after: 0,
    block_for_secs: 0,
};
/// Регистрация: 3/мин, всплеск 3, бан 24 часа после 3 отказов.
pub const PROFILE_REGISTER: Profile = Profile {
    name: "register",
    limit_per_min: 3.0,
    burst: 3.0,
    block_after: 3,
    block_for_secs: 86_400,
};
/// Поиск: 30/мин, всплеск 10.
pub const PROFILE_SEARCH: Profile = Profile {
    name: "search",
    limit_per_min: 30.0,
    burst: 10.0,
    block_after: 0,
    block_for_secs: 0,
};

/// Все профили — для инициализации счётчиков статистики.
pub const PROFILES: [Profile; 10] = [
    PROFILE_PUBLIC,
    PROFILE_AUTH,
    PROFILE_2FA,
    PROFILE_PAYMENT,
    PROFILE_WRITE,
    PROFILE_ADMIN,
    PROFILE_WS_CONN,
    PROFILE_WS_MSG,
    PROFILE_REGISTER,
    PROFILE_SEARCH,
];

/// Решение по запросу.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Decision {
    pub allowed: bool,
    /// Остаток токенов.
    pub remaining: u32,
    /// Через сколько секунд можно повторить.
    pub retry_after_secs: u64,
    /// Ключ временно заблокирован.
    pub blocked: bool,
    /// Лимит ведра (для заголовков).
    pub limit: u32,
    /// Имя профиля.
    pub profile: &'static str,
    /// Через сколько миллисекунд ведро восстановится полностью.
    pub reset_in_ms: u64,
}

#[derive(Debug, Clone)]
struct Bucket {
    tokens: f64,
    updated: Instant,
    blocked_until: Option<Instant>,
    rejects: u32,
}

/// Лимитер в памяти (в проде — те же счётчики в Redis, см. docs).
#[derive(Debug)]
pub struct Limiter {
    buckets: HashMap<String, Bucket>,
    hits: HashMap<&'static str, u64>,
    blocks: HashMap<&'static str, u64>,
}

impl Default for Limiter {
    fn default() -> Self {
        Self::new()
    }
}

impl Limiter {
    pub fn new() -> Self {
        let mut hits = HashMap::new();
        let mut blocks = HashMap::new();
        for p in PROFILES {
            hits.insert(p.name, 0);
            blocks.insert(p.name, 0);
        }
        Limiter {
            buckets: HashMap::new(),
            hits,
            blocks,
        }
    }

    /// Проверяет разрешение на операцию и списывает токен при успехе.
    pub fn allow(&mut self, key: &str, p: Profile) -> Decision {
        let now = Instant::now();
        *self.hits.entry(p.name).or_insert(0) += 1;
        let bucket = self
            .buckets
            .entry(key.to_string())
            .or_insert_with(|| Bucket {
                tokens: p.burst,
                updated: now,
                blocked_until: None,
                rejects: 0,
            });

        let elapsed = now.saturating_duration_since(bucket.updated).as_secs_f64();
        if elapsed > 0.0 {
            bucket.tokens += elapsed * (p.limit_per_min / 60.0);
            if bucket.tokens > p.burst {
                bucket.tokens = p.burst;
            }
            bucket.updated = now;
        }

        let mut decision = Decision {
            allowed: false,
            remaining: bucket.tokens as u32,
            retry_after_secs: 0,
            blocked: false,
            limit: p.burst as u32,
            profile: p.name,
            reset_in_ms: (Duration::from_secs(60).as_millis() as f64 / p.limit_per_min) as u64,
        };

        if let Some(until) = bucket.blocked_until {
            if until > now {
                decision.blocked = true;
                decision.retry_after_secs = until.saturating_duration_since(now).as_secs();
                return decision;
            }
        }

        if bucket.tokens >= 1.0 {
            bucket.tokens -= 1.0;
            bucket.rejects = 0;
            decision.allowed = true;
            decision.remaining = bucket.tokens as u32;
            return decision;
        }

        let need = 1.0 - bucket.tokens;
        let mut retry = (need / (p.limit_per_min / 60.0)) as u64;
        if retry == 0 {
            retry = 1;
        }
        decision.retry_after_secs = retry;
        bucket.rejects += 1;
        if p.block_after > 0 && bucket.rejects >= p.block_after {
            bucket.blocked_until = Some(now + Duration::from_secs(p.block_for_secs));
            bucket.rejects = 0;
            decision.blocked = true;
            decision.retry_after_secs = p.block_for_secs;
            *self.blocks.entry(p.name).or_insert(0) += 1;
        }
        decision
    }

    /// Явная блокировка ключа (например, после детекта атаки).
    pub fn block(&mut self, key: &str, secs: u64) {
        let now = Instant::now();
        let bucket = self.buckets.entry(key.to_string()).or_insert(Bucket {
            tokens: 0.0,
            updated: now,
            blocked_until: None,
            rejects: 0,
        });
        bucket.blocked_until = Some(now + Duration::from_secs(secs));
    }

    /// Снятие блокировки.
    pub fn unblock(&mut self, key: &str) {
        if let Some(bucket) = self.buckets.get_mut(key) {
            bucket.blocked_until = None;
            bucket.rejects = 0;
        }
    }

    /// Остаток блокировки в секундах.
    pub fn is_blocked(&self, key: &str) -> Option<u64> {
        let bucket = self.buckets.get(key)?;
        let until = bucket.blocked_until?;
        let now = Instant::now();
        if until > now {
            Some(until.saturating_duration_since(now).as_secs())
        } else {
            None
        }
    }

    /// Статистика по профилям: hits / blocks.
    pub fn stats(&self) -> HashMap<&'static str, (u64, u64)> {
        let mut out = HashMap::new();
        for p in PROFILES {
            let hits = self.hits.get(p.name).copied().unwrap_or(0);
            let blocks = self.blocks.get(p.name).copied().unwrap_or(0);
            out.insert(p.name, (hits, blocks));
        }
        out
    }

    /// Удаление протухших ведер (вызывать по расписанию).
    pub fn gc(&mut self, older_than_secs: u64) -> usize {
        let now = Instant::now();
        let before = self.buckets.len();
        self.buckets.retain(|_, b| {
            let idle = now.saturating_duration_since(b.updated).as_secs_f64();
            let still_blocked = b.blocked_until.map(|u| u > now).unwrap_or(false);
            still_blocked || idle < older_than_secs as f64
        });
        before - self.buckets.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn burst_then_throttle() {
        let mut l = Limiter::new();
        // Ведро начинает полным: первые burst запросов проходят.
        let mut ok = 0;
        for _ in 0..(PROFILE_PUBLIC.burst as u32) {
            if l.allow("ip:1", PROFILE_PUBLIC).allowed {
                ok += 1;
            }
        }
        assert_eq!(ok, PROFILE_PUBLIC.burst as u32);
        let d = l.allow("ip:1", PROFILE_PUBLIC);
        assert!(!d.allowed);
        assert!(d.retry_after_secs >= 1);
    }

    #[test]
    fn brute_force_blocks() {
        let mut l = Limiter::new();
        // Всплеск 2: первый и второй проходят, дальше отказы.
        assert!(l.allow("ip:brute", PROFILE_AUTH).allowed);
        assert!(l.allow("ip:brute", PROFILE_AUTH).allowed);
        let mut blocked = false;
        for _ in 0..(PROFILE_AUTH.block_after + 5) {
            let d = l.allow("ip:brute", PROFILE_AUTH);
            if d.blocked {
                blocked = true;
            }
        }
        assert!(blocked, "серия отказов должна приводить к бану");
        assert!(l.is_blocked("ip:brute").is_some());
        l.unblock("ip:brute");
        assert!(l.is_blocked("ip:brute").is_none());
    }

    #[test]
    fn other_keys_unaffected() {
        let mut l = Limiter::new();
        for _ in 0..30 {
            l.allow("ip:a", PROFILE_AUTH);
        }
        assert!(l.allow("ip:b", PROFILE_AUTH).allowed);
    }

    #[test]
    fn stats_and_gc() {
        let mut l = Limiter::new();
        l.allow("ip:1", PROFILE_PUBLIC);
        let stats = l.stats();
        assert_eq!(stats.get(PROFILE_PUBLIC.name), Some(&(1, 0)));
        assert_eq!(l.gc(0), 1); // ведро протухло по времени простоя
    }
}
