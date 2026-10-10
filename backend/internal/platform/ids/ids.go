// Package ids генерирует лексикографически сортируемые идентификаторы (ULID-подобные)
// и вспомогательные случайные значения.
package ids

import (
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"sync"
	"time"
)

// crockford — алфавит base32 без неоднозначных символов (I, L, O, U).
const crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

var (
	mu       sync.Mutex
	lastMS   uint64
	lastRand [10]byte
)

// New возвращает идентификатор вида "<prefix>_01J9ZK8M2Q7Y3V4W5X6Z7A".
// Структура: 48 бит времени (мс) + 80 бит криптостойкой случайности, base32 (26 символов).
// Префикс задаёт тип сущности: usr_, ses_, enr_, shp_, sub_, prd_, ord_, cht_, msg_,
// dsp_, gft_, gpr_, rev_, wdr_, tx_, wac_, upl_, ntf_.
func New(prefix string) string {
	var buf [16]byte

	mu.Lock()
	now := uint64(time.Now().UnixMilli())
	if now <= lastMS {
		// Внутри одной миллисекунды увеличиваем случайную часть — ID остаются
		// лексикографически монотонными (важно для курсорной пагинации).
		now = lastMS
		for i := len(lastRand) - 1; i >= 0; i-- {
			lastRand[i]++
			if lastRand[i] != 0 {
				break
			}
		}
	} else {
		lastMS = now
		if _, err := rand.Read(lastRand[:]); err != nil {
			mu.Unlock()
			panic("ids: crypto/rand недоступен: " + err.Error())
		}
	}
	rnd := lastRand
	mu.Unlock()

	buf[0] = byte(now >> 40)
	buf[1] = byte(now >> 32)
	buf[2] = byte(now >> 24)
	buf[3] = byte(now >> 16)
	buf[4] = byte(now >> 8)
	buf[5] = byte(now)
	copy(buf[6:16], rnd[:])

	if prefix == "" {
		return encode32(buf)
	}
	return prefix + "_" + encode32(buf)
}

// encode32 кодирует 16 байт в 26 символов base32 (Crockford).
// Первые 13 символов покрывают старшие 64 бита, вторые 13 — младшие.
func encode32(b [16]byte) string {
	hi := binary.BigEndian.Uint64(b[0:8])
	lo := binary.BigEndian.Uint64(b[8:16])
	var out [26]byte
	for i := 0; i < 13; i++ {
		shift := 59 - i*5
		if shift >= 0 {
			out[i] = crockford[(hi>>uint(shift))&0x1F]
		} else {
			out[i] = crockford[hi&0x1F]
		}
	}
	for i := 0; i < 13; i++ {
		shift := 59 - i*5
		if shift >= 0 {
			out[13+i] = crockford[(lo>>uint(shift))&0x1F]
		} else {
			out[13+i] = crockford[lo&0x1F]
		}
	}
	return string(out[:])
}

// Bytes возвращает n криптографически случайных байт.
func Bytes(n int) []byte {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic("ids: crypto/rand недоступен: " + err.Error())
	}
	return b
}

// Hex возвращает случайный hex длиной 2n символов.
func Hex(n int) string { return hex.EncodeToString(Bytes(n)) }

// Uint64 возвращает случайное число в диапазоне [0, n).
func Uint64(n uint64) uint64 {
	if n == 0 {
		return 0
	}
	return binary.BigEndian.Uint64(Bytes(8)) % n
}
