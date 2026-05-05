const https = require('https')

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'stock-dashboard-bot' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location).then(resolve).catch(reject)
      }
      let data = ''
      res.on('data', c => (data += c))
      res.on('end', () => resolve({ status: res.statusCode, body: data }))
    }).on('error', reject)
  })
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Cache-Control', 'no-store, max-age=0')

  const owner = process.env.GITHUB_OWNER
  const repo  = process.env.GITHUB_REPO

  if (!owner || !repo) {
    return res.status(500).json({ error: 'GITHUB_OWNER or GITHUB_REPO not set' })
  }

  try {
    const url = `https://raw.githubusercontent.com/${owner}/${repo}/main/web-dashboard/public/stock_data.json`
    const result = await fetchUrl(url)
    if (result.status !== 200) {
      return res.status(502).json({ error: `GitHub raw returned ${result.status}` })
    }
    res.setHeader('Content-Type', 'application/json')
    res.status(200).send(result.body)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
}
