package api

import (
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/sasuke22233/sitee/backend/internal/antifraud"
	"github.com/sasuke22233/sitee/backend/internal/cryptod"
	"github.com/sasuke22233/sitee/backend/internal/platform/httpx"
	"github.com/sasuke22233/sitee/backend/internal/platform/ids"
	"github.com/sasuke22233/sitee/backend/internal/store"
)

// ---------------------------------------------------------------------------
// Кошелёк: кастодиальная модель (docs/solana.md, docs/economy.md §2)
// ---------------------------------------------------------------------------

func (s *Server) handleWallet(w http.ResponseWriter, r *http.Request) {
	u, ok := s.requireAuth(w, r)
	if !ok {
		return
	}
	var dto map[string]any
	s.Store.Write(func() {
		// Депозитный адрес деривируется детерминированно (SLIP-0010, docs/solana.md §3.1).
		if u.DepositAddress == "" {
			if u.Seq == 0 {
				s.Store.UserSeq++
				u.Seq = s.Store.UserSeq
			}
			path := cryptod.DepositPath(u.Seq)
			addr, err := s.Crypto.AddressOf(path)
			if err != nil {
				s.Log.Error("wallet: деривация депозитного адреса не удалась", "err", err)
			} else {
				u.DepositPath = path
				u.DepositAddress = addr
			}
		}
		dto = s.walletDTOLocked(u)
		used := s.withdrawnLast24hLocked(u.ID)
		dto["withdraw_used_24h"] = store.FormatSOL(used)
		dto["withdraw_left_24h"] = store.FormatSOL(s.Cfg.WithdrawDailyLamports - used)
		dto["warmup_until"] = u.WarmupUntil
		dto["exchange_rate"] = map[string]any{
			"sol_per_star":  s.Cfg.SOLStarsRate,
			"stars_per_sol": starsPerSOL(s.Cfg.SOLStarsRate),
			"fee_bps":       s.Cfg.ExchangeFeeBPS,
		}
		own := []*store.Withdrawal{}
		for _, wd := range s.Store.Withdrawals {
			if wd.UserID == u.ID {
				own = append(own, wd)
			}
		}
		sort.Slice(own, func(i, j int) bool { return own[i].CreatedAt.After(own[j].CreatedAt) })
		withdrawals := []map[string]any{}
		for i, wd := range own {
			if i >= 20 {
				break
			}
			withdrawals = append(withdrawals, withdrawalDTO(wd))
		}
		dto["withdrawals"] = withdrawals
	})
	httpx.JSON(w, http.StatusOK, dto)
}

func (s *Server) withdrawnLast24hLocked(userID string) int64 {
	var used int64
	for _, wd := range s.Store.Withdrawals {
		if wd.UserID == userID && wd.Asset == store.AssetSOL &&
			wd.Status != "failed" && wd.Status != "cancelled" &&
			time.Since(wd.CreatedAt) < 24*time.Hour {
			used += wd.Amount + wd.Fee
		}
	}
	return used
}

func withdrawalDTO(wd *store.Withdrawal) map[string]any {
	dto := map[string]any{
		"id": wd.ID, "asset": wd.Asset, "amount": store.FormatSOL(wd.Amount),
		"amount_raw": wd.Amount, "fee": store.FormatSOL(wd.Fee), "status": wd.Status,
		"dest_tail": addressTail(wd.DestAddress), "created_at": wd.CreatedAt,
	}
	if wd.TxID != "" {
		dto["tx_id"] = wd.TxID
	}
	if wd.Signature != "" {
		dto["signature"] = wd.Signature
	}
	if wd.ApproverID != "" {
		dto["approver_id"] = wd.ApproverID
	}
	if wd.Error != "" {
		dto["error"] = wd.Error
	}
	return dto
}

func addressTail(addr string) string {
	if len(addr) <= 8 {
		return addr
	}
	return addr[:4] + "…" + addr[len(addr)-4:]
}

func starsPerSOL(rate float64) float64 {
	if rate <= 0 {
		return 0
	}
	return 1 / rate
}

func (s *Server) handleWalletTx(w http.ResponseWriter, r *http.Request) {
	u, ok := s.requireAuth(w, r)
	if !ok {
		return
	}
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit <= 0 || limit > 100 {
		limit = 50
	}
	items := []map[string]any{}
	s.Store.Read(func() {
		for _, e := range s.Store.UserTxLocked(u.ID, limit) {
			items = append(items, map[string]any{
				"id": e.ID, "tx_id": e.TxID, "ts": e.TS, "kind": e.Kind,
				"direction": e.Direction, "amount": e.Amount, "asset": e.Asset,
				"amount_pretty": prettyAmount(e.Amount, e.Asset),
				"ref_type": e.RefType, "ref_id": e.RefID, "title": ledgerTitleRU(e),
			})
		}
	})
	httpx.JSON(w, http.StatusOK, map[string]any{
		"items": items, "total": len(items),
		"notice": "Двойная запись: у каждой операции tx_id и идемпотентностный ключ.",
	})
}

func prettyAmount(amount int64, asset string) string {
	if asset == store.AssetStars {
		return strconv.FormatInt(amount, 10) + " ⭐"
	}
	return store.FormatSOL(amount) + " SOL"
}

var ledgerTitles = map[string]string{
	store.KindDeposit:       "Пополнение (депозит SOL)",
	store.KindDepositRevert: "Отмена депозита (реорг)",
	store.KindWithdraw:      "Вывод средств",
	store.KindWithdrawHold:  "Холд на вывод",
	store.KindOrderHold:     "Оплата заказа (эскроу)",
	store.KindOrderRelease:  "Раскрытие эскроу",
	store.KindRefund:        "Возврат средств",
	store.KindRent:          "Аренда магазина",
	store.KindRentRefund:    "Возврат аренды",
	store.KindGift:          "Покупка подарка",
	store.KindExchange:      "Обмен активов",
	store.KindFee:           "Комиссия площадки",
	store.KindReward:        "Начисление",
	store.KindSeed:          "Стартовое начисление",
}

