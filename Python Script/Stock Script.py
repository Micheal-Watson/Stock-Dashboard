"""
Stock Dashboard — JSON File Bridge
------------------------------------
Fetches stock data from Yahoo Finance, runs signal analysis + DCF valuation,
optionally gets an AI overview, then writes everything to stock_data.json.

Ignition reads that JSON file via a Gateway Timer Script and pushes values
into Memory Tags, which your Perspective dashboard binds to.

HOW TO CHANGE YOUR WATCHLIST:
  Edit config.json → "stocks" array → restart this script.
  Canadian stocks: use Yahoo Finance tickers TD.TO, ENB.TO, etc.

HOW TO ENABLE AI OVERVIEWS:
  1. Get a free Groq API key at https://console.groq.com (no credit card)
  2. In config.json set "ai_enabled": true and paste your key into "ai_api_key"
  3. Restart the script

WHY JSON INSTEAD OF OPC-UA:
  asyncua (the OPC-UA library) has a compatibility bug with Python 3.14 that
  causes Browse requests to silently fail. The JSON file bridge is simpler,
  easier to debug (just open the file), and has zero compatibility issues.
"""

import asyncio
import json
import logging
import os
import tempfile
from datetime import datetime
from pathlib import Path

import pandas as pd
import requests
import yfinance as yf

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

CONFIG_PATH  = Path(__file__).parent / "config.json"
OUTPUT_PATH  = Path(__file__).parent / "stock_data.json"  # Ignition reads this file


def load_config():
    with open(CONFIG_PATH) as f:
        return json.load(f)


# ══════════════════════════════════════════════════════════════════════════════
# SECTION 1 — SIGNAL ANALYSIS
# ══════════════════════════════════════════════════════════════════════════════

def compute_rsi(series: pd.Series, period: int) -> float:
    """
    RSI (Relative Strength Index) — momentum oscillator, 0–100.
    Below 30 = oversold (buy signal). Above 70 = overbought (sell signal).
    """
    delta = series.diff().dropna()
    gain  = delta.clip(lower=0).rolling(period).mean()
    loss  = (-delta.clip(upper=0)).rolling(period).mean()
    rs    = gain / loss.replace(0, float("nan"))
    rsi   = 100 - (100 / (1 + rs))
    return round(float(rsi.iloc[-1]), 2) if not rsi.empty else 50.0


def compute_signal(ticker: str, cfg: dict, t_obj, info: dict) -> dict:
    """
    Downloads ~3 months of daily price history and scores the stock -2 to +2.
    Uses ticker.info for 52W high/low (accurate 252-day range from Yahoo).
    Returns a flat dict of all values that become Ignition tags.
    """
    try:
        hist = t_obj.history(period="3mo", interval="1d")
        if hist.empty or len(hist) < cfg["sma_long"]:
            raise ValueError("Not enough price history")

        close      = hist["Close"]
        price      = round(float(close.iloc[-1]), 2)
        prev_close = round(float(close.iloc[-2]), 2)
        change_pct = round((price - prev_close) / prev_close * 100, 2)

        sma_short = round(float(close.rolling(cfg["sma_short"]).mean().iloc[-1]), 2)
        sma_long  = round(float(close.rolling(cfg["sma_long"]).mean().iloc[-1]), 2)
        rsi       = compute_rsi(close, cfg["rsi_period"])

        avg_vol   = float(hist["Volume"].rolling(20).mean().iloc[-1])
        cur_vol   = float(hist["Volume"].iloc[-1])
        vol_ratio = round(cur_vol / avg_vol, 2) if avg_vol > 0 else 1.0

        # Use Yahoo Finance info for 52W range — rolling(252) on 3mo data always
        # returns NaN because there aren't 252 data points in 3 months.
        high_52 = round(float(info.get("fiftyTwoWeekHigh") or 0), 2)
        low_52  = round(float(info.get("fiftyTwoWeekLow") or 0), 2)
        pct_from_high = round((price - high_52) / high_52 * 100, 2) if high_52 > 0 else 0.0

        score, reasons = 0, []

        if sma_short > sma_long:
            score += 1; reasons.append("SMA bullish cross")
        else:
            score -= 1; reasons.append("SMA bearish cross")

        if rsi < 30:
            score += 2; reasons.append(f"RSI oversold ({rsi})")
        elif rsi < 45:
            score += 1; reasons.append(f"RSI low ({rsi})")
        elif rsi > 70:
            score -= 2; reasons.append(f"RSI overbought ({rsi})")
        elif rsi > 60:
            score -= 1; reasons.append(f"RSI high ({rsi})")

        if vol_ratio > 1.5 and change_pct > 0:
            score += 1; reasons.append("High volume up day")
        elif vol_ratio > 1.5 and change_pct < 0:
            score -= 1; reasons.append("High volume down day")

        if pct_from_high < -20:
            score += 1; reasons.append("Far from 52w high (dip)")

        signal_int  = max(-2, min(2, score))
        signal_text = {2: "Strong Buy", 1: "Buy", 0: "Hold", -1: "Sell", -2: "Strong Sell"}[signal_int]

        return {
            "price": price, "change_pct": change_pct,
            "rsi": rsi, "sma_short": sma_short, "sma_long": sma_long,
            "vol_ratio": vol_ratio, "high_52w": high_52, "low_52w": low_52,
            "pct_from_52w_high": pct_from_high,
            "signal_int": signal_int, "signal_text": signal_text,
            "our_rating": signal_text,
            "reason": " | ".join(reasons),
            "last_updated": datetime.now().isoformat(timespec="seconds"),
            "error": "",
        }

    except Exception as e:
        log.warning(f"{ticker} signal error: {e}")
        return {
            "price": 0.0, "change_pct": 0.0, "rsi": 50.0,
            "sma_short": 0.0, "sma_long": 0.0, "vol_ratio": 1.0,
            "high_52w": 0.0, "low_52w": 0.0, "pct_from_52w_high": 0.0,
            "signal_int": 0, "signal_text": "No Data",
            "our_rating": "No Data",
            "reason": "Data unavailable",
            "last_updated": datetime.now().isoformat(timespec="seconds"),
            "error": str(e),
        }


