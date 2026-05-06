const https = require('https')

function githubPost(path, body, token) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const req = https.request({
      hostname: 'api.github.com',
      path,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'User-Agent':  'stock-dashboard-bot',
        Accept:        'application/vnd.github+json',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let data = ''
      res.on('data', c => (data += c))
      res.on('end', () => resolve({ status: res.statusCode, body: data }))
    })
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Token')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const adminToken = req.headers['x-admin-token']
  if (!adminToken || adminToken !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Wrong password' })
  }

  const ghToken = process.env.GITHUB_TOKEN
  const owner   = process.env.GITHUB_OWNER
  const repo    = process.env.GITHUB_REPO
  if (!ghToken || !owner || !repo) {
    return res.status(500).json({ error: 'Missing GitHub env vars' })
  }

  const result = await githubPost(
    `/repos/${owner}/${repo}/actions/workflows/update-data.yml/dispatches`,
    { ref: 'main' },
    ghToken
  )

  const ok = result.status === 204
  res.status(ok ? 200 : 500).json({
    dispatched: ok,
    error: ok ? null : `GitHub returned ${result.status} — check GITHUB_TOKEN has workflow scope`,
  })
}
