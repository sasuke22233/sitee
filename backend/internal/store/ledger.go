package store

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/sasuke22233/sitee/backend/internal/platform/ids"
)

// Типы счетов ledger (docs/economy.md §2.1).
const (
	OwnerUser     = "user"
	OwnerUserLock = "user_locked"
	OwnerShop     = "shop"
	OwnerEscrow   = "escrow"
	OwnerPlatform = "platform"
)

// Служебные счета площадки.
const (
	PlatformFees         = "fees"
	PlatformRent         = "rent"
	PlatformCustody      = "custody"
	PlatformStarsReserve = "stars_reserve"
	PlatformWithdrawHold = "withdrawals_pending"
	GiftRevenue          = "gift_revenue"
)

// Виды проводок.
const (
	KindDeposit       = "deposit"
	KindDepositRevert = "deposit_revert"
	KindWithdraw      = "withdraw"
	KindWithdrawHold  = "withdraw_hold"
	KindWithdrawUnhold = "withdraw_unhold"
	KindOrderHold     = "order_hold"
	KindOrderRelease  = "order_release"
	KindRefund        = "refund"
	KindRent          = "rent"
	KindRentRefund    = "rent_refund"
	KindGift          = "gift"
	KindExchange      = "exchange"
	KindFee           = "fee"
	KindReward        = "reward"
	KindSeed          = "seed"
)