func ledgerTitleRU(e *store.Entry) string {
	sign := "+"
	if e.Direction == "debit" {
		sign = "−"
	}
	title, ok := ledgerTitles[e.Kind]
	if !ok {
		title = e.Kind
	}
	return sign + " " + title
}

// ---------------------------------------------------------------------------
// Вывод средств (docs/solana.md §4: лимиты, cooling адресов, четыре глаза)
// ---------------------------------------------------------------------------

// NetworkFeeLamports — оценка комиссии сети Solana (5000 lamports за подпись).
const NetworkFeeLamports = int64(5000)

type withdrawRequest struct {
	Asset          string `json:"asset"`
	AmountSOL      string `json:"amount_sol"`
	DestAddress    string `json:"dest_address"`
	TotpCode       string `json:"totp_code"`
	IdempotencyKey string `json:"idempotency_key"`
}

func (s *Server) handleWithdraw(w http.ResponseWriter, r *http.Request) {
	u, ok := s.requireAuth(w, r)
	if !ok {
		return
	}
	var req withdrawRequest
	if err := httpx.Decode(r, &req); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if req.Asset == "" {
		req.Asset = store.AssetSOL
	}
	if req.Asset != store.AssetSOL {
		httpx.Fail(w, r, httpx.BadRequest(
			"вывод доступен только в SOL; Stars обмениваются на SOL во вкладке «Обмен»", nil))
		return
	}
	amount, perr := store.ParseSOL(req.AmountSOL)
	if perr != nil || amount <= 0 {
		httpx.Fail(w, r, httpx.BadRequest("некорректная сумма вывода", nil))
		return
	}
	addr := strings.TrimSpace(req.DestAddress)
	if len(addr) < 32 || len(addr) > 44 || !isBase58(addr) {
		httpx.Fail(w, r, httpx.BadRequest("некорректный адрес Solana (base58, 32–44 символа)", nil))
		return
	}
	if u.DepositAddress != "" && addr == u.DepositAddress {
		httpx.Fail(w, r, httpx.BadRequest("нельзя вывести на собственный депозитный адрес", nil))
		return
	}
	if amount < s.Cfg.MinDeposit {
		httpx.Fail(w, r, httpx.BadRequest("сумма меньше минимальной ("+
			store.FormatSOL(s.Cfg.MinDeposit)+" SOL)", nil))
		return
	}
	if !s.requireOps(w, r, u, "withdraw", amount, 0, req.TotpCode) {
		return
	}

	idem := strings.TrimSpace(req.IdempotencyKey)
	if idem == "" {
		idem = "withdraw:" + u.ID + ":" + strconv.FormatInt(amount, 10) + ":" + addr
	}

	var (
		fail       *httpx.APIError
		rec        *store.Withdrawal
		riskScore  int
		riskAction string
		fourEyes   bool
	)
	s.Store.Write(func() {
		if !u.WarmupUntil.IsZero() && time.Now().UTC().Before(u.WarmupUntil) {
			fail = httpx.Forbidden("WARMUP_REQUIRED",
				"вывод доступен после прогрева аккаунта: "+u.WarmupUntil.Format(time.RFC3339))
			return
		}
		if u.Status == "restricted" || u.Status == "suspended" || u.Status == "banned" {
			fail = httpx.Forbidden("ACCOUNT_RESTRICTED", "аккаунт ограничен: вывод недоступен")
			return
		}
		used := s.withdrawnLast24hLocked(u.ID)
		if used+amount+NetworkFeeLamports > s.Cfg.WithdrawDailyLamports {
			fail = httpx.Forbidden("LIMIT_EXCEEDED", fmt.Sprintf(
				"превышен суточный лимит вывода %s SOL (осталось %s SOL)",
				store.FormatSOL(s.Cfg.WithdrawDailyLamports),
				store.FormatSOL(s.Cfg.WithdrawDailyLamports-used)))
			return
		}
		// Охлаждение нового адреса: 24 часа с первого использования.
		coolKey := "withdraw_addr:" + addr
		if raw, seen := s.Store.Settings[coolKey]; seen {
			ts, _ := raw.(string)
			if t, terr := time.Parse(time.RFC3339, ts); terr == nil {
				if wait := 24*time.Hour - time.Since(t); wait > 0 {
					fail = &httpx.APIError{
						Code: "ADDRESS_COOLING", Status: http.StatusForbidden,
						Message: "новый адрес: вывод станет доступен через " +
							strconv.Itoa(int(wait.Hours())+1) + " ч",
						Details:    map[string]any{"address": addressTail(addr)},
						RetryAfter: int(wait.Seconds()),
					}
					return
				}
			}
		} else {
			s.Store.Settings[coolKey] = time.Now().UTC().Format(time.RFC3339)
			fail = &httpx.APIError{
				Code: "ADDRESS_COOLING", Status: http.StatusForbidden,
				Message: "адрес добавлен в белый список: вывод станет доступен через 24 часа",
				Details:    map[string]any{"address": addressTail(addr)},
				RetryAfter: 24 * 3600,
			}
			return
		}

		res := antifraud.Score(antifraud.Signals{
			AccountAgeHours: int(time.Since(u.CreatedAt).Hours()),
			IPReputation:    "clean",
		})
		riskScore, riskAction = res.Score, res.Action
		u.RiskScore = res.Score
		if res.Action == "deny" {
			fail = httpx.Forbidden("FRAUD_DENIED",
				"операция отклонена антифрод-системой: "+strings.Join(res.Reasons, ", "))
			return
		}

		s.Store.EnsureAccountLocked(store.OwnerUser, u.ID, store.AssetSOL)
		s.Store.EnsureAccountLocked(store.OwnerPlatform, store.PlatformWithdrawHold, store.AssetSOL)
		if _, lerr := s.Store.PostLocked("hold:"+idem, store.AssetSOL, store.KindWithdrawHold,
			"withdrawal", idem, u.ID, []store.Posting{
				store.Debit(store.UserAccount(u.ID, store.AssetSOL), amount+NetworkFeeLamports),
				store.Credit(store.PlatformAccount(store.PlatformWithdrawHold, store.AssetSOL), amount+NetworkFeeLamports),
			}); lerr != nil {
			fail = mapLedgerError(lerr)
			return
		}

		status := "approved"
		fourEyes = amount >= s.Cfg.FourEyesLamports || riskAction == "manual_review"
		if fourEyes {
			status = "pending_approval" // правило четырёх глаз (docs/solana.md §4.4)
		}
		rec = &store.Withdrawal{
			ID: ids.New("wdr"), UserID: u.ID, Asset: store.AssetSOL, Amount: amount,
			DestAddress: addr, Status: status, Fee: NetworkFeeLamports,
			CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC(),
		}
		s.Store.Withdrawals[rec.ID] = rec
	})
	if fail != nil {
		httpx.Fail(w, r, fail)
		return
	}

	s.audit(r, u.ID, u.Role, "wallet.withdraw", "withdrawal", rec.ID, addressTail(addr), store.FactorOps, nil,
		map[string]any{
			"amount": amount, "risk_score": riskScore, "risk_action": riskAction,
			"four_eyes": fourEyes, "status": rec.Status,
		})
	if fourEyes {
		for _, adm := range s.arbiterPool() {
			s.notify(adm, "withdraw_approval", "Заявка на вывод требует подтверждения",
				store.FormatSOL(amount)+" SOL на "+addressTail(addr),
				"withdraw:"+rec.ID+":"+adm, map[string]any{"withdrawal_id": rec.ID})
		}
	}
	s.notify(u.ID, "withdraw_created", "Заявка на вывод создана",
		prettyAmount(amount, store.AssetSOL)+" → "+addressTail(addr),
		"withdraw:"+rec.ID, map[string]any{"withdrawal_id": rec.ID, "status": rec.Status})
	s.push(u.ID, "wallet.withdraw", withdrawalDTO(rec))

	dto := withdrawalDTO(rec)
	dto["four_eyes_required"] = fourEyes
	dto["risk_score"] = riskScore
	dto["notice"] = "Холд средств проведён двойной записью; подпись формируется горячим кошельком."
	httpx.JSON(w, http.StatusAccepted, dto)
}

