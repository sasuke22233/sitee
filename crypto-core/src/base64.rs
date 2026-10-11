//! base64 (RFC 4648): стандартный и URL-алфавит, с выравниванием и без.
//!
//! Нужен потому, что в БД конверты и соли хранятся именно в base64 —
//! формат должен совпадать с Go (`encoding/base64`) и Node
//! (`Buffer.toString('base64')`) побайтово.

use crate::Error;

const STD: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const URL: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/// Кодирование в стандартный base64 с выравниванием `=`.
pub fn encode(data: &[u8]) -> String {
    encode_with(STD, data, true)
}

/// Кодирование в base64url без выравнивания (как `base64.RawURLEncoding`).
pub fn encode_url(data: &[u8]) -> String {
    encode_with(URL, data, false)
}

fn encode_with(table: &[u8; 64], data: &[u8], pad: bool) -> String {
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(table[((n >> 18) & 63) as usize] as char);
        out.push(table[((n >> 12) & 63) as usize] as char);
        if chunk.len() > 1 {
            out.push(table[((n >> 6) & 63) as usize] as char);
        } else if pad {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(table[(n & 63) as usize] as char);
        } else if pad {
            out.push('=');
        }
    }
    out
}

/// Декодирование стандартного base64 (`+`, `/`, `=`).
pub fn decode(s: &str) -> Result<Vec<u8>, Error> {
    decode_any(s, false)
}

/// Декодирование base64url (`-`, `_`, без выравнивания).
pub fn decode_url(s: &str) -> Result<Vec<u8>, Error> {
    decode_any(s, true)
}

fn decode_any(s: &str, url: bool) -> Result<Vec<u8>, Error> {
    let mut acc: u32 = 0;
    let mut bits: u32 = 0;
    let mut out: Vec<u8> = Vec::with_capacity(s.len() * 3 / 4);
    let mut padded = false;
    for ch in s.bytes() {
        if ch == b'=' {
            padded = true;
            continue;
        }
        if ch.is_ascii_whitespace() {
            continue;
        }
        if padded {
            // После начала выравнивания допустимы только '=' и пробелы.
            return Err(Error::Base64(format!(
                "мусор после выравнивания: {:?}",
                ch as char
            )));
        }
        let v: u32 = match ch {
            b'A'..=b'Z' => (ch - b'A') as u32,
            b'a'..=b'z' => (ch - b'a' + 26) as u32,
            b'0'..=b'9' => (ch - b'0' + 52) as u32,
            b'+' if !url => 62,
            b'/' if !url => 63,
            b'-' if url => 62,
            b'_' if url => 63,
            _ => {
                return Err(Error::Base64(format!(
                    "недопустимый символ {:?}",
                    ch as char
                )))
            }
        };
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rfc4648_vectors() {
        assert_eq!(encode(b""), "");
        assert_eq!(encode(b"f"), "Zg==");
        assert_eq!(encode(b"fo"), "Zm8=");
        assert_eq!(encode(b"foo"), "Zm9v");
        assert_eq!(encode(b"foob"), "Zm9vYg==");
        assert_eq!(encode(b"fooba"), "Zm9vYmE=");
        assert_eq!(encode(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn roundtrip() {
        for n in [0usize, 1, 2, 3, 4, 5, 31, 32, 33, 64] {
            let data: Vec<u8> = (0..n).map(|i| (i * 37 + 11) as u8).collect();
            assert_eq!(decode(&encode(&data)).unwrap(), data, "n={n}");
        }
    }

    #[test]
    fn url_alphabet_has_no_padding() {
        let out = encode_url(&[0xff, 0xfe, 0xfd]);
        assert!(!out.contains('='));
        assert!(!out.contains('+') && !out.contains('/'));
        assert_eq!(decode_url(&out).unwrap(), vec![0xff, 0xfe, 0xfd]);
    }

    #[test]
    fn bad_symbol_rejected() {
        assert!(decode("Zg=*").is_err());
    }
}
