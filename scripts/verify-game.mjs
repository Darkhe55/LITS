/**
 * LITS 端到端验证（Playwright）
 *
 * 自动探测/启动开发服务（端口见 package.json 的 puzzle.port）：
 *   npm run verify
 *
 * 检查内容：
 *   1. 所有内置题（含导入题）的参考解都能通过校验；
 *   2. 逻辑解题能推满并解完；
 *   3. 显示解、清空、点击落子、撤销；
 *   4. 自定义区域涂色题板能载入。
 */
import fs from 'node:fs'
import { chromium } from 'playwright-core'
import { PORT } from './_port.mjs'
import { ensureServer } from './_serve.mjs'

const server = await ensureServer()

const executablePath =
  process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'

const browser = await chromium.launch({ headless: true, executablePath })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
const errors = []
let failures = 0
page.on('pageerror', (e) => errors.push(e.message))

const fail = (message) => {
  failures++
  console.error(`FAIL: ${message}`)
}

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' })
await page.waitForSelector('svg.board-svg')

// 1) 参考解
const report = await page.evaluate(() => {
  const a = window.__game.adapter
  return a.builtinPuzzles.map((p) => {
    const sol = a.getReferenceSolution(p.id)
    const r = sol ? a.validate(sol, p) : null
    return { id: p.id, name: p.name, solved: r?.solved ?? false, empty: r?.empty ?? -1 }
  })
})
const badRefs = report.filter((r) => !r.solved)
console.log(`reference solutions: ${report.length - badRefs.length}/${report.length}`)
if (badRefs.length) {
  console.error('未通过参考解:', badRefs)
  fail('有参考解未通过校验')
}

// 2) 逻辑解题
const target = page.locator('.puzzle-item', { hasText: '初识骨墙' }).first()
await target.click()
await page.waitForTimeout(100)
const before = await page.evaluate(() => {
  const s = window.__game.getSession()
  return { id: s.puzzle.id, empty: s.state.cells.filter((v) => v === 0).length }
})
console.log('selected:', before)

const t0 = Date.now()
await page.click('#btn-logic')
await page.waitForFunction(
  () => {
    const btn = document.querySelector('#btn-logic')
    return btn && !btn.disabled && btn.textContent === '逻辑解题'
  },
  { timeout: 180000 },
)
await page.waitForTimeout(300)
const afterLogic = await page.evaluate(() => {
  const g = window.__game
  const s = g.getSession()
  return {
    id: s.puzzle.id,
    empty: s.state.cells.filter((v) => v === 0).length,
    solved: g.adapter.validate(s.state, s.puzzle).solved,
    status: document.querySelector('#status').textContent,
  }
})
console.log('logic solve ms:', Date.now() - t0, afterLogic)
if (!afterLogic.solved || afterLogic.empty !== 0) fail('逻辑解题没有解完')

// 3) 显示解 / 清空 / 落子 / 撤销
await page.click('#btn-solve')
await page.waitForTimeout(100)
const afterSolve = await page.evaluate(() => {
  const g = window.__game
  const s = g.getSession()
  return { solved: g.adapter.validate(s.state, s.puzzle).solved }
})
if (!afterSolve.solved) fail('显示解没有通过校验')

await page.click('#btn-clear')
await page.waitForTimeout(100)
const cleared = await page.evaluate(() => {
  const g = window.__game
  const s = g.getSession()
  const empty = g.adapter.validate(s.state, s.puzzle).empty
  const total = s.puzzle.width * s.puzzle.height - s.state.givens.filter((v) => v === 1).length
  return {
    empty,
    total,
    emptyIndex: s.state.cells.findIndex((v) => v === 0),
  }
})
if (cleared.empty !== cleared.total) fail(`清空后空格数 ${cleared.empty} != ${cleared.total}`)

const box = await page.locator('svg.board-svg').boundingBox()
const geometry = await page.evaluate(() => {
  const g = window.__game
  const s = g.getSession()
  const m = g.adapter.metricsFor(s.puzzle)
  const svg = document.querySelector('svg.board-svg')
  const r = svg.getBoundingClientRect()
  const vb = svg.viewBox.baseVal
  return {
    width: m.width,
    pad: m.pad,
    cell: m.cell,
    sx: r.width / vb.width,
    sy: r.height / vb.height,
    vx: vb.x,
    vy: vb.y,
  }
})
const col = cleared.emptyIndex % geometry.width
const row = Math.floor(cleared.emptyIndex / geometry.width)
const px = box.x + (geometry.pad + col * geometry.cell + geometry.cell / 2 - geometry.vx) * geometry.sx
const py = box.y + (geometry.pad + row * geometry.cell + geometry.cell / 2 - geometry.vy) * geometry.sy
await page.mouse.click(px, py)
await page.waitForTimeout(100)
const afterClick = await page.evaluate(() => {
  const g = window.__game
  const s = g.getSession()
  return {
    changed: s.state.cells.filter((v, i) => v !== s.state.givens[i]).length,
    empty: g.adapter.validate(s.state, s.puzzle).empty,
  }
})
if (afterClick.changed !== 1 || afterClick.empty !== cleared.empty - 1) {
  fail('点击空格没有正确落子')
}
await page.click('#btn-undo')
await page.waitForTimeout(100)
const afterUndo = await page.evaluate(() => {
  const s = window.__game.getSession()
  return s.state.cells.filter((v, i) => v !== s.state.givens[i]).length
})
if (afterUndo !== 0) fail('撤销没有回到给定盘面')

// 4) 自定义区域涂色题板
await page.click('#btn-custom')
await page.waitForTimeout(100)
await page.fill('#custom-w', '5')
await page.fill('#custom-h', '5')
await page.click('#custom-regen')
await page.waitForTimeout(100)
for (let i = 0; i < 25; i++) {
  await page.locator('.custom-cell').nth(i).click()
}
await page.click('#custom-apply')
await page.waitForTimeout(150)
const custom = await page.evaluate(() => {
  const s = window.__game.getSession()
  return {
    w: s.puzzle.width,
    h: s.puzzle.height,
    regions: s.puzzle.regions.length,
    colored: s.puzzle.regions.filter((r) => r >= 0).length,
  }
})
console.log('custom:', custom)
if (custom.w !== 5 || custom.h !== 5 || custom.regions !== 25 || custom.colored !== 25) {
  fail('自定义题板没有正确载入 5×5 区域')
}
await page.click('#custom-close')

fs.mkdirSync('output/playwright', { recursive: true })
await page.screenshot({ path: 'output/playwright/05-verified.png', fullPage: true })
console.log('pageErrors:', errors)
console.log('failures:', failures)
await browser.close()
server?.kill()
if (errors.length || failures > 0) process.exitCode = 1
