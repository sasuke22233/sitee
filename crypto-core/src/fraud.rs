//! Антифрод-скоринг (docs/security.md §9).
//!
//! Семантика 1:1 с Go-движком (`internal/antifraud`), чтобы Go и Rust давали
//! одинаковые решения: сумма весов → действие. Веса подобраны так, что
//! один подозрительный сигнал не блокирует, а несколько — да.

use std::cmp::min;

/// Входные сигналы скоринга.
#[derive(Debug, Clone, Default)]
pub struct Signals {
    /// Число неудачных попыток входа подряд.
    pub login_fails: i32,
    /// Репутация IP: "clean", "tor", "vpn", "hosting", "banned".
    pub ip_reputation: String,
    /// Гео по IP не совпадает с профилем.
    pub geo_mismatch: bool,
    /// Первый вход с этого устройства.
    pub new_device: bool,
    /// Возраст аккаунта в часах.
    pub account_age_hours: i64,
    /// Пароль найден в списках утечек.
    pub weak_password: bool,
    /// Доля споров у продавца, %.
    pub dispute_rate_pct: i32,
    /// Регистраций с одного источника за час.
    pub registration_burst: i32,
    /// Сообщений в минуту (аномалия для чата).
    pub message_rate_per_min: i32,
}

/// Решение скоринга.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScoreResult {
    /// 0…1000.
    pub score: i32,
    /// allow | captcha | delay | manual_review | deny.
    pub action: String,
    /// Человекочитаемые причины (для аудита и ответа API).
    pub reasons: Vec<String>,
}

impl ScoreResult {
    /// Нужна ли ручная проверка оператором.
    pub fn needs_manual_review(&self) -> bool {
        self.action == "manual_review"
    }

    /// Операцию нужно отклонить.
    pub fn denied(&self) -> bool {
        self.action == "deny"
    }
}

/// Считает скор и действие по сигналам.
pub fn score(s: &Signals) -> ScoreResult {
    let mut total = 0i32;
    let mut reasons: Vec<String> = Vec::new();
    let mut add = |value: i32, why: &str| {
        total += value;
        reasons.push(why.to_string());
    };

    if s.login_fails > 0 {
        add(min(s.login_fails * 40, 240), "неудачные попытки входа");
    }
    match s.ip_reputation.to_lowercase().as_str() {
        "tor" => add(300, "вход из Tor"),
        "hosting" => add(200, "вход из хостинг-ASN"),
        "vpn" => add(80, "вход из VPN"),
        "banned" => add(500, "IP в бан-листе"),
        _ => {}
    }
    if s.geo_mismatch {
        add(120, "несовпадение IP-гео и профиля");
    }
    if s.new_device {
        add(60, "новое устройство");
    }
    if s.account_age_hours < 24 {
        add(100, "аккаунт младше 24 ч (прогрев)");
    }
    if s.weak_password {
        add(120, "пароль из списка утечек");
    }
    if s.dispute_rate_pct > 30 {
        add(150, "высокая доля споров");
    }
    if s.registration_burst > 3 {
        add(200, "всплеск регистраций с источника");
    }
    if s.message_rate_per_min > 60 {
        add(120, "аномальная частота сообщений");
    }
    if total > 1000 {
        total = 1000;
    }

    let action = if total >= 700 {
        "deny"
    } else if total >= 450 {
        "manual_review"
    } else if total >= 250 {
        "delay"
    } else if total >= 100 {
        "captcha"
    } else {
        "allow"
    };
    ScoreResult {
        score: total,
        action: action.to_string(),
        reasons,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_signals_allow() {
        let r = score(&Signals {
            account_age_hours: 24 * 365,
            ip_reputation: "clean".into(),
            ..Default::default()
        });
        assert_eq!(r.score, 0);
        assert_eq!(r.action, "allow");
    }

    #[test]
    fn thresholds() {
        let base = Signals {
            account_age_hours: 1000,
            ip_reputation: "clean".into(),
            ..Default::default()
        };
        // 100 → captcha
        let mut s = base.clone();
        s.account_age_hours = 1;
        assert_eq!(score(&s).action, "captcha");
        // 100 + 150 (споры) = 250 → delay
        let mut s = base.clone();
        s.account_age_hours = 1;
        s.dispute_rate_pct = 50;
        assert_eq!(score(&s).action, "delay");
        // 100 + 150 + 200 (всплеск) = 450 → manual_review
        let mut s = base.clone();
        s.account_age_hours = 1;
        s.dispute_rate_pct = 50;
        s.registration_burst = 10;
        assert_eq!(score(&s).action, "manual_review");
        // 500 (banned) + 200 (всплеск) = 700 → deny
        let mut s = base.clone();
        s.ip_reputation = "banned".into();
        s.registration_burst = 10;
        assert_eq!(score(&s).action, "deny");
        assert!(score(&s).denied());
    }

    #[test]
    fn login_fails_capped() {
        let s = Signals {
            login_fails: 100,
            // Иначе «аккаунт младше 24 ч» добавит свои 100 и тест будет
            // мерить не потолок логинов, а возраст аккаунта.
            account_age_hours: 48,
            ..Default::default()
        };
        let r = score(&s);
        assert_eq!(r.score, 240);
        assert_eq!(r.action, "delay");
    }
}
