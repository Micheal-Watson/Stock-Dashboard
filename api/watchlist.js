const https = require('https')

function githubFetch(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null
    const req = https.request(
      {
        hostname: 'api.github.com',
        path,
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'User-Agent':  'stock-dashboard-bot',
          Accept:        'application/vnd.github+json',
          'Content-Type':'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let data = ''
        res.on('data', (c) => (data += c))
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(data) }) }
          catch { resolve({ status: res.statusCode, body: data }) }
        })
      }
    )
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Token')
  if (req.method === 'OPTIONS') return res.status(200).end()

  // Auth
  const adminToken = req.headers['x-admin-token']
  if (!adminToken || adminToken !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Wrong password' })
  }

  // Check env vars are actually set
  const ghToken = process.env.GITHUB_TOKEN
  const owner   = process.env.GITHUB_OWNER
  const repo    = process.env.GITHUB_REPO
  if (!ghToken || !owner || !repo) {
    const missing = [!ghToken && 'GITHUB_TOKEN', !owner && 'GITHUB_OWNER', !repo && 'GITHUB_REPO'].filter(Boolean)
    return res.status(500).json({ error: `Vercel env vars not set: ${missing.join(', ')}` })
  }

  const cfgPath = `/repos/${owner}/${repo}/contents/Python%20Script/config.json`

  // Fetch config.json from GitHub
  let fileResult
  try {
    fileResult = await githubFetch('GET', cfgPath, null, ghToken)
  } catch (e) {
    return res.status(500).json({ error: `GitHub network error: ${e.message}` })
  }

  if (fileResult.status !== 200) {
    return res.status(500).json({
      error: `GitHub returned ${fileResult.status}: ${fileResult.body?.message || 'unknown error'}. Check GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO.`
    })
  }

  const cfg = JSON.parse(Buffer.from(fileResult.body.content, 'base64').toString('utf8'))
  const sha = fileResult.body.sha

  // Handle verify-only call (just tests auth without modifying anything)
  if (req.method === 'POST') {
    const { ticker } = req.body || {}
    const t = (ticker || '').trim().toUpperCase()
    if (!t || t === '__VERIFY__') return res.status(200).json({ stocks: cfg.stocks, verify: true })
    if (!cfg.stocks.includes(t)) cfg.stocks.push(t)

  } else if (req.method === 'DELETE') {
    const ticker = req.url.split('/').pop().toUpperCase()
    cfg.stocks = cfg.stocks.filter((s) => s.toUpperCase() !== ticker)

  } else {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  // Commit updated config
  const putResult = await githubFetch('PUT', cfgPath, {
    message: 'chore: update watchlist [skip ci]',
    content: Buffer.from(JSON.stringify(cfg, null, 2)).toString('base64'),
    sha,
  }, ghToken)

  if (putResult.status !== 200 && putResult.status !== 201) {
    return res.status(500).json({
      error: `Failed to save config: GitHub ${putResult.status} — ${putResult.body?.message || ''}`
    })
  }

  // Trigger GitHub Actions to re-run the stock script
  const dispatchResult = await githubFetch('POST', `/repos/${owner}/${repo}/actions/workflows/update-data.yml/dispatches`,
    { ref: 'main' }, ghToken)

  const dispatched = dispatchResult.status === 204
  const dispatchError = dispatched ? null
    : `Workflow dispatch failed (HTTP ${dispatchResult.status}): ${dispatchResult.body?.message || 'unknown'}. Check GITHUB_TOKEN has workflow scope.`

  res.status(200).json({
    stocks:      cfg.stocks,
    dispatched,
    dispatchError,
    message: dispatched
      ? 'Watchlist updated — fresh data in ~2 min'
      : 'Watchlist saved but workflow did not trigger — check token permissions',
  })
}
