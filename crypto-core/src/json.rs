//! Минимальный JSON: разбор и сериализация (std-only).
//!
//! Нужен сервису crypto-core, чтобы принимать и отдавать JSON без внешних
//! крейтов. Поддерживает ровно тот набор типов, который встречается в API
//! ядра: объекты, массивы, строки, числа, bool, null.

use std::fmt::Write as _;

/// Значение JSON.
#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<Value>),
    Obj(Vec<(String, Value)>),
}

impl Value {
    /// Значение поля объекта.
    pub fn get(&self, key: &str) -> Option<&Value> {
        match self {
            Value::Obj(pairs) => pairs.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Value::Str(s) => Some(s),
            _ => None,
        }
    }

    pub fn as_f64(&self) -> Option<f64> {
        match self {
            Value::Num(n) => Some(*n),
            _ => None,
        }
    }

    pub fn as_u64(&self) -> Option<u64> {
        match self {
            Value::Num(n) if *n >= 0.0 && n.fract() == 0.0 => Some(*n as u64),
            _ => None,
        }
    }

    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Value::Bool(b) => Some(*b),
            _ => None,
        }
    }

    pub fn as_array(&self) -> Option<&[Value]> {
        match self {
            Value::Arr(a) => Some(a),
            _ => None,
        }
    }

    /// Сериализация.
    pub fn to_string(&self) -> String {
        let mut out = String::new();
        self.write(&mut out);
        out
    }

    fn write(&self, out: &mut String) {
        match self {
            Value::Null => out.push_str("null"),
            Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
            Value::Num(n) => {
                if n.fract() == 0.0 && n.abs() < 1e15 {
                    let _ = write!(out, "{}", *n as i64);
                } else {
                    let _ = write!(out, "{n}");
                }
            }
            Value::Str(s) => write_string(out, s),
            Value::Arr(a) => {
                out.push('[');
                for (i, v) in a.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    v.write(out);
                }
                out.push(']');
            }
            Value::Obj(pairs) => {
                out.push('{');
                for (i, (k, v)) in pairs.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    write_string(out, k);
                    out.push(':');
                    v.write(out);
                }
                out.push('}');
            }
        }
    }
}

fn write_string(out: &mut String, s: &str) {
    out.push('"');
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

/// Разбор JSON. Ошибка — с указанием причины.
pub fn parse(s: &str) -> Result<Value, String> {
    let mut p = Parser {
        b: s.as_bytes(),
        i: 0,
    };
    p.skip_ws();
    let v = p.value()?;
    p.skip_ws();
    if p.i != p.b.len() {
        return Err("лишние данные после JSON".into());
    }
    Ok(v)
}

struct Parser<'a> {
    b: &'a [u8],
    i: usize,
}

impl<'a> Parser<'a> {
    fn skip_ws(&mut self) {
        while self.i < self.b.len() && matches!(self.b[self.i], b' ' | b'\t' | b'\n' | b'\r') {
            self.i += 1;
        }
    }

    fn peek(&self) -> Option<u8> {
        self.b.get(self.i).copied()
    }

    fn value(&mut self) -> Result<Value, String> {
        self.skip_ws();
        let c = self.peek().ok_or("неожиданный конец JSON")?;
        match c {
            b'n' => self.lit("null", Value::Null),
            b't' => self.lit("true", Value::Bool(true)),
            b'f' => self.lit("false", Value::Bool(false)),
            b'"' => Ok(Value::Str(self.string()?)),
            b'[' => self.array(),
            b'{' => self.object(),
            b'-' | b'0'..=b'9' => self.number(),
            other => Err(format!("неожиданный символ {:?}", other as char)),
        }
    }

    fn lit(&mut self, word: &str, v: Value) -> Result<Value, String> {
        if self.b[self.i..].starts_with(word.as_bytes()) {
            self.i += word.len();
            Ok(v)
        } else {
            Err(format!("ожидалось {word}"))
        }
    }