// ---------------------------------------------------------------------------
// Обмен SOL ⇄ Stars (FR-EXC-01…05)
// ---------------------------------------------------------------------------

func (s *Server) exchangeRate() float64 {
	if s.Cfg.SOLStarsRate <= 0 {
		return 0.01
	}
	return s.Cfg.SOLStarsRate
}

// convertLocked считает выходную сумму и комиссию.
func (s *Server) convertLocked(fromAsset, toAsset string, fromAmount int64) (toAmount, fee int64, rate float64, err error) {
	rate = s.exchangeRate()
	switch {
	case fromAsset == store.AssetStars && toAsset == store.AssetSOL:
		toAmount = int64(float64(fromAmount) * rate)
	case fromAsset == store.AssetSOL && toAsset == store.AssetStars:
		if rate <= 0 {
			return 0, 0, 0, fmt.Errorf("курс не задан")
		}
		toAmount = int64(float64(fromAmount) / rate)
	default:
		return 0, 0, 0, fmt.Errorf("неподдерживаемая пара %s→%s", fromAsset, toAsset)
	}
	fee = toAmount * int64(s.Cfg.ExchangeFeeBPS) / 10000
	if fee < 0 {
		fee = 0
	}
	if toAmount-fee <= 0 {
		return 0, 0, 0, fmt.Errorf("сумма слишком мала: результат обмена равен нулю")
	}
	return toAmount - fee, fee, rate, nil
}

func (s *Server) handleExchangeQuote(w http.ResponseWriter, r *http.Request) {
	u, ok := s.requireAuth(w, r)
	if !ok {
		return
	}
	q := r.URL.Query()
	from := strings.ToUpper(orDefault(q.Get("from"), store.AssetStars))
	to := strings.ToUpper(orDefault(q.Get("to"), store.AssetSOL))
	var fromAmount int64
	if q.Get("amount_sol") != "" {
		lamports, perr := store.ParseSOL(q.Get("amount_sol"))
		if perr != nil {
			httpx.Fail(w, r, httpx.BadRequest("некорректная сумма", nil))
			return
		}
		fromAmount = lamports
		from = store.AssetSOL
		to = store.AssetStars
	} else {
		n, _ := strconv.ParseInt(orDefault(q.Get("amount_stars"), "100"), 10, 64)
		fromAmount = n
	}
	if fromAmount <= 0 {
		httpx.Fail(w, r, httpx.BadRequest("сумма должна быть больше нуля", nil))
		return
	}
	var (
		fail *httpx.APIError
		dto  map[string]any
	)
	s.Store.Write(func() {
		toAmount, fee, rate, cerr := s.convertLocked(from, to, fromAmount)
		if cerr != nil {
			fail = httpx.BadRequest(cerr.Error(), nil)
			return
		}
		quote := &store.Quote{
			ID: ids.New("qot"), UserID: u.ID, FromAsset: from, ToAsset: to,
			Rate: rate, FeeBPS: s.Cfg.ExchangeFeeBPS, FromAmount: fromAmount, ToAmount: toAmount,
			ValidUntil: time.Now().UTC().Add(30 * time.Second), CreatedAt: time.Now().UTC(),
		}
		s.Store.Quotes[quote.ID] = quote
		dto = map[string]any{
			"quote_id": quote.ID, "from_asset": from, "to_asset": to,
			"from_amount": fromAmount, "to_amount": toAmount, "fee": fee, "fee_bps": quote.FeeBPS,
			"rate": rate, "valid_until": quote.ValidUntil,
			"from_pretty": prettyAmount(fromAmount, from), "to_pretty": prettyAmount(toAmount, to),
		}
	})
	if fail != nil {
		httpx.Fail(w, r, fail)
		return
	}
	httpx.JSON(w, http.StatusOK, dto)
}

