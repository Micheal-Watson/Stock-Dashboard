/**
 * Vercel serverless function — watchlist management.
 * POST   /api/watchlist        { ticker: "AAPL" }  → add ticker
 * DELETE /api/watchlist/AAPL                        → remove ticker
 *
 * Required Vercel environment variables:
 *   ADMIN_TOKEN   — your chosen password (e.g. "mySecretPass123")
 *   GITHUB_TOKEN  — GitHub PAT with repo + workflow scopes
 *   GITHUB_OWNER  — your GitHub username  (e.g. "Micheal-Watson")
 *   GITHUB_REPO   — repo name             (e.g. "Stock-Dashboard")
 */

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
  // CORS preflight
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Token')
  if (req.method === 'OPTIONS') return res.status(200).end()

  // Auth — check the secret token the user types in
  const adminToken = req.headers['x-admin-token']
  if (!adminToken || adminToken !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Wrong password' })
  }

  const ghToken = process.env.GITHUB_TOKEN
  const owner   = process.env.GITHUB_OWNER
  const repo    = process.env.GITHUB_REPO
  const cfgPath = `/repos/${owner}/${repo}/contents/Python%20Script/config.json`

  // Fetch current config.json from GitHub
  const { body: fileData } = await githubFetch('GET', cfgPath, null, ghToken)
  if (!fileData.content) {
    return res.status(500).json({ error: 'Could not read config from GitHub' })
  }

  const cfg = JSON.parse(Buffer.from(fileData.content, 'base64').toString('utf8'))
  const sha = fileData.sha

  // Apply the change
  if (req.method === 'POST') {
    // Vercel auto-parses JSON body — req.body is already an object
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

  // Commit the updated config back to GitHub
  await githubFetch(
    'PUT',
    cfgPath,
    {
      message: `chore: update watchlist [skip ci]`,
      content: Buffer.from(JSON.stringify(cfg, null, 2)).toString('base64'),
      sha,
    },
    ghToken
  )

  // Trigger the GitHub Actions workflow to re-fetch all stock data
  await githubFetch(
    'POST',
    `/repos/${owner}/${repo}/actions/workflows/update-data.yml/dispatches`,
    { ref: 'main' },
    ghToken
  )

  res.status(200).json({
    stocks:  cfg.stocks,
    message: 'Watchlist updated — fresh data in ~2 min',
  })
}