# ══════════════════════════════════════════════════════════════════════════════
# SECTION 2 — DCF VALUATION + ANALYST DATA
# ══════════════════════════════════════════════════════════════════════════════

def compute_dcf(ticker: str, current_price: float, cfg: dict, info: dict, t_obj) -> dict:
    """
    Discounted Cash Flow valuation using Yahoo Finance fundamental data.

    Projects Free Cash Flow forward N years using estimated growth rate,
    discounts back at 10% (your required return), adds a terminal value,
    divides by shares outstanding to get intrinsic value per share.

    Also pulls analyst consensus and price target for free from Yahoo Finance.

    Limitations: high-growth/unprofitable stocks (PLTR, SOFI) will show as
    overvalued — that's expected. The AI overview explains why.
    """
    empty = {
        "intrinsic_value": 0.0, "dcf_margin": 0.0, "dcf_note": "DCF not available",
        "analyst_consensus": "n/a", "analyst_target": 0.0,
        "analyst_count": 0, "currency": "USD",
    }

    if not cfg.get("dcf_enabled", True):
        return {**empty, "dcf_note": "DCF disabled in config"}

    try:
        currency          = info.get("currency", "USD")
        analyst_consensus = str(info.get("recommendationKey", "n/a")).lower()
        analyst_target    = round(float(info.get("targetMeanPrice") or 0), 2)
        analyst_count     = int(info.get("numberOfAnalystOpinions") or 0)

        cf = t_obj.cashflow
        if cf.empty:
            return {**empty, "analyst_consensus": analyst_consensus,
                    "analyst_target": analyst_target, "analyst_count": analyst_count,
                    "currency": currency, "dcf_note": "No cashflow data"}

        if "Free Cash Flow" in cf.index:
            fcf = float(cf.loc["Free Cash Flow"].iloc[0])
        elif "Operating Cash Flow" in cf.index and "Capital Expenditure" in cf.index:
            fcf = float(cf.loc["Operating Cash Flow"].iloc[0]) - abs(float(cf.loc["Capital Expenditure"].iloc[0]))
        else:
            return {**empty, "analyst_consensus": analyst_consensus,
                    "analyst_target": analyst_target, "analyst_count": analyst_count,
                    "currency": currency, "dcf_note": "Cannot determine FCF"}

        if fcf <= 0:
            return {**empty, "analyst_consensus": analyst_consensus,
                    "analyst_target": analyst_target, "analyst_count": analyst_count,
                    "currency": currency, "dcf_note": "Negative FCF — DCF not meaningful"}

        shares = info.get("sharesOutstanding") or info.get("impliedSharesOutstanding") or 0
        if not shares:
            return {**empty, "analyst_consensus": analyst_consensus,
                    "analyst_target": analyst_target, "analyst_count": analyst_count,
                    "currency": currency, "dcf_note": "Share count unavailable"}

        raw_growth  = info.get("earningsGrowth") or info.get("revenueGrowth") or 0.10
        growth_rate = max(-0.05, min(float(raw_growth), 0.30))

        discount_rate   = cfg.get("dcf_discount_rate", 0.10)
        terminal_growth = cfg.get("dcf_terminal_growth", 0.03)
        years           = cfg.get("dcf_projection_years", 5)

        pv_fcf = sum(
            fcf * ((1 + growth_rate) ** yr) / ((1 + discount_rate) ** yr)
            for yr in range(1, years + 1)
        )
        terminal_fcf   = fcf * ((1 + growth_rate) ** years) * (1 + terminal_growth)
        terminal_value = terminal_fcf / (discount_rate - terminal_growth)
        pv_terminal    = terminal_value / ((1 + discount_rate) ** years)

        intrinsic_value = round((pv_fcf + pv_terminal) / shares, 2)
        dcf_margin      = round((intrinsic_value - current_price) / current_price * 100, 1)

        if dcf_margin > 15:
            dcf_note = f"Undervalued by {abs(dcf_margin):.0f}%"
        elif dcf_margin < -15:
            dcf_note = f"Overvalued by {abs(dcf_margin):.0f}%"
        else:
            dcf_note = f"Near fair value ({dcf_margin:+.0f}%)"

        return {
            "intrinsic_value": intrinsic_value, "dcf_margin": dcf_margin,
            "dcf_note": dcf_note, "analyst_consensus": analyst_consensus,
            "analyst_target": analyst_target, "analyst_count": analyst_count,
            "currency": currency,
        }

    except Exception as e:
        log.warning(f"{ticker} DCF error: {e}")
        return {**empty, "dcf_note": f"DCF error: {str(e)[:60]}"}