type exchangeExecuteRequest struct {
	QuoteID        string `json:"quote_id"`
	FromAsset      string `json:"from_asset"`
	ToAsset        string `json:"to_asset"`
	AmountSOL      string `json:"amount_sol"`
	AmountStars    int64  `json:"amount_stars"`
	TotpCode       string `json:"totp_code"`
	IdempotencyKey string `json:"idempotency_key"`
}

func (s *Server) handleExchangeExecute(w http.ResponseWriter, r *http.Request) {
	u, ok := s.requireAuth(w, r)
	if !ok {
		return
	}
	var req exchangeExecuteRequest
	if err := httpx.Decode(r, &req); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if !s.requireOps(w, r, u, "exchange", 0, req.AmountStars, req.TotpCode) {
		return
	}
	var (
		fail *httpx.APIError
		dto  map[string]any
		txSOL, txStars string
		from, to       string
		fromAmount     int64
		toAmount       int64
		fee            int64
		rate           float64
	)
	s.Store.Write(func() {
		if req.QuoteID != "" {
			quote := s.Store.Quotes[req.QuoteID]
			if quote == nil {
				fail = httpx.NotFound("котировка не найдена")
				return
			}
			if quote.UserID != u.ID {
				fail = httpx.Forbidden("FORBIDDEN", "котировка принадлежит другому пользователю")
				return
			}
			if time.Now().UTC().After(quote.ValidUntil) {
				fail = httpx.Conflict("QUOTE_EXPIRED", "котировка истекла, запросите новую")
				return
			}
			from, to = quote.FromAsset, quote.ToAsset
			fromAmount, toAmount, rate = quote.FromAmount, quote.ToAmount, quote.Rate
			// Комиссия уже учтена в котировке (to_amount = netto).
			fee = quote.FromAmount*int64(quote.FeeBPS)/10000 - 0
			fee = 0
			delete(s.Store.Quotes, req.QuoteID)
		} else {
			from = strings.ToUpper(orDefault(req.FromAsset, store.AssetStars))
			to = strings.ToUpper(orDefault(req.ToAsset, store.AssetSOL))
			if from == store.AssetSOL {
				lamports, perr := store.ParseSOL(req.AmountSOL)
				if perr != nil {
					fail = httpx.BadRequest("некорректная сумма", nil)
					return
				}
				fromAmount = lamports
			} else {
				fromAmount = req.AmountStars
			}
			out, feeOut, rateOut, cerr := s.convertLocked(from, to, fromAmount)
			if cerr != nil {
				fail = httpx.BadRequest(cerr.Error(), nil)
				return
			}
			toAmount, fee, rate = out, feeOut, rateOut
		}
		if fromAmount <= 0 || toAmount <= 0 {
			fail = httpx.BadRequest("некорректные суммы обмена", nil)
			return
		}

		idem := strings.TrimSpace(req.IdempotencyKey)
		if idem == "" {
			idem = "exchange:" + u.ID + ":" + from + ":" + strconv.FormatInt(fromAmount, 10) +
				":" + to + ":" + strconv.FormatInt(toAmount, 10)
		}
		// Ноги обмена (две сбалансированные проводки, docs/economy.md §2.3).
		fromPlatform := store.PlatformCustody
		toPlatform := store.PlatformStarsReserve
		if from == store.AssetSOL {
			fromPlatform, toPlatform = store.PlatformCustody, store.PlatformStarsReserve
		} else {
			fromPlatform, toPlatform = store.PlatformStarsReserve, store.PlatformCustody
		}
		s.Store.EnsureAccountLocked(store.OwnerUser, u.ID, from)
		s.Store.EnsureAccountLocked(store.OwnerPlatform, fromPlatform, from)
		s.Store.EnsureAccountLocked(store.OwnerUser, u.ID, to)
		s.Store.EnsureAccountLocked(store.OwnerPlatform, toPlatform, to)
		s.Store.EnsureAccountLocked(store.OwnerPlatform, store.PlatformFees, to)

		leg1, err1 := s.Store.PostLocked(idem+":leg_from", from, store.KindExchange, "user", u.ID, u.ID,
			[]store.Posting{
				store.Debit(store.UserAccount(u.ID, from), fromAmount),
				store.Credit(store.PlatformAccount(fromPlatform, from), fromAmount),
			})
		if err1 != nil {
			fail = mapLedgerError(err1)
			return
		}
		postings := []store.Posting{store.Debit(store.PlatformAccount(toPlatform, to), toAmount+fee)}
		if fee > 0 {
			postings = append(postings,
				store.Credit(store.UserAccount(u.ID, to), toAmount),
				store.Credit(store.PlatformAccount(store.PlatformFees, to), fee))
		} else {
			postings = append(postings, store.Credit(store.UserAccount(u.ID, to), toAmount))
		}
		leg2, err2 := s.Store.PostLocked(idem+":leg_to", to, store.KindExchange, "user", u.ID, u.ID, postings)
		if err2 != nil {
			// Компенсация первой ноги, чтобы не оставить средства «в воздухе».
			if _, cerr := s.Store.PostLocked(idem+":leg_from:revert", from, store.KindExchange,
				"user", u.ID, u.ID, []store.Posting{
					store.Debit(store.PlatformAccount(fromPlatform, from), fromAmount),
					store.Credit(store.UserAccount(u.ID, from), fromAmount),
				}); cerr != nil {
				s.Log.Error("exchange: компенсация не удалась", "err", cerr, "idem", idem)
			}
			fail = mapLedgerError(err2)
			return
		}
		txSOL, txStars = leg1, leg2
		dto = map[string]any{
			"status": "executed", "from_asset": from, "to_asset": to, "rate": rate,
			"from_amount": fromAmount, "to_amount": toAmount, "fee": fee,
			"from_pretty": prettyAmount(fromAmount, from), "to_pretty": prettyAmount(toAmount, to),
			"tx_ids": []string{leg1, leg2},
			"balances": s.walletDTOLocked(u)["balances"],
		}
	})
	if fail != nil {
		httpx.Fail(w, r, fail)
		return
	}
	s.audit(r, u.ID, u.Role, "exchange.execute", "user", u.ID, from+"→"+to, store.FactorOps, nil,
		map[string]any{
			"from_amount": fromAmount, "to_amount": toAmount, "fee": fee, "rate": rate,
			"tx_from": txSOL, "tx_to": txStars,
		})
	s.notify(u.ID, "exchange_done", "Обмен выполнен",
		prettyAmount(fromAmount, from)+" → "+prettyAmount(toAmount, to),
		"exchange:"+txSOL, map[string]any{"from": from, "to": to})
	s.push(u.ID, "wallet.updated", dto)
	httpx.JSON(w, http.StatusOK, dto)
}

