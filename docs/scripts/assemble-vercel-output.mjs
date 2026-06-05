// ABOUTME: Assembles a static-only .vercel/output from the local Vite build for prebuilt deploys.
// ABOUTME: Bypasses Holocron's VERCEL=1 serverless function (its default export is `{ fetch }`,
// ABOUTME: which Vercel's Node launcher can't invoke -> 500). Every page is `rendering: static`,
// ABOUTME: so the prerendered HTML + .rsc in dist/client is the whole site; no function needed.
import { rmSync, mkdirSync, cpSync, readFileSync, writeFileSync, existsSync } from 'node:fs'

const SRC = 'dist/client'
const OUT = '.vercel/output'

if (!existsSync(`${SRC}/__prerender.json`)) {
  console.error(`Missing ${SRC}/__prerender.json — run \`vite build\` (without VERCEL set) first.`)
  process.exit(1)
}

rmSync(OUT, { recursive: true, force: true })
mkdirSync(`${OUT}/static`, { recursive: true })
cpSync(SRC, `${OUT}/static`, { recursive: true })

// Map each prerendered <route>.html to its clean URL via Build Output API `overrides`
// (config.json has no top-level cleanUrls). index.html auto-serves at /, so skip it.
const manifest = JSON.parse(readFileSync(`${SRC}/__prerender.json`, 'utf8'))
const overrides = {}
for (const e of manifest.entries) {
  const file = e.html.replace(/^\//, '')
  const path = e.route.replace(/^\//, '')
  if (path) overrides[file] = { path }
}

// Permanent redirects for renamed pages, so old bookmarks/inbound links don't 404.
// Build Output API v3 expresses redirects as `routes` with a Location header + 3xx status.
const routes = [
  { src: '/integrations', status: 308, headers: { Location: '/mcp' } }, // page renamed: Integrations → MCP
]

writeFileSync(`${OUT}/config.json`, JSON.stringify({ version: 3, routes, overrides }, null, 2))
console.log(`Assembled ${OUT}: ${manifest.entries.length} routes, ${Object.keys(overrides).length} clean-URL overrides, ${routes.length} redirect(s), no functions.`)