# ══════════════════════════════════════════════════════════════════════════════
# SECTION 3 — FUNDAMENTAL METRICS
# ══════════════════════════════════════════════════════════════════════════════

def get_fundamentals(ticker: str, info: dict, t_obj) -> dict:
    """
    Pulls PE ratio, profit margin, cash reserves, total debt, and Rule of 40
    from Yahoo Finance info and balance sheet. All money values in billions.

    Rule of 40 = revenue growth YoY% + profit margin% — healthy SaaS/tech
    companies should score ≥ 40.
    """
    result = {
        "pe_ratio": 0.0,
        "profit_margin": 0.0,
        "cash_reserves": 0.0,
        "total_debt": 0.0,
        "rule_of_40": 0.0,
    }
    try:
        pe = info.get("trailingPE") or info.get("forwardPE") or 0
        result["pe_ratio"] = round(float(pe), 1) if pe else 0.0

        pm = info.get("profitMargins") or 0
        pm_pct = round(float(pm) * 100, 1) if pm else 0.0
        result["profit_margin"] = pm_pct

        rev_growth = info.get("revenueGrowth") or 0
        rev_pct = round(float(rev_growth) * 100, 1) if rev_growth else 0.0
        result["rule_of_40"] = round(rev_pct + pm_pct, 1)

        bs = t_obj.balance_sheet
        if bs is not None and not bs.empty:
            for cash_row in ["Cash And Cash Equivalents",
                             "Cash Cash Equivalents And Short Term Investments",
                             "Cash"]:
                if cash_row in bs.index:
                    val = bs.loc[cash_row].iloc[0]
                    if val is not None and not pd.isna(val):
                        result["cash_reserves"] = round(float(val) / 1e9, 2)
                    break

            for debt_row in ["Total Debt", "Long Term Debt"]:
                if debt_row in bs.index:
                    val = bs.loc[debt_row].iloc[0]
                    if val is not None and not pd.isna(val):
                        result["total_debt"] = round(float(val) / 1e9, 2)
                    break

    except Exception as e:
        log.warning(f"{ticker} fundamentals error: {e}")

    return result


def get_quarterly_data(ticker: str, t_obj) -> dict:
    """
    Fetches last 8 quarters of revenue and net earnings from quarterly income
    statement. Values stored in billions. Returns chronological order.
    """
    empty = {"quarters": [], "revenue": [], "earnings": []}
    try:
        quarterly = t_obj.quarterly_income_stmt
        if quarterly is None or quarterly.empty:
            return empty

        num_quarters = min(8, len(quarterly.columns))
        cols = list(quarterly.columns[:num_quarters])

        rev_row = None
        for name in ["Total Revenue", "Revenue"]:
            if name in quarterly.index:
                rev_row = name
                break

        earn_row = None
        for name in ["Net Income", "Net Income Common Stockholders"]:
            if name in quarterly.index:
                earn_row = name
                break

        result = {"quarters": [], "revenue": [], "earnings": []}

        for col in reversed(cols):  # oldest → newest
            q_num = (col.month - 1) // 3 + 1
            label = f"{col.year}-Q{q_num}"

            rev = 0.0
            if rev_row:
                val = quarterly.loc[rev_row, col]
                if val is not None and not pd.isna(val):
                    rev = round(float(val) / 1e9, 2)

            earn = 0.0
            if earn_row:
                val = quarterly.loc[earn_row, col]
                if val is not None and not pd.isna(val):
                    earn = round(float(val) / 1e9, 2)

            result["quarters"].append(label)
            result["revenue"].append(rev)
            result["earnings"].append(earn)

        return result

    except Exception as e:
        log.warning(f"{ticker} quarterly data error: {e}")
        return empty