func orDefault(v, def string) string {
	if strings.TrimSpace(v) == "" {
		return def
	}
	return v
}

// ---------------------------------------------------------------------------
// Звёзды Telegram и цифровые подарки (FR-STR-01…06)
// ---------------------------------------------------------------------------

type starsInvoiceRequest struct {
	AmountStars int64  `json:"amount_stars"`
	Purpose     string `json:"purpose"` // deposit|gift|rent|order
	Reference   string `json:"reference"`
}

func (s *Server) handleStarsInvoice(w http.ResponseWriter, r *http.Request) {
	u, ok := s.requireAuth(w, r)
	if !ok {
		return
	}
	var req starsInvoiceRequest
	if err := httpx.Decode(r, &req); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if req.AmountStars <= 0 || req.AmountStars > 100000 {
		httpx.Fail(w, r, httpx.BadRequest("сумма звёзд: от 1 до 100000", nil))
		return
	}
	switch req.Purpose {
	case "", "deposit":
		req.Purpose = "deposit"
	case "gift", "rent", "order":
	default:
		httpx.Fail(w, r, httpx.BadRequest("недопустимое назначение счёта", nil))
		return
	}
	invoiceID := ids.New("inv")
	payload := map[string]any{
		"invoice_id":  invoiceID,
		"user_id":     u.ID,
		"currency":    "XTR",
		"amount":      req.AmountStars,
		"purpose":     req.Purpose,
		"reference":   req.Reference,
		"created_at":  time.Now().UTC(),
		"status":      "pending",
		"bot":         s.Cfg.TGBotUsername,
	}
	s.Store.Write(func() {
		s.Store.Settings["stars_invoice:"+invoiceID] = payload
	})
	dto := map[string]any{
		"invoice_id": invoiceID, "currency": "XTR", "amount_stars": req.AmountStars,
		"purpose": req.Purpose, "status": "pending",
		"tg_payload": invoiceID, "bot_username": s.Cfg.TGBotUsername,
	}
	if s.Cfg.TGBotToken == "" {
		// Без токена бота счёт нельзя выставить через Bot API: в dev-режиме
		// предлагается тестовое зачисление (POST /api/v1/dev/simulate-deposit).
		dto["simulated"] = true
		dto["notice"] = "TG_BOT_TOKEN не задан: счёт сформирован в тестовом режиме."
		if !s.Cfg.IsProd() {
			dto["settle_hint"] = "POST /api/v1/dev/simulate-deposit {\"asset\":\"STARS\",\"amount_stars\":" +
				strconv.FormatInt(req.AmountStars, 10) + ",\"invoice_id\":\"" + invoiceID + "\"}"
		}
	} else {
		dto["simulated"] = false
		dto["notice"] = "Счёт отправляется ботом; зачисление — после webhook-подтверждения оплаты."
	}
	s.audit(r, u.ID, u.Role, "stars.invoice_create", "invoice", invoiceID, req.Purpose, "", nil,
		map[string]any{"amount_stars": req.AmountStars})
	httpx.JSON(w, http.StatusCreated, dto)
}

