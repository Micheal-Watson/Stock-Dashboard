import { useState, useEffect, useMemo, useCallback } from 'react'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer,
} from 'recharts'

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(val, decimals = 2) {
  if (val == null || val === '' || isNaN(Number(val))) return '—'
  return Number(val).toFixed(decimals)
}

function fmtPrice(val, currency = 'USD') {
  if (val == null || isNaN(Number(val)) || Number(val) === 0) return '—'
  return `${currency === 'CAD' ? 'CA$' : '$'}${Number(val).toFixed(2)}`
}

function formatConsensus(c) {
  if (!c) return '—'
  return c.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}

function signalStyle(signal) {
  if (!signal) return { text: 'text-gray-400', bg: 'bg-gray-800/50', border: 'border-gray-700' }
  const s = signal.toLowerCase().replace(/_/g, ' ')
  if (s === 'strong buy') return { text: 'text-emerald-300', bg: 'bg-emerald-900/40', border: 'border-emerald-600' }
  if (s === 'buy')         return { text: 'text-green-400',   bg: 'bg-green-900/30',   border: 'border-green-700' }
  if (s === 'strong sell') return { text: 'text-red-300',     bg: 'bg-red-900/40',     border: 'border-red-600' }
  if (s === 'sell')        return { text: 'text-red-400',     bg: 'bg-red-900/30',     border: 'border-red-700' }
  return { text: 'text-yellow-400', bg: 'bg-yellow-900/30', border: 'border-yellow-700' }
}

function parseQuarterly(str) {
  try {
    const qd = JSON.parse(str)
    return qd.quarters
      .map((q, i) => ({
        quarter:  q,
        Revenue:  +(qd.revenue[i]  ?? 0).toFixed(2),
        Earnings: +(qd.earnings[i] ?? 0).toFixed(2),
      }))
      .filter(d => d.Revenue > 0 || d.Earnings > 0)
  } catch { return [] }
}

function computeYoY(chartData) {
  const byQ = {}
  for (const d of chartData) {
    const m = d.quarter.match(/(\d{4})-(Q\d)/)
    if (!m) continue
    const [, year, q] = m
    if (!byQ[q]) byQ[q] = []
    byQ[q].push({ year: +year, Revenue: d.Revenue, Earnings: d.Earnings })
  }
  const results = []
  for (const q of ['Q1', 'Q2', 'Q3', 'Q4']) {
    const entries = byQ[q]?.sort((a, b) => a.year - b.year)
    if (!entries || entries.length < 2) continue
    const cur  = entries[entries.length - 1]
    const prev = entries[entries.length - 2]
    results.push({
      label:   `${cur.year} ${q}`,
      revYoY:  prev.Revenue  > 0 ? ((cur.Revenue  - prev.Revenue)  / prev.Revenue  * 100) : null,
      earnYoY: prev.Earnings > 0 ? ((cur.Earnings - prev.Earnings) / prev.Earnings * 100) : null,
    })
  }
  return results
}

function pctChange(cur, prev) {
  if (prev == null || prev === 0 || prev < 0) return null
  return (cur - prev) / prev * 100
}

function formatDate(iso) {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleString('en-CA', {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    })
  } catch { return iso }
}

// ── Components ────────────────────────────────────────────────────────────────

function MetricCard({ label, value, valueClass = 'text-[#e6edf3]', sub, hint }) {
  return (
    <div className="bg-[#161b22] border border-[#21262d] rounded-xl p-4 flex flex-col gap-1 min-w-0">
      <span className="text-[10px] font-semibold uppercase tracking-widest text-[#8b949e] truncate">{label}</span>
      <span className={`text-lg font-bold leading-snug truncate ${valueClass}`}>{value ?? '—'}</span>
      {sub  && <span className="text-xs text-[#8b949e] leading-tight">{sub}</span>}
      {hint && <span className="text-[10px] text-[#8b949e]/50 italic leading-tight">{hint}</span>}
    </div>
  )
}

function SignalBadge({ signal, large }) {
  const s = signalStyle(signal)
  return (
    <span className={`inline-block rounded-full border font-semibold ${s.bg} ${s.text} ${s.border} ${large ? 'text-sm px-5 py-2' : 'text-xs px-3 py-1'}`}>
      {formatConsensus(signal) || '—'}
    </span>
  )
}