# ══════════════════════════════════════════════════════════════════════════════
# SECTION 4 — AI OVERVIEW
# ══════════════════════════════════════════════════════════════════════════════

_ai_cache: dict = {}  # {ticker: {"text": str, "updated": datetime}}


def _build_ai_prompt(ticker: str, data: dict) -> str:
    dcf_line = ""
    if data.get("intrinsic_value", 0) > 0:
        dcf_line = (f"DCF intrinsic value: {data['currency']} ${data['intrinsic_value']:.2f} "
                    f"({data.get('dcf_note', '')}). ")
    analyst_line = ""
    if data.get("analyst_count", 0) > 0:
        analyst_line = (f"Wall Street consensus from {data['analyst_count']} analysts: "
                        f"{data.get('analyst_consensus', 'n/a').upper()}, "
                        f"mean target ${data.get('analyst_target', 0):.2f}. ")
    return (
        f"Give a 3-4 sentence financial analysis of {ticker}. "
        f"Current price: {data['currency']} ${data['price']:.2f} "
        f"({data['change_pct']:+.2f}% today), RSI: {data['rsi']:.1f}, "
        f"technical signal: {data['signal_text']}. "
        f"{analyst_line}{dcf_line}"
        f"Cover: competitive moat, growth outlook, key risks. "
        f"For high-growth stocks (PLTR, SOFI) note why market premium exists despite DCF overvaluation. "
        f"Be direct and concise — no disclaimers."
    )


async def get_ai_overview(ticker: str, data: dict, cfg: dict) -> str:
    """
    Calls Groq/Claude/OpenAI for a stock summary. Results are cached for
    ai_refresh_interval_minutes so the API isn't hit every 60 seconds.
    """
    if not cfg.get("ai_enabled", False):
        return "AI disabled — set ai_enabled: true in config.json"
    api_key = cfg.get("ai_api_key", "").strip()
    if not api_key:
        return "No API key — set ai_api_key in config.json"

    cache   = _ai_cache.get(ticker)
    max_age = cfg.get("ai_refresh_interval_minutes", 60)
    if cache:
        age_min = (datetime.now() - cache["updated"]).total_seconds() / 60
        if age_min < max_age:
            return cache["text"]

    prompt   = _build_ai_prompt(ticker, data)
    provider = cfg.get("ai_provider", "groq").lower()

    try:
        loop = asyncio.get_event_loop()

        if provider == "groq":
            def _call():
                return requests.post(
                    "https://api.groq.com/openai/v1/chat/completions",
                    headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                    json={"model": "llama-3.3-70b-versatile",
                          "messages": [{"role": "user", "content": prompt}],
                          "max_tokens": 280, "temperature": 0.35},
                    timeout=20)
            resp = await loop.run_in_executor(None, _call)
            text = resp.json()["choices"][0]["message"]["content"].strip()

        elif provider == "claude":
            def _call():
                return requests.post(
                    "https://api.anthropic.com/v1/messages",
                    headers={"x-api-key": api_key, "anthropic-version": "2023-06-01",
                             "Content-Type": "application/json"},
                    json={"model": "claude-haiku-4-5-20251001", "max_tokens": 280,
                          "messages": [{"role": "user", "content": prompt}]},
                    timeout=20)
            resp = await loop.run_in_executor(None, _call)
            text = resp.json()["content"][0]["text"].strip()

        elif provider == "openai":
            def _call():
                return requests.post(
                    "https://api.openai.com/v1/chat/completions",
                    headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                    json={"model": "gpt-4o-mini",
                          "messages": [{"role": "user", "content": prompt}],
                          "max_tokens": 280, "temperature": 0.35},
                    timeout=20)
            resp = await loop.run_in_executor(None, _call)
            text = resp.json()["choices"][0]["message"]["content"].strip()

        else:
            return f"Unknown provider '{provider}' — use groq, claude, or openai"

        if resp.status_code != 200:
            return f"AI error {resp.status_code}: {resp.text[:100]}"

        _ai_cache[ticker] = {"text": text, "updated": datetime.now()}
        log.info(f"{ticker}: AI overview refreshed")
        return text

    except Exception as e:
        log.warning(f"{ticker} AI error: {e}")
        return f"AI error: {str(e)[:100]}"