func (s *Server) handleListGifts(w http.ResponseWriter, r *http.Request) {
	_, ok := s.requireAuth(w, r)
	if !ok {
		return
	}
	q := r.URL.Query()
	limit, _ := strconv.Atoi(q.Get("limit"))
	if limit <= 0 || limit > 50 {
		limit = 24
	}
	rarity := q.Get("rarity")
	now := time.Now().UTC()
	items := []map[string]any{}
	s.Store.Read(func() {
		gifts := []*store.Gift{}
		for _, g := range s.Store.Gifts {
			if g.Status != "published" {
				continue
			}
			if !g.StartsAt.IsZero() && now.Before(g.StartsAt) {
				continue
			}
			if !g.EndsAt.IsZero() && now.After(g.EndsAt) {
				continue
			}
			if rarity != "" && g.Rarity != rarity {
				continue
			}
			gifts = append(gifts, g)
		}
		sort.Slice(gifts, func(i, j int) bool {
			if gifts[i].Sort != gifts[j].Sort {
				return gifts[i].Sort < gifts[j].Sort
			}
			return gifts[i].PriceStars < gifts[j].PriceStars
		})
		for _, g := range gifts {
			items = append(items, s.giftDTOLocked(g))
		}
	})
	start, end, next, hasMore := s.page(len(items), limit, q.Get("cursor"))
	httpx.JSON(w, http.StatusOK, map[string]any{
		"items": items[start:end], "next_cursor": next, "has_more": hasMore, "total": len(items),
		"rarities": []string{"common", "rare", "epic", "legendary"},
	})
}

type buyGiftRequest struct {
	Asset          string `json:"asset"`
	RecipientType  string `json:"recipient_type"` // self|user|shop
	RecipientID    string `json:"recipient_id"`
	Message        string `json:"message"`
	Qty            int    `json:"qty"`
	TotpCode       string `json:"totp_code"`
	IdempotencyKey string `json:"idempotency_key"`
}