    fn take(&mut self, n: usize) -> Option<&'a str> {
        if self.i + n > self.b.len() {
            return None;
        }
        let s = std::str::from_utf8(&self.b[self.i..self.i + n]).ok()?;
        self.i += n;
        Some(s)
    }

    fn string(&mut self) -> Result<String, String> {
        self.i += 1; // открывающая кавычка
        let mut out = String::new();
        while let Some(c) = self.peek() {
            match c {
                b'"' => {
                    self.i += 1;
                    return Ok(out);
                }
                b'\\' => {
                    self.i += 1;
                    let e = self.peek().ok_or("обрыв escape-последовательности")?;
                    self.i += 1;
                    match e {
                        b'"' => out.push('"'),
                        b'\\' => out.push('\\'),
                        b'/' => out.push('/'),
                        b'b' => out.push('\u{0008}'),
                        b'f' => out.push('\u{000C}'),
                        b'n' => out.push('\n'),
                        b'r' => out.push('\r'),
                        b't' => out.push('\t'),
                        b'u' => {
                            let hex = self.take(4).ok_or("обрыв \\u")?;
                            let mut code = u32::from_str_radix(hex, 16)
                                .map_err(|_| "неверная \\u-последовательность".to_string())?;
                            if (0xD800..0xDC00).contains(&code)
                                && self.b[self.i..].starts_with(b"\\u")
                            {
                                self.i += 2;
                                let hex2 = self.take(4).ok_or("обрыв второй \\u")?;
                                let lo = u32::from_str_radix(hex2, 16)
                                    .map_err(|_| "неверная вторая \\u".to_string())?;
                                code = 0x1_0000 + ((code - 0xD800) << 10) + (lo - 0xDC00);
                            }
                            out.push(char::from_u32(code).unwrap_or('\u{FFFD}'));
                        }
                        _ => return Err("неизвестная escape-последовательность".into()),
                    }
                }
                _ => {
                    // Обычный фрагмент (включая многобайтовый UTF-8).
                    let start = self.i;
                    let mut end = self.i + 1;
                    while end < self.b.len() && self.b[end] != b'"' && self.b[end] != b'\\' {
                        end += 1;
                    }
                    self.i = end;
                    let chunk = std::str::from_utf8(&self.b[start..end])
                        .map_err(|_| "строка не в UTF-8".to_string())?;
                    out.push_str(chunk);
                }
            }
        }
        Err("незакрытая строка".into())
    }

    fn number(&mut self) -> Result<Value, String> {
        let start = self.i;
        if self.peek() == Some(b'-') {
            self.i += 1;
        }
        while let Some(c) = self.peek() {
            if c.is_ascii_digit() || matches!(c, b'.' | b'e' | b'E' | b'+' | b'-') {
                self.i += 1;
            } else {
                break;
            }
        }
        let s = std::str::from_utf8(&self.b[start..self.i]).map_err(|_| "не число".to_string())?;
        s.parse::<f64>()
            .map(Value::Num)
            .map_err(|_| format!("не число: {s}"))
    }

    fn array(&mut self) -> Result<Value, String> {
        self.i += 1; // '['
        let mut out: Vec<Value> = Vec::new();
        self.skip_ws();
        if self.peek() == Some(b']') {
            self.i += 1;
            return Ok(Value::Arr(out));
        }
        loop {
            let v = self.value()?;
            out.push(v);
            self.skip_ws();
            match self.peek() {
                Some(b',') => {
                    self.i += 1;
                }
                Some(b']') => {
                    self.i += 1;
                    return Ok(Value::Arr(out));
                }
                _ => return Err("ожидалось «,» или «]»".into()),
            }
        }
    }

    fn object(&mut self) -> Result<Value, String> {
        self.i += 1; // '{'
        let mut out: Vec<(String, Value)> = Vec::new();
        self.skip_ws();
        if self.peek() == Some(b'}') {
            self.i += 1;
            return Ok(Value::Obj(out));
        }
        loop {
            self.skip_ws();
            if self.peek() != Some(b'"') {
                return Err("ожидался ключ объекта".into());
            }
            let k = self.string()?;
            self.skip_ws();
            if self.peek() != Some(b':') {
                return Err("ожидалось «:»".into());
            }
            self.i += 1;
            let v = self.value()?;
            out.push((k, v));
            self.skip_ws();
            match self.peek() {
                Some(b',') => {
                    self.i += 1;
                }
                Some(b'}') => {
                    self.i += 1;
                    return Ok(Value::Obj(out));
                }
                _ => return Err("ожидалось «,» или «}»".into()),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scalars_and_nesting() {
        assert_eq!(parse("null").unwrap(), Value::Null);
        assert_eq!(parse("true").unwrap(), Value::Bool(true));
        assert_eq!(parse("-12.5").unwrap(), Value::Num(-12.5));
        assert_eq!(parse("\"привет\"").unwrap(), Value::Str("привет".into()));
        let v = parse(r#"{"a":[1,2,{"b":"c"}],"d":false}"#).unwrap();
        assert_eq!(v.get("d").and_then(|x| x.as_bool()), Some(false));
        let arr = v.get("a").and_then(|x| x.as_array()).unwrap();
        assert_eq!(arr.len(), 3);
        assert_eq!(arr[2].get("b").and_then(|x| x.as_str()), Some("c"));
    }

    #[test]
    fn escapes_and_unicode() {
        let v = parse(r#""кавычка \" и \n и \u0041""#).unwrap();
        assert_eq!(v.as_str(), Some("кавычка \" и \n и A"));
        let v = parse("\"кириллица\"").unwrap();
        assert_eq!(v.as_str(), Some("кириллица"));
    }

    #[test]
    fn roundtrip() {
        let src = r#"{"id":"ord_1","amount":12.5,"ok":true,"tags":["a","b"],"n":null}"#;
        let v = parse(src).unwrap();
        assert_eq!(v.to_string(), src);
    }

    #[test]
    fn errors_reported() {
        assert!(parse("").is_err());
        assert!(parse("{").is_err());
        assert!(parse("{\"a\":}").is_err());
        assert!(parse("[1,]").is_err());
        assert!(parse("{} trailing").is_err());
        assert!(parse("\"unclosed").is_err());
    }
}