# ══════════════════════════════════════════════════════════════════════════════
# SECTION 5 — JSON FILE OUTPUT (replaces OPC-UA server)
# ══════════════════════════════════════════════════════════════════════════════

def write_json(all_data: dict):
    """
    Atomically writes all stock data to stock_data.json.

    Uses a temp file + rename so Ignition never reads a half-written file.
    The JSON structure is:
      {
        "AAPL": { "price": 213.4, "signal_text": "Buy", ... },
        "NVDA": { ... },
        ...
        "_meta": { "last_write": "2026-05-01T12:00:00", "ticker_count": 13 }
      }
    """
    payload = dict(all_data)
    payload["_meta"] = {
        "last_write":   datetime.now().isoformat(timespec="seconds"),
        "ticker_count": len(all_data),
    }

    # Write to temp file first, then atomically replace — prevents Ignition
    # reading a half-written file if the write takes > 0 seconds
    tmp_fd, tmp_path = tempfile.mkstemp(dir=OUTPUT_PATH.parent, suffix=".tmp")
    try:
        with os.fdopen(tmp_fd, "w") as f:
            json.dump(payload, f, indent=2)
        os.replace(tmp_path, OUTPUT_PATH)
    except Exception:
        try:
            os.unlink(tmp_path)
        except Exception:
            pass
        raise

    log.info(f"Wrote stock_data.json ({OUTPUT_PATH})")


# ══════════════════════════════════════════════════════════════════════════════
# SECTION 6 — MAIN LOOP
# ══════════════════════════════════════════════════════════════════════════════

async def main():
    cfg      = load_config()
    tickers  = cfg["stocks"]
    interval = cfg["refresh_interval_seconds"]

    log.info(f"Stock Dashboard starting")
    log.info(f"Watchlist ({len(tickers)}): {', '.join(tickers)}")
    log.info(f"Refresh: every {interval}s | DCF: {cfg.get('dcf_enabled', True)} | AI: {cfg.get('ai_enabled', False)}")
    log.info(f"Output file: {OUTPUT_PATH}")

    while True:
        log.info("── Fetching stock data ──────────────────────────────")
        all_data = {}

        for ticker in tickers:
            # Fetch ticker object and info ONCE — shared across all functions
            t_obj = yf.Ticker(ticker)
            try:
                info = t_obj.info
            except Exception as e:
                log.warning(f"{ticker} info fetch error: {e}")
                info = {}

            # 1. Technical signal (uses info for 52W data)
            data = compute_signal(ticker, cfg, t_obj, info)

            # 2. DCF + analyst consensus (reuses info and t_obj)
            dcf = compute_dcf(ticker, data["price"], cfg, info, t_obj)
            data.update(dcf)

            # 3. Fundamental metrics (PE, margin, cash, debt, Rule of 40)
            fundamentals = get_fundamentals(ticker, info, t_obj)
            data.update(fundamentals)

            # 4. Quarterly revenue and earnings (stored as JSON string for chart)
            quarterly = get_quarterly_data(ticker, t_obj)
            data["quarterly_data"] = json.dumps(quarterly)

            # 5. AI overview (cached, refreshes every hour)
            data["ai_overview"] = await get_ai_overview(ticker, data, cfg)

            all_data[ticker] = data

            currency_sym = "C$" if data.get("currency") == "CAD" else "$"
            log.info(
                f"{ticker:<7} {currency_sym}{data['price']:.2f} ({data['change_pct']:+.2f}%) "
                f"| RSI {data['rsi']:.1f} | {data['signal_text']:<12}"
                f"| IV {currency_sym}{data.get('intrinsic_value', 0):.2f} "
                f"({data.get('dcf_margin', 0):+.1f}%) "
                f"| PE {data.get('pe_ratio', 0):.1f} "
                f"| Margin {data.get('profit_margin', 0):.1f}% "
                f"| R40 {data.get('rule_of_40', 0):.1f}"
            )

        # Write all data to JSON file for Ignition to read
        write_json(all_data)

        log.info(f"── Next refresh in {interval}s ──────────────────────")
        await asyncio.sleep(interval)


if __name__ == "__main__":
    asyncio.run(main())