function PctLabel({ val }) {
  if (val == null) return <span className="text-[#8b949e]">N/M</span>
  const up = val >= 0
  return (
    <span className={up ? 'text-[#3fb950]' : 'text-[#f85149]'}>
      {up ? '▲' : '▼'} {Math.abs(val).toFixed(1)}%
    </span>
  )
}

// ── Main App ──────────────────────────────────────────────────────────────────

const POLL_INTERVAL = 30_000

export default function App() {
  const [data,         setData]        = useState(null)
  const [selected,     setSelected]    = useState(null)
  const [loading,      setLoading]     = useState(true)
  const [error,        setError]       = useState(null)
  const [lastFetch,    setLastFetch]   = useState(null)   // Date of last successful fetch
  const [nextIn,       setNextIn]      = useState(POLL_INTERVAL / 1000)  // countdown seconds
  const [clock,        setClock]       = useState('')     // live HH:MM:SS

  // local API state (server.py running)
  const [localApiOk,   setLocalApiOk]  = useState(false)

  // admin / watchlist state
  const [adminToken,   setAdminToken]  = useState(() => sessionStorage.getItem('adminToken') || '')
  const [adminUnlocked,setAdminUnlocked] = useState(false)
  const [showLock,     setShowLock]    = useState(false)
  const [tokenInput,   setTokenInput]  = useState('')
  const [tokenError,   setTokenError]  = useState('')
  const [addInput,     setAddInput]    = useState('')
  const [adding,       setAdding]      = useState(false)
  const [removing,     setRemoving]    = useState(null)
  const [addError,     setAddError]    = useState('')
  // pipeline: { ticker, step: 1|2|3|4, elapsed, intervalId }
  const [pipeline,     setPipeline]    = useState(null)

  // ── Live clock & countdown ────────────────────────────────────────────────

  useEffect(() => {
    const tick = () => {
      const now = new Date()
      setClock(now.toLocaleTimeString('en-CA', { hour12: false }))
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [])

  // ── Data loading ──────────────────────────────────────────────────────────

  const fetchData = useCallback(async () => {
    try {
      const r = await fetch('/api/data')
      if (r.ok) { setLocalApiOk(true); return await r.json() }
    } catch { /* not running locally */ }
    // Serverless function reads directly from GitHub — no Vercel rebuild needed
    const r = await fetch(`/api/stock-data?t=${Date.now()}`)
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return r.json()
  }, [])

  const applyData = useCallback((json, keepSelected = false) => {
    const tickers = Object.keys(json).filter(k => k !== '_meta')
    setData(json)
    setLastFetch(new Date())
    setNextIn(POLL_INTERVAL / 1000)
    setSelected(prev => {
      if (keepSelected && prev && tickers.includes(prev)) return prev
      return tickers[0] ?? null
    })
  }, [])

  useEffect(() => {
    fetchData()
      .then(json => { applyData(json); setLoading(false) })
      .catch(e  => { setError(e.message); setLoading(false) })
    const pollId = setInterval(() => {
      fetchData().then(json => applyData(json, true)).catch(() => {})
    }, POLL_INTERVAL)
    return () => clearInterval(pollId)
  }, [fetchData, applyData])

  // countdown ticker
  useEffect(() => {
    const id = setInterval(() => setNextIn(n => Math.max(0, n - 1)), 1000)
    return () => clearInterval(id)
  }, [])

  // ── Watchlist API calls ───────────────────────────────────────────────────

  // Shared headers — token only needed for Vercel serverless path
  function authHeaders() {
    const h = { 'Content-Type': 'application/json' }
    if (adminToken) h['X-Admin-Token'] = adminToken
    return h
  }

  async function verifyToken(t) {
    // Try a real request; 401 = wrong, anything else = accepted
    const r = await fetch('/api/watchlist', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Token': t },
      body:    JSON.stringify({ ticker: '__verify__' }),  // harmless dummy (server ignores bad symbols)
    })
    return r.status !== 401
  }

  async function unlockAdmin() {
    setTokenError('')
    const t = tokenInput.trim()
    if (!t) return
    try {
      const ok = await verifyToken(t)
      if (ok) {
        setAdminToken(t)
        sessionStorage.setItem('adminToken', t)
        setAdminUnlocked(true)
        setShowLock(false)
        setTokenInput('')
      } else {
        setTokenError('Wrong password')
      }
    } catch {
      setTokenError('Could not reach server')
    }
  }

  function startPipeline(ticker, dispatched) {
    // clear any existing pipeline interval
    setPipeline(prev => { if (prev?.intervalId) clearInterval(prev.intervalId); return null })
    const start = Date.now()
    // poll every 15s to check if ticker appears in live data
    const intervalId = setInterval(async () => {
      const elapsed = Math.round((Date.now() - start) / 1000)
      setPipeline(prev => prev ? { ...prev, elapsed } : null)
      try {
        const r = await fetch(`/api/stock-data?t=${Date.now()}`)
        if (!r.ok) return
        const json = await r.json()
        if (json[ticker]) {
          clearInterval(intervalId)
          applyData(json, true)
          setPipeline(prev => prev ? { ...prev, step: 4, elapsed } : null)
          setTimeout(() => setPipeline(null), 5000)
        }
      } catch { /* ignore polling errors */ }
    }, 15_000)
    setPipeline({ ticker, step: 1, elapsed: 0, intervalId, dispatched })
    if (!dispatched) return  // stop here — token issue, no point waiting
    // advance to step 2 after 10s (Actions queued/running)
    setTimeout(() => setPipeline(prev => prev?.step === 1 ? { ...prev, step: 2 } : prev), 10_000)
    // advance to step 3 after 2.5 min (Actions done, Vercel rebuilding)
    setTimeout(() => setPipeline(prev => prev?.step === 2 ? { ...prev, step: 3 } : prev), 150_000)
  }

  async function addTicker() {
    const ticker = addInput.trim().toUpperCase()
    if (!ticker) return
    setAdding(true)
    setAddError('')
    try {
      const r = await fetch('/api/watchlist', {
        method:  'POST',
        headers: authHeaders(),
        body:    JSON.stringify({ ticker }),
      })
      if (r.status === 401) { setAddError('Wrong password'); return }
      const result = await r.json().catch(() => ({}))
      if (!r.ok) { setAddError(result.error || `Error ${r.status}`); return }
      setAddInput('')
      if (localApiOk) {
        setTimeout(async () => { const json = await fetchData(); applyData(json, true) }, 1000)
      } else {
        startPipeline(ticker, result.dispatched !== false)
      }
    } catch { setAddError('Network error') }
    finally  { setAdding(false) }
  }

  async function removeTicker(ticker) {
    setRemoving(ticker)
    setAddError('')
    try {
      const r = await fetch(`/api/watchlist/${ticker}`, {
        method:  'DELETE',
        headers: authHeaders(),
      })
      if (r.status === 401) { setAddError('Wrong password'); return }
      await r.json().catch(() => ({}))
      setSelected(prev => prev === ticker ? (tickers[0] !== ticker ? tickers[0] : tickers[1] ?? null) : prev)
      if (localApiOk) {
        const json = await fetchData(); applyData(json, true)
      }
    } catch { setAddError('Network error') }
    finally  { setRemoving(null) }
  }

  // ── Computed ──────────────────────────────────────────────────────────────

  const tickers   = useMemo(() => data ? Object.keys(data).filter(k => k !== '_meta') : [], [data])
  const stock     = data && selected ? data[selected] : null
  const chartData = useMemo(() => stock?.quarterly_data ? parseQuarterly(stock.quarterly_data) : [], [stock])
  const yoyData   = useMemo(() => computeYoY(chartData), [chartData])

  const canManage = localApiOk || adminUnlocked

  // ── States ────────────────────────────────────────────────────────────────

  if (loading) return (
    <div className="min-h-screen bg-[#0d1117] flex items-center justify-center">
      <div className="text-[#8b949e] text-sm animate-pulse">Loading market data…</div>
    </div>
  )
  if (error) return (
    <div className="min-h-screen bg-[#0d1117] flex items-center justify-center flex-col gap-2">
      <div className="text-[#f85149] font-semibold">Failed to load data</div>
      <div className="text-[#8b949e] text-sm">{error}</div>
    </div>
  )

  const chg      = stock?.change_pct ?? 0
  const chgColor = chg > 0 ? 'text-[#3fb950]' : chg < 0 ? 'text-[#f85149]' : 'text-[#8b949e]'
  const chgSign  = chg > 0 ? '+' : ''
  const reasonPills = stock?.reason?.split('|').map(r => r.trim()).filter(Boolean) ?? []

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="h-screen bg-[#0d1117] text-[#e6edf3] flex flex-col overflow-hidden">

      {/* Navbar */}
      <nav className="bg-[#161b22] border-b border-[#21262d] px-4 md:px-6 py-3 flex items-center justify-between flex-shrink-0 gap-4">
        <span className="text-[#58a6ff] font-bold text-base md:text-lg tracking-tight whitespace-nowrap">
          📈 Stock Dashboard
        </span>
        <select
          value={selected ?? ''}
          onChange={e => setSelected(e.target.value)}
          className="md:hidden bg-[#21262d] text-[#e6edf3] rounded-lg px-3 py-1.5 text-sm border border-[#30363d] flex-1 max-w-xs"
        >
          {tickers.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        <div className="hidden md:flex items-center gap-3">
          {localApiOk && (
            <span className="text-[10px] font-semibold uppercase tracking-wider text-[#3fb950] bg-green-900/20 border border-green-900/50 px-2 py-1 rounded-full">
              ● Live
            </span>
          )}
          {adminUnlocked && !localApiOk && (
            <span className="text-[10px] font-semibold uppercase tracking-wider text-[#58a6ff] bg-blue-900/20 border border-blue-900/50 px-2 py-1 rounded-full">
              🔓 Admin
            </span>
          )}
          {stock?.last_updated && (
            <span className="text-[#8b949e] text-xs">Data: {formatDate(stock.last_updated)}</span>
          )}
          <span className="text-[#484f58] text-xs font-mono" title="Page refreshes data every 30s">
            {clock} · refresh in {String(nextIn).padStart(2, '0')}s
          </span>
        </div>
      </nav>

      <div className="flex flex-1 overflow-hidden">

        {/* Sidebar */}
        <aside className="hidden md:flex w-52 bg-[#161b22] border-r border-[#21262d] flex-col flex-shrink-0 overflow-y-auto">

          {/* Add ticker panel */}
          {canManage && (
            <div className="px-3 pt-4 pb-3 border-b border-[#21262d]">
              <p className="text-[10px] text-[#8b949e] uppercase tracking-widest font-semibold mb-2 px-1">Add Ticker</p>
              <div className="flex gap-1.5">
                <input
                  value={addInput}
                  onChange={e => { setAddInput(e.target.value.toUpperCase()); setAddError('') }}
                  onKeyDown={e => e.key === 'Enter' && addTicker()}
                  placeholder="e.g. TSLA"
                  maxLength={10}
                  disabled={!!pipeline}
                  className="flex-1 min-w-0 bg-[#21262d] text-[#e6edf3] rounded-lg px-2.5 py-1.5 text-xs border border-[#30363d] focus:outline-none focus:border-[#58a6ff] placeholder-[#484f58] transition-colors disabled:opacity-40"
                />
                <button
                  onClick={addTicker}
                  disabled={adding || !addInput.trim() || !!pipeline}
                  className="bg-[#21262d] hover:bg-[#30363d] text-[#58a6ff] rounded-lg px-2.5 py-1.5 text-sm font-bold border border-[#30363d] disabled:opacity-40 transition-colors"
                >
                  {adding ? '…' : '+'}
                </button>
              </div>
              {addError && <p className="text-[#f85149] text-[10px] mt-1 px-1">{addError}</p>}

              {/* Pipeline status tracker */}
              {pipeline && (() => {
                const steps = [
                  { label: 'Watchlist saved to GitHub',      done: pipeline.step >= 1, error: pipeline.dispatched === false },
                  { label: pipeline.dispatched === false ? '⚠ Workflow not triggered — fix token' : 'GitHub Actions running…', done: pipeline.step >= 3, active: pipeline.step === 2, error: pipeline.dispatched === false },
                  { label: 'Vercel rebuilding with data…',   done: pipeline.step >= 4, active: pipeline.step === 3 },
                  { label: `${pipeline.ticker} is live! ✓`,  done: pipeline.step >= 4 },
                ]
                const mins = Math.floor(pipeline.elapsed / 60)
                const secs = pipeline.elapsed % 60
                return (
                  <div className="mt-2 bg-[#0d1117] border border-[#21262d] rounded-lg p-2.5 space-y-1.5">
                    <p className="text-[10px] font-semibold text-[#8b949e] uppercase tracking-widest mb-1">
                      Pipeline — {mins}:{String(secs).padStart(2,'0')} elapsed
                    </p>
                    {steps.map((s, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <span className="text-sm leading-none w-4 flex-shrink-0">
                          {s.done ? '✅' : s.active ? '⏳' : '○'}
                        </span>
                        <span className={`text-[10px] leading-tight ${s.error ? 'text-[#f85149]' : s.done ? 'text-[#3fb950]' : s.active ? 'text-[#e3b341]' : 'text-[#484f58]'}`}>
                          {s.label}
                        </span>
                      </div>
                    ))}
                  </div>
                )
              })()}
            </div>
          )}

          {/* Ticker list */}
          <div className="px-2 py-3 flex-1 space-y-0.5">
            <p className="text-[10px] text-[#8b949e] uppercase tracking-widest font-semibold px-2 mb-2">Watchlist</p>
            {tickers.map(ticker => {
              const s      = data[ticker]
              const c      = s?.change_pct ?? 0
              const active = ticker === selected
              return (
                <div
                  key={ticker}
                  className={`group flex items-center rounded-lg transition-colors cursor-pointer ${active ? 'bg-[#21262d]' : 'hover:bg-[#1c2128]'}`}
                >
                  <button onClick={() => setSelected(ticker)} className="flex-1 text-left px-3 py-2.5 min-w-0">
                    <div className={`font-semibold text-sm ${active ? 'text-[#e6edf3]' : 'text-[#8b949e] group-hover:text-[#e6edf3]'}`}>
                      {ticker}
                    </div>
                    <div className={`text-xs font-medium ${c > 0 ? 'text-[#3fb950]' : c < 0 ? 'text-[#f85149]' : 'text-[#8b949e]'}`}>
                      {c > 0 ? '+' : ''}{fmt(c)}%
                    </div>
                  </button>
                  {canManage && (
                    <button
                      onClick={() => removeTicker(ticker)}
                      disabled={removing === ticker}
                      title="Remove from watchlist"
                      className="opacity-0 group-hover:opacity-100 mr-2 w-5 h-5 flex items-center justify-center text-[#8b949e] hover:text-[#f85149] rounded transition-all text-base leading-none disabled:opacity-30"
                    >
                      {removing === ticker ? '…' : '×'}
                    </button>
                  )}
                </div>
              )
            })}
          </div>

          {/* Lock / admin unlock (bottom of sidebar) */}
          {!localApiOk && (
            <div className="border-t border-[#21262d] p-3">
              {!adminUnlocked ? (
                <>
                  <button
                    onClick={() => { setShowLock(p => !p); setTokenError('') }}
                    className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-[#484f58] hover:text-[#8b949e] hover:bg-[#1c2128] transition-colors text-xs"
                  >
                    <span>🔐</span>
                    <span>Manage watchlist</span>
                  </button>
                  {showLock && (
                    <div className="mt-2 space-y-2">
                      <input
                        type="password"
                        value={tokenInput}
                        onChange={e => { setTokenInput(e.target.value); setTokenError('') }}
                        onKeyDown={e => e.key === 'Enter' && unlockAdmin()}
                        placeholder="Admin password"
                        className="w-full bg-[#21262d] text-[#e6edf3] rounded-lg px-2.5 py-1.5 text-xs border border-[#30363d] focus:outline-none focus:border-[#58a6ff] placeholder-[#484f58]"
                      />
                      <button
                        onClick={unlockAdmin}
                        className="w-full bg-[#21262d] hover:bg-[#30363d] text-[#58a6ff] text-xs font-semibold rounded-lg py-1.5 border border-[#30363d] transition-colors"
                      >
                        Unlock
                      </button>
                      {tokenError && <p className="text-[#f85149] text-[10px] px-1">{tokenError}</p>}
                    </div>
                  )}
                </>
              ) : (
                <button
                  onClick={() => { setAdminUnlocked(false); setAdminToken(''); sessionStorage.removeItem('adminToken') }}
                  className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-[#58a6ff] hover:bg-[#1c2128] transition-colors text-xs"
                >
                  <span>🔓</span>
                  <span>Lock admin</span>
                </button>
              )}
            </div>
          )}
        </aside>

        {/* Main content */}
        <main className="flex-1 overflow-y-auto">
          {stock && (
            <div className="max-w-5xl mx-auto px-4 md:px-8 py-6 space-y-6">

              {/* Header */}
              <div className="bg-[#161b22] border border-[#21262d] rounded-xl p-5 md:p-6">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <h1 className="text-3xl md:text-4xl font-bold">{selected}</h1>
                      {stock.currency && stock.currency !== 'USD' && (
                        <span className="text-xs font-semibold bg-[#21262d] text-[#8b949e] border border-[#30363d] px-2 py-0.5 rounded">
                          {stock.currency}
                        </span>
                      )}
                    </div>
                    <div className="flex items-baseline gap-3 mt-2 flex-wrap">
                      <span className="text-2xl md:text-3xl font-bold">{fmtPrice(stock.price, stock.currency)}</span>
                      <span className={`text-lg font-semibold ${chgColor}`}>{chgSign}{fmt(chg)}%</span>
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-2">
                    <SignalBadge signal={stock.our_rating} large />
                    {stock.signal_text && stock.signal_text !== stock.our_rating && (
                      <span className="text-xs text-[#8b949e]">Signal: {stock.signal_text}</span>
                    )}
                  </div>
                </div>
                {reasonPills.length > 0 && (
                  <div className="flex flex-wrap gap-2 mt-4">
                    {reasonPills.map((r, i) => (
                      <span key={i} className="text-xs bg-[#21262d] text-[#8b949e] border border-[#30363d] rounded-full px-3 py-1">{r}</span>
                    ))}
                  </div>
                )}
                {stock.error && (
                  <div className="mt-3 text-xs text-[#f85149] bg-red-900/20 border border-red-900/50 rounded-lg px-3 py-2">
                    ⚠ {stock.error}
                  </div>
                )}
              </div>

              {/* Technical */}
              <section>
                <h2 className="text-[10px] font-semibold uppercase tracking-widest text-[#8b949e] mb-3">Technical Analysis</h2>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                  <MetricCard label="RSI (14)" value={fmt(stock.rsi)}
                    valueClass={stock.rsi > 70 ? 'text-[#f85149]' : stock.rsi < 30 ? 'text-[#3fb950]' : 'text-[#e6edf3]'}
                    sub={stock.rsi > 70 ? 'Overbought' : stock.rsi < 30 ? 'Oversold' : 'Neutral'} />
                  <MetricCard label="SMA 20" value={fmtPrice(stock.sma_short, stock.currency)}
                    valueClass={stock.price > stock.sma_short ? 'text-[#3fb950]' : 'text-[#f85149]'}
                    sub={stock.price > stock.sma_short ? 'Price above ▲' : 'Price below ▼'} />
                  <MetricCard label="SMA 50" value={fmtPrice(stock.sma_long, stock.currency)}
                    valueClass={stock.price > stock.sma_long ? 'text-[#3fb950]' : 'text-[#f85149]'}
                    sub={stock.price > stock.sma_long ? 'Price above ▲' : 'Price below ▼'} />
                  <MetricCard label="Volume Ratio" value={`${fmt(stock.vol_ratio)}x`}
                    valueClass={stock.vol_ratio > 1.5 ? 'text-[#58a6ff]' : 'text-[#e6edf3]'}
                    sub={stock.vol_ratio > 1.5 ? 'High volume' : stock.vol_ratio < 0.7 ? 'Low volume' : 'Normal'} />
                  <MetricCard label="52W High" value={fmtPrice(stock.high_52w, stock.currency)} />
                  <MetricCard label="52W Low"  value={fmtPrice(stock.low_52w,  stock.currency)} />
                  <MetricCard label="From 52W High" value={`${fmt(stock.pct_from_52w_high)}%`}
                    valueClass={stock.pct_from_52w_high > -5 ? 'text-[#3fb950]' : stock.pct_from_52w_high > -20 ? 'text-[#e3b341]' : 'text-[#f85149]'} />
                </div>
              </section>

              {/* Fundamentals */}
              <section>
                <h2 className="text-[10px] font-semibold uppercase tracking-widest text-[#8b949e] mb-3">Fundamentals</h2>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
                  <MetricCard label="P/E Ratio" value={stock.pe_ratio ? `${fmt(stock.pe_ratio)}x` : '—'} />
                  <MetricCard label="Profit Margin" value={`${fmt(stock.profit_margin)}%`}
                    valueClass={stock.profit_margin >= 20 ? 'text-[#3fb950]' : stock.profit_margin >= 10 ? 'text-[#e3b341]' : 'text-[#f85149]'} />
                  <MetricCard label="Cash Reserves" value={`$${fmt(stock.cash_reserves)}B`} valueClass="text-[#3fb950]" />
                  <MetricCard label="Total Debt"     value={`$${fmt(stock.total_debt)}B`}     valueClass="text-[#f85149]" />
                  <MetricCard label="Rule of 40" value={fmt(stock.rule_of_40)}
                    valueClass={stock.rule_of_40 >= 40 ? 'text-[#3fb950]' : stock.rule_of_40 >= 20 ? 'text-[#e3b341]' : 'text-[#f85149]'}
                    hint="Rev Growth% + Profit Margin%" />
                </div>
              </section>

              {/* Valuation & Analyst */}
              <section>
                <h2 className="text-[10px] font-semibold uppercase tracking-widest text-[#8b949e] mb-3">Valuation & Analyst</h2>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
                  <MetricCard label="Intrinsic Value" value={fmtPrice(stock.intrinsic_value, stock.currency)} />
                  <MetricCard label="DCF Margin" value={`${fmt(stock.dcf_margin)}%`}
                    valueClass={stock.dcf_margin > 0 ? 'text-[#3fb950]' : 'text-[#f85149]'}
                    sub={stock.dcf_note} />
                  <MetricCard label="Analyst Target" value={fmtPrice(stock.analyst_target, stock.currency)} />
                  <MetricCard label="Analyst Rating" value={formatConsensus(stock.analyst_consensus)}
                    valueClass={signalStyle(stock.analyst_consensus).text} />
                  <MetricCard label="# Analysts" value={stock.analyst_count} />
                  <MetricCard label="Our Rating" value={formatConsensus(stock.our_rating)}
                    valueClass={signalStyle(stock.our_rating).text} />
                </div>
              </section>

              {/* Quarterly chart */}
              {chartData.length > 0 && (
                <section>
                  <h2 className="text-[10px] font-semibold uppercase tracking-widest text-[#8b949e] mb-3">
                    Quarterly Revenue vs Earnings (Billions)
                  </h2>
                  <div className="bg-[#161b22] border border-[#21262d] rounded-xl p-4 md:p-6">
                    <div className="flex gap-4 items-stretch">
                      <div className="flex-1 min-w-0">
                        <ResponsiveContainer width="100%" height={260}>
                          <BarChart data={chartData} margin={{ top: 4, right: 4, left: 4, bottom: 4 }}>
                            <CartesianGrid strokeDasharray="3 3" stroke="#21262d" vertical={false} />
                            <XAxis dataKey="quarter" tick={{ fill: '#8b949e', fontSize: 11 }} axisLine={{ stroke: '#30363d' }} tickLine={false} />
                            <YAxis tick={{ fill: '#8b949e', fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={v => `$${v}B`} width={48} />
                            <Tooltip
                              cursor={{ fill: 'rgba(255,255,255,0.04)' }}
                              content={({ active, payload, label }) => {
                                if (!active || !payload?.length) return null
                                const idx  = chartData.findIndex(d => d.quarter === label)
                                const prev = idx > 0 ? chartData[idx - 1] : null
                                return (
                                  <div className="bg-[#1c2128] border border-[#30363d] rounded-lg p-3 text-sm shadow-xl min-w-[160px]">
                                    <p className="text-[#8b949e] font-semibold mb-2">{label}</p>
                                    {payload.map(p => {
                                      const qoq = prev ? pctChange(p.value, prev[p.dataKey]) : null
                                      return (
                                        <div key={p.dataKey} className="mb-1.5">
                                          <span style={{ color: p.fill }} className="font-bold">
                                            {p.dataKey}: ${p.value.toFixed(2)}B
                                          </span>
                                          {qoq !== null && (
                                            <span className={`ml-2 text-xs font-semibold ${qoq >= 0 ? 'text-[#3fb950]' : 'text-[#f85149]'}`}>
                                              {qoq >= 0 ? '▲' : '▼'} {Math.abs(qoq).toFixed(1)}% QoQ
                                            </span>
                                          )}
                                          {idx === 0 && <span className="ml-2 text-xs text-[#484f58]">first quarter</span>}
                                        </div>
                                      )
                                    })}
                                  </div>
                                )
                              }}
                            />
                            <Bar dataKey="Revenue"  fill="#58a6ff" radius={[4, 4, 0, 0]} maxBarSize={36} />
                            <Bar dataKey="Earnings" fill="#3fb950" radius={[4, 4, 0, 0]} maxBarSize={36} />
                          </BarChart>
                        </ResponsiveContainer>
                        <div className="flex gap-4 justify-center mt-2">
                          <span className="flex items-center gap-1.5 text-xs text-[#8b949e]">
                            <span className="w-3 h-3 rounded-sm bg-[#58a6ff] inline-block" /> Revenue
                          </span>
                          <span className="flex items-center gap-1.5 text-xs text-[#8b949e]">
                            <span className="w-3 h-3 rounded-sm bg-[#3fb950] inline-block" /> Earnings
                          </span>
                        </div>
                      </div>

                      {/* YoY panel */}
                      {yoyData.length > 0 && (
                        <div className="hidden sm:flex w-36 flex-shrink-0 flex-col justify-center gap-3 border-l border-[#21262d] pl-4">
                          <p className="text-[10px] font-semibold uppercase tracking-widest text-[#8b949e]">Year over Year</p>
                          {yoyData.map(item => (
                            <div key={item.label} className="bg-[#21262d] rounded-lg p-2.5 space-y-1">
                              <p className="text-[10px] text-[#8b949e] font-medium">{item.label}</p>
                              <div className="flex items-center justify-between">
                                <span className="text-[10px] text-[#8b949e]">Rev</span>
                                <span className="text-xs font-bold"><PctLabel val={item.revYoY} /></span>
                              </div>
                              <div className="flex items-center justify-between">
                                <span className="text-[10px] text-[#8b949e]">Earn</span>
                                <span className="text-xs font-bold"><PctLabel val={item.earnYoY} /></span>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Mobile YoY */}
                    {yoyData.length > 0 && (
                      <div className="sm:hidden mt-4 pt-4 border-t border-[#21262d]">
                        <p className="text-[10px] font-semibold uppercase tracking-widest text-[#8b949e] mb-2">Year over Year</p>
                        <div className="grid grid-cols-2 gap-2">
                          {yoyData.map(item => (
                            <div key={item.label} className="bg-[#21262d] rounded-lg p-2.5 space-y-1">
                              <p className="text-[10px] text-[#8b949e] font-medium">{item.label}</p>
                              <div className="flex items-center justify-between">
                                <span className="text-[10px] text-[#8b949e]">Rev</span>
                                <span className="text-xs font-bold"><PctLabel val={item.revYoY} /></span>
                              </div>
                              <div className="flex items-center justify-between">
                                <span className="text-[10px] text-[#8b949e]">Earn</span>
                                <span className="text-xs font-bold"><PctLabel val={item.earnYoY} /></span>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </section>
              )}

              <p className="text-center text-[#484f58] text-xs pb-4">
                Data via Python + yfinance · Built with React & Recharts
              </p>
            </div>
          )}
        </main>
      </div>
    </div>
  )
}