// Account — счёт ledger.
type Account struct {
	ID        string    `json:"id"`
	OwnerType string    `json:"owner_type"`
	OwnerID   string    `json:"owner_id"`
	Asset     string    `json:"asset"`
	Balance   int64     `json:"balance"`
	Locked    int64     `json:"locked"`
	Version   int64     `json:"version"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

// Entry — проводка (одна строка двойной записи).
type Entry struct {
	ID            string    `json:"id"`
	TxID          string    `json:"tx_id"`
	IdempotencyKey string   `json:"idempotency_key"`
	TS            time.Time `json:"ts"`
	AccountID     string    `json:"account_id"`
	Direction     string    `json:"direction"` // debit|credit
	Amount        int64     `json:"amount"`
	Asset         string    `json:"asset"`
	Kind          string    `json:"kind"`
	RefType       string    `json:"ref_type,omitempty"`
	RefID         string    `json:"ref_id,omitempty"`
	ActorID       string    `json:"actor_id,omitempty"`
}

// Ошибки ledger.
var (
	ErrInsufficientFunds = errors.New("ledger: недостаточно средств")
	ErrUnbalanced        = errors.New("ledger: операция несбалансирована")
	ErrDuplicateTx       = errors.New("ledger: операция уже исполнена (идемпотентность)")
	ErrBadAmount         = errors.New("ledger: сумма должна быть больше нуля")
	ErrUnknownAccount    = errors.New("ledger: счёт не найден")
)

// Posting — одна сторона проводки.
type Posting struct {
	AccountID string
	Direction string // "debit" | "credit"
	Amount    int64
}

// Debit — сокращение для списания.
func Debit(accountID string, amount int64) Posting {
	return Posting{AccountID: accountID, Direction: "debit", Amount: amount}
}

// Credit — сокращение для зачисления.
func Credit(accountID string, amount int64) Posting {
	return Posting{AccountID: accountID, Direction: "credit", Amount: amount}
}

// AccountIDFor формирует идентификатор счёта.
func AccountIDFor(ownerType, ownerID, asset string) string {
	return ownerType + ":" + ownerID + ":" + asset
}

// UserAccount — счёт пользователя.
func UserAccount(userID, asset string) string { return AccountIDFor(OwnerUser, userID, asset) }

// ShopAccount — счёт магазина (выручка).
func ShopAccount(shopID, asset string) string { return AccountIDFor(OwnerShop, shopID, asset) }

// EscrowAccount — счёт эскроу заказа.
func EscrowAccount(orderID, asset string) string { return AccountIDFor(OwnerEscrow, orderID, asset) }

// PlatformAccount — служебный счёт площадки.
func PlatformAccount(name, asset string) string { return AccountIDFor(OwnerPlatform, name, asset) }

// LockedAccount — счёт заблокированных средств пользователя.
func LockedAccount(userID, asset string) string { return AccountIDFor(OwnerUserLock, userID, asset) }

// EnsureAccountLocked создаёт счёт при отсутствии (вызывать под блокировкой).
func (s *Store) EnsureAccountLocked(ownerType, ownerID, asset string) *Account {
	id := AccountIDFor(ownerType, ownerID, asset)
	if a, ok := s.Accounts[id]; ok {
		return a
	}
	a := &Account{
		ID: id, OwnerType: ownerType, OwnerID: ownerID, Asset: asset,
		CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC(),
	}
	s.Accounts[id] = a
	return a
}

// BalanceLocked возвращает доступный баланс счёта.
func (s *Store) BalanceLocked(accountID string) int64 {
	if a, ok := s.Accounts[accountID]; ok {
		return a.Balance
	}
	return 0
}

// UserBalanceLocked — баланс пользователя по активу.
func (s *Store) UserBalanceLocked(userID, asset string) int64 {
	return s.BalanceLocked(UserAccount(userID, asset))
}

// PostLocked проводит операцию двойной записи.
//
// Требования: Σ debits == Σ credits, amount > 0, достаточность средств
// (для счетов platform:* допускается отрицательный баланс — служебная корреспонденция).
// Идемпотентность: повторный idempotencyKey возвращает ErrDuplicateTx без изменений.
func (s *Store) PostLocked(idempotencyKey, asset, kind, refType, refID, actorID string, postings []Posting) (string, error) {
	if idempotencyKey == "" {
		return "", errors.New("ledger: пустой idempotency_key")
	}
	if _, dup := s.TxSeen[idempotencyKey]; dup {
		return "", ErrDuplicateTx
	}
	if len(postings) < 2 {
		return "", ErrUnbalanced
	}
	var debits, credits int64
	for _, p := range postings {
		if p.Amount <= 0 {
			return "", ErrBadAmount
		}
		if p.Direction != "debit" && p.Direction != "credit" {
			return "", fmt.Errorf("ledger: неизвестное направление %q", p.Direction)
		}
		acc, ok := s.Accounts[p.AccountID]
		if !ok {
			return "", fmt.Errorf("%w: %s", ErrUnknownAccount, p.AccountID)
		}
		if acc.Asset != asset {
			return "", fmt.Errorf("ledger: счёт %s в активе %s, операция в %s", p.AccountID, acc.Asset, asset)
		}
		switch p.Direction {
		case "debit":
			debits += p.Amount
			if acc.OwnerType != OwnerPlatform && acc.Balance < p.Amount {
				return "", fmt.Errorf("%w: %s (баланс %d, нужно %d)", ErrInsufficientFunds, acc.ID, acc.Balance, p.Amount)
			}
		case "credit":
			credits += p.Amount
		}
	}
	if debits != credits {
		return "", fmt.Errorf("%w: debit=%d credit=%d", ErrUnbalanced, debits, credits)
	}

	txID := ids.New("tx")
	now := time.Now().UTC()
	for _, p := range postings {
		acc := s.Accounts[p.AccountID]
		switch p.Direction {
		case "debit":
			acc.Balance -= p.Amount
		case "credit":
			acc.Balance += p.Amount
		}
		acc.Version++
		acc.UpdatedAt = now
		s.Ledger = append(s.Ledger, &Entry{
			ID: ids.New("led"), TxID: txID, IdempotencyKey: idempotencyKey, TS: now,
			AccountID: acc.ID, Direction: p.Direction, Amount: p.Amount, Asset: asset,
			Kind: kind, RefType: refType, RefID: refID, ActorID: actorID,
		})
	}
	s.TxSeen[idempotencyKey] = true
	return txID, nil
}

// LedgerByTxLocked возвращает проводки операции.
func (s *Store) LedgerByTxLocked(txID string) []*Entry {
	out := make([]*Entry, 0, 4)
	for _, e := range s.Ledger {
		if e.TxID == txID {
			out = append(out, e)
		}
	}
	return out
}

// UserTxLocked возвращает операции пользователя (для истории платежей).
func (s *Store) UserTxLocked(userID string, limit int) []*Entry {
	out := make([]*Entry, 0, limit)
	for i := len(s.Ledger) - 1; i >= 0 && len(out) < limit; i-- {
		e := s.Ledger[i]
		if strings.HasPrefix(e.AccountID, "user:"+userID+":") ||
			strings.HasPrefix(e.AccountID, "user_locked:"+userID+":") {
			out = append(out, e)
		}
	}
	return out
}

// CheckInvariantsLocked проверяет инварианты ledger (docs/architecture.md §6).
// Возвращает список нарушений (пустой — всё в порядке).
func (s *Store) CheckInvariantsLocked() []string {
	var problems []string

	// 1) Σ debits == Σ credits по каждому активу.
	sums := map[string][2]int64{}
	for _, e := range s.Ledger {
		pair := sums[e.Asset]
		if e.Direction == "debit" {
			pair[0] += e.Amount
		} else {
			pair[1] += e.Amount
		}
		sums[e.Asset] = pair
	}
	for asset, pair := range sums {
		if pair[0] != pair[1] {
			problems = append(problems, fmt.Sprintf("актив %s: debits=%d credits=%d", asset, pair[0], pair[1]))
		}
	}

	// 2) Балансы не отрицательны (кроме platform:*).
	for id, a := range s.Accounts {
		if a.Balance < 0 && a.OwnerType != OwnerPlatform {
			problems = append(problems, fmt.Sprintf("счёт %s: отрицательный баланс %d", id, a.Balance))
		}
		if a.Locked < 0 {
			problems = append(problems, fmt.Sprintf("счёт %s: отрицательный locked %d", id, a.Locked))
		}
	}

	// 3) Эскроу активных заказов обеспечен.
	for _, o := range s.Orders {
		if o.Status == StatusPaidEscrow || o.Status == StatusProcessing ||
			o.Status == StatusDelivered || o.Status == StatusDisputeOpened ||
			o.Status == StatusInArbitration {
			asset := o.PayAsset
			if asset == "" {
				asset = AssetSOL
			}
			acc := EscrowAccount(o.ID, asset)
			bal := s.BalanceLocked(acc)
			want := o.TotalLamports
			if asset == AssetStars {
				want = o.TotalStars
			}
			if bal != want {
				problems = append(problems, fmt.Sprintf("заказ %s: эскроу %d, ожидается %d", o.ID, bal, want))
			}
		}
	}
	sort.Strings(problems)
	return problems
}

// TotalByOwnerLocked суммирует балансы группы счетов (например platform:fees).
func (s *Store) TotalByOwnerLocked(ownerType, ownerID, asset string) int64 {
	id := AccountIDFor(ownerType, ownerID, asset)
	return s.BalanceLocked(id)
}

// ---------------------------------------------------------------------------
// Форматирование сумм
// ---------------------------------------------------------------------------

// ParseSOL преобразует строку ("1.5", "0.000000001") в lamports.
func ParseSOL(v string) (int64, error) {
	t := strings.TrimSpace(v)
	if t == "" {
		return 0, errors.New("пустая сумма")
	}
	neg := false
	if t[0] == '-' {
		neg = true
		t = t[1:]
	}
	intPart, fracPart := t, ""
	if i := strings.IndexByte(t, '.'); i >= 0 {
		intPart, fracPart = t[:i], t[i+1:]
	}
	if intPart == "" && fracPart == "" {
		return 0, errors.New("некорректная сумма")
	}
	if len(fracPart) > 9 {
		fracPart = fracPart[:9]
	}
	for len(fracPart) < 9 {
		fracPart += "0"
	}
	ip, err := strconv.ParseInt(intPart, 10, 63)
	if err != nil {
		return 0, fmt.Errorf("некорректная сумма: %w", err)
	}
	fp, err := strconv.ParseInt(fracPart, 10, 63)
	if err != nil {
		return 0, fmt.Errorf("некорректная дробная часть: %w", err)
	}
	if ip > 9_000_000 {
		return 0, errors.New("сумма слишком велика")
	}
	total := ip*LamportsPerSOL + fp
	if neg {
		total = -total
	}
	return total, nil
}

// FormatSOL форматирует lamports в десятичную строку (лишние нули обрезаются).
func FormatSOL(lamports int64) string {
	neg := lamports < 0
	if neg {
		lamports = -lamports
	}
	whole := lamports / LamportsPerSOL
	frac := lamports % LamportsPerSOL
	out := strconv.FormatInt(whole, 10)
	if frac != 0 {
		fs := strconv.FormatInt(frac, 10)
		for len(fs) < 9 {
			fs = "0" + fs
		}
		fs = strings.TrimRight(fs, "0")
		out += "." + fs
	}
	if neg {
		return "-" + out
	}
	return out
}

// FormatStars форматирует звёзды с разделителем тысяч.
func FormatStars(v int64) string {
	s := strconv.FormatInt(v, 10)
	neg := false
	if strings.HasPrefix(s, "-") {
		neg, s = true, s[1:]
	}
	var b strings.Builder
	for i, r := range s {
		if i > 0 && (len(s)-i)%3 == 0 {
			b.WriteString(" ")
		}
		b.WriteRune(r)
	}
	if neg {
		return "-" + b.String()
	}
	return b.String()
}