func (s *Server) handleBuyGift(w http.ResponseWriter, r *http.Request) {
	u, ok := s.requireAuth(w, r)
	if !ok {
		return
	}
	giftID := r.PathValue("id")
	var req buyGiftRequest
	if err := httpx.Decode(r, &req); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	if req.Asset == "" {
		req.Asset = store.AssetStars
	}
	if req.Asset != store.AssetStars && req.Asset != store.AssetSOL {
		httpx.Fail(w, r, httpx.BadRequest("оплата подарка: STARS или SOL", nil))
		return
	}
	if req.RecipientType == "" {
		req.RecipientType = "self"
	}
	if req.Qty <= 0 {
		req.Qty = 1
	}
	if req.Qty > 10 {
		httpx.Fail(w, r, httpx.BadRequest("не более 10 подарков за раз", nil))
		return
	}
	if utf8len(req.Message) > 500 {
		httpx.Fail(w, r, httpx.BadRequest("сообщение к подарку: до 500 символов", nil))
		return
	}
	if !s.requireOps(w, r, u, "gift_buy", 0, 0, req.TotpCode) {
		return
	}

	var (
		fail     *httpx.APIError
		purchase *store.GiftPurchase
		gift     *store.Gift
		shop     *store.Shop
		chatID   string
		totalRaw int64
		txID     string
	)
	s.Store.Write(func() {
		g := s.Store.Gifts[giftID]
		if g == nil || g.Status != "published" {
			fail = httpx.NotFound("подарок не найден")
			return
		}
		now := time.Now().UTC()
		if !g.EndsAt.IsZero() && now.After(g.EndsAt) {
			fail = httpx.Conflict("GIFT_EXPIRED", "акция с подарком завершена")
			return
		}
		gift = g
		unit := g.PriceStars
		if req.Asset == store.AssetSOL {
			unit = g.PriceLamport
		}
		if unit <= 0 {
			fail = httpx.Conflict("ASSET_NOT_ACCEPTED", "подарок не продаётся за этот актив")
			return
		}
		total := unit * int64(req.Qty)
		totalRaw = total

		// Лимит на пользователя.
		if g.PerUserLimit > 0 {
			bought := 0
			for _, gp := range s.Store.GiftPurch {
				if gp.GiftID == g.ID && gp.BuyerID == u.ID && gp.Status != "refunded" {
					bought++
				}
			}
			if bought+req.Qty > g.PerUserLimit {
				fail = httpx.Forbidden("LIMIT_EXCEEDED", fmt.Sprintf(
					"лимит подарка: %d на пользователя (куплено %d)", g.PerUserLimit, bought))
				return
			}
		}

		// Получатель.
		recipientID := strings.TrimSpace(req.RecipientID)
		switch req.RecipientType {
		case "self":
			recipientID = u.ID
		case "user":
			if s.Store.Users[recipientID] == nil {
				fail = httpx.NotFound("получатель не найден")
				return
			}
		case "shop":
			sh := s.findShopLocked(recipientID)
			if sh == nil {
				fail = httpx.NotFound("магазин не найден")
				return
			}
			shop = sh
		default:
			fail = httpx.BadRequest("recipient_type: self|user|shop", nil)
			return
		}

		idem := strings.TrimSpace(req.IdempotencyKey)
		if idem == "" {
			idem = "gift:" + u.ID + ":" + g.ID + ":" + recipientID + ":" + strconv.FormatInt(total, 10)
		}
		revenueAccount := store.PlatformAccount(store.GiftRevenue, req.Asset)
		s.Store.EnsureAccountLocked(store.OwnerUser, u.ID, req.Asset)
		s.Store.EnsureAccountLocked(store.OwnerPlatform, store.GiftRevenue, req.Asset)
		id, lerr := s.Store.PostLocked(idem, req.Asset, store.KindGift, "gift", g.ID, u.ID,
			[]store.Posting{
				store.Debit(store.UserAccount(u.ID, req.Asset), total),
				store.Credit(revenueAccount, total),
			})
		if lerr != nil {
			fail = mapLedgerError(lerr)
			if fail.Code == "INSUFFICIENT_FUNDS" && req.Asset == store.AssetStars {
				fail.Details = map[string]any{
					"need_stars": total, "have_stars": s.Store.UserBalanceLocked(u.ID, store.AssetStars),
					"hint":        "пополните Stars: POST /api/v1/stars/invoice",
				}
			}
			return
		}
		txID = id

		gp := &store.GiftPurchase{
			ID: ids.New("gpr"), GiftID: g.ID, BuyerID: u.ID,
			RecipientType: req.RecipientType, RecipientID: recipientID,
			Asset: req.Asset, Status: "delivered", CreatedAt: now,
		}
		if req.Asset == store.AssetStars {
			gp.AmountStars = total
		} else {
			gp.AmountLamport = total
		}
		if strings.TrimSpace(req.Message) != "" {
			if ct, cerr := s.Crypto.EncryptString(store.DomainMessage, gp.ID, req.Message); cerr == nil {
				gp.MessageCT = ct
			}
		}
		s.Store.GiftPurch[gp.ID] = gp
		purchase = gp

		// Буст магазина подарком (docs/economy.md §5.4): gift_boost ≤ 0.6, ≤ 14 дней.
		if shop != nil && g.BoostsShop {
			add := g.BoostValue
			if add <= 0 {
				add = 0.05 * float64(req.Qty)
			}
			shop.GiftBoost += add * float64(req.Qty)
			if shop.GiftBoost > 0.6 {
				shop.GiftBoost = 0.6
			}
			days := g.BoostDays
			if days <= 0 || days > 14 {
				days = 14
			}
			until := now.Add(time.Duration(days) * 24 * time.Hour)
			if until.After(shop.GiftBoostUntil) {
				shop.GiftBoostUntil = until
			}
			s.feedScoresLocked()
		}
		// Карточка подарка в чат магазина (канал или поддержка).
		if shop != nil {
			for _, c := range s.Store.Chats {
				if c.ShopID == shop.ID && (c.Kind == store.ChatChannel || c.Kind == store.ChatShopSupport) {
					chatID = c.ID
					break
				}
			}
			if chatID == "" {
				if support := s.openSupportChatLocked(shop, s.Store.Users[shop.AdminUserID], u); support != nil {
					chatID = support.ID
				}
			}
			if c := s.Store.Chats[chatID]; c != nil {
				s.appendSystemMessageLocked(c, u, store.SystemPayload{
					Kind: "gift", Title: "🎁 " + g.TitleRU + " × " + strconv.Itoa(req.Qty) +
						" от " + u.Nickname,
					Amount: strconv.FormatInt(total, 10), Asset: req.Asset,
				})
			}
		}
	})
	if fail != nil {
		httpx.Fail(w, r, fail)
		return
	}

	s.audit(r, u.ID, u.Role, "gift.buy", "gift", gift.ID, req.RecipientType, store.FactorOps, nil,
		map[string]any{
			"amount": totalRaw, "asset": req.Asset, "qty": req.Qty,
			"recipient": purchase.RecipientID, "tx_id": txID,
		})
	if purchase.RecipientType != "self" && purchase.RecipientID != u.ID {
		target := purchase.RecipientID
		if shop != nil {
			target = shop.AdminUserID
		}
		s.notify(target, "gift_received", "Вам подарили «"+gift.TitleRU+"»",
			u.Nickname+" отправил(а) подарок", "gift:"+purchase.ID,
			map[string]any{"gift_id": gift.ID, "purchase_id": purchase.ID})
		s.push(target, "gift.received", map[string]any{
			"purchase_id": purchase.ID, "gift_id": gift.ID, "title": gift.TitleRU,
			"emoji": gift.Emoji, "from": u.Nickname,
		})
	}
	if chatID != "" {
		s.pushMany(s.chatPeers(chatID, u.ID), "gift.card", map[string]any{
			"chat_id": chatID, "gift_id": gift.ID, "title": gift.TitleRU, "emoji": gift.Emoji,
		})
	}
	s.push(u.ID, "wallet.updated", map[string]any{"tx_id": txID, "asset": req.Asset})

	httpx.JSON(w, http.StatusCreated, map[string]any{
		"id": purchase.ID, "gift": s.giftSafe(gift), "recipient_type": purchase.RecipientType,
		"recipient_id": purchase.RecipientID, "asset": req.Asset,
		"amount": totalRaw, "amount_pretty": prettyAmount(totalRaw, req.Asset),
		"tx_id": txID, "status": purchase.Status, "chat_id": chatID,
		"boost_applied": shop != nil && gift.BoostsShop,
	})
}

func (s *Server) giftSafe(g *store.Gift) map[string]any {
	var dto map[string]any
	s.Store.Read(func() { dto = s.giftDTOLocked(g) })
	return dto
}

func (s *Server) handleGiftInventory(w http.ResponseWriter, r *http.Request) {
	u, ok := s.requireAuth(w, r)
	if !ok {
		return
	}
	items := []map[string]any{}
	s.Store.Read(func() {
		list := []*store.GiftPurchase{}
		for _, gp := range s.Store.GiftPurch {
			if gp.BuyerID == u.ID || gp.RecipientID == u.ID {
				list = append(list, gp)
			}
		}
		sort.Slice(list, func(i, j int) bool { return list[i].CreatedAt.After(list[j].CreatedAt) })
		for _, gp := range list {
			g := s.Store.Gifts[gp.GiftID]
			item := map[string]any{
				"id": gp.ID, "gift_id": gp.GiftID, "recipient_type": gp.RecipientType,
				"recipient_id": gp.RecipientID, "asset": gp.Asset, "status": gp.Status,
				"created_at": gp.CreatedAt, "mine": gp.BuyerID == u.ID,
			}
			amount := gp.AmountStars
			if gp.Asset == store.AssetSOL {
				amount = gp.AmountLamport
			}
			item["amount"] = amount
			item["amount_pretty"] = prettyAmount(amount, gp.Asset)
			if g != nil {
				item["title"] = g.TitleRU
				item["emoji"] = g.Emoji
				item["rarity"] = g.Rarity
				item["media_url"] = g.MediaURL
				item["collectible"] = g.Collectible
			}
			if gp.MessageCT != "" {
				if plain, derr := s.Crypto.DecryptString(store.DomainMessage, gp.ID, gp.MessageCT); derr == nil {
					item["message"] = plain
				}
			}
			items = append(items, item)
		}
	})
	httpx.JSON(w, http.StatusOK, map[string]any{"items": items, "total": len(items)})
}

