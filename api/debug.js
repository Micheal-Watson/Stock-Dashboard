// Temporary diagnostic endpoint — visit /api/debug to check env var setup
module.exports = function (req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.json({
    ADMIN_TOKEN_set:  !!process.env.ADMIN_TOKEN,
    GITHUB_TOKEN_set: !!process.env.GITHUB_TOKEN,
    GITHUB_OWNER:     process.env.GITHUB_OWNER  || '(not set)',
    GITHUB_REPO:      process.env.GITHUB_REPO   || '(not set)',
  })
}