// ---------------------------------------------------------------------------
// Тестовое зачисление (только dev/stage): имитация депозита SOL и оплаты Stars
// ---------------------------------------------------------------------------

type simulateDepositRequest struct {
	Asset       string `json:"asset"`
	AmountSOL   string `json:"amount_sol"`
	AmountStars int64  `json:"amount_stars"`
	InvoiceID   string `json:"invoice_id"`
	Signature   string `json:"signature"`
	UserID      string `json:"user_id"`
}

func (s *Server) handleDevSimulateDeposit(w http.ResponseWriter, r *http.Request) {
	u, ok := s.requireAuth(w, r)
	if !ok {
		return
	}
	if s.Cfg.IsProd() {
		httpx.Fail(w, r, httpx.Forbidden("FORBIDDEN", "эндпоинт отключён в prod"))
		return
	}
	var req simulateDepositRequest
	if err := httpx.Decode(r, &req); err != nil {
		httpx.Fail(w, r, err)
		return
	}
	asset := strings.ToUpper(orDefault(req.Asset, store.AssetSOL))
	target := u
	if req.UserID != "" && u.Role == store.RoleSuperAdmin {
		if other := s.Store.Users[req.UserID]; other != nil {
			target = other
		}
	}
	var (
		fail   *httpx.APIError
		amount int64
		txID   string
		sig    string
	)
	switch asset {
	case store.AssetSOL:
		lamports, perr := store.ParseSOL(req.AmountSOL)
		if perr != nil || lamports <= 0 {
			httpx.Fail(w, r, httpx.BadRequest("некорректная сумма SOL", nil))
			return
		}
		amount = lamports
	case store.AssetStars:
		if req.AmountStars <= 0 {
			httpx.Fail(w, r, httpx.BadRequest("некорректная сумма звёзд", nil))
			return
		}
		amount = req.AmountStars
	default:
		httpx.Fail(w, r, httpx.BadRequest("asset: SOL или STARS", nil))
		return
	}

	s.Store.Write(func() {
		platformAcc := store.PlatformCustody
		kind := store.KindDeposit
		if asset == store.AssetStars {
			platformAcc = store.PlatformStarsReserve
		}
		idem := "deposit:" + target.ID + ":" + asset + ":" + strconv.FormatInt(amount, 10) +
			":" + orDefault(req.Signature, ids.Hex(4))
		s.Store.EnsureAccountLocked(store.OwnerUser, target.ID, asset)
		s.Store.EnsureAccountLocked(store.OwnerPlatform, platformAcc, asset)
		id, lerr := s.Store.PostLocked(idem, asset, kind, "deposit", target.ID, "", []store.Posting{
			store.Debit(store.PlatformAccount(platformAcc, asset), amount),
			store.Credit(store.UserAccount(target.ID, asset), amount),
		})
		if lerr != nil {
			fail = mapLedgerError(lerr)
			return
		}
		txID = id
		if asset == store.AssetSOL {
			if target.DepositAddress == "" {
				path := cryptod.DepositPath(target.Seq)
				if addr, aerr := s.Crypto.AddressOf(path); aerr == nil {
					target.DepositAddress, target.DepositPath = addr, path
				}
			}
			sig = orDefault(req.Signature, ids.Hex(32))
			s.Store.SolTxs[sig] = &store.SolTx{
				Signature: sig, Address: target.DepositAddress, UserID: target.ID,
				Direction: "in", AmountLamport: amount, Confirmations: s.Cfg.Confirmations,
				Status: "credited", TxID: txID, TS: time.Now().UTC(),
			}
		}
		if req.InvoiceID != "" {
			if inv, seen := s.Store.Settings["stars_invoice:"+req.InvoiceID]; seen {
				if m, isMap := inv.(map[string]any); isMap {
					m["status"] = "paid"
					m["settled_at"] = time.Now().UTC()
					m["tx_id"] = txID
				}
			}
		}
	})
	if fail != nil {
		httpx.Fail(w, r, fail)
		return
	}
	s.audit(r, u.ID, u.Role, "dev.simulate_deposit", "user", target.ID, asset, "", nil,
		map[string]any{"amount": amount, "tx_id": txID})
	s.notify(target.ID, "deposit_credited", "Баланс пополнен",
		prettyAmount(amount, asset), "deposit:"+txID, map[string]any{"tx_id": txID})
	s.push(target.ID, "wallet.updated", map[string]any{"asset": asset, "amount": amount, "tx_id": txID})

	dto := map[string]any{
		"status": "credited", "asset": asset, "amount": amount,
		"amount_pretty": prettyAmount(amount, asset), "tx_id": txID,
	}
	if sig != "" {
		dto["signature"] = sig
		dto["confirmations"] = s.Cfg.Confirmations
	}
	httpx.JSON(w, http.StatusOK, dto)
}
