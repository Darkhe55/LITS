/**
 * LITS 逻辑求解审计（Playwright）
 *
 * 自动探测/启动开发服务：
 *   npm run audit
 *
 * 对每道内置题运行一次逻辑求解，输出步骤数、耗时、是否推满、最终是否解完。
 */
import { chromium } from 'playwright-core'
import { PORT } from './_port.mjs'
import { ensureServer } from './_serve.mjs'

const server = await ensureServer()

const executablePath =
  process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'

const browser = await chromium.launch({ headless: true, executablePath })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
page.on('pageerror', (e) => console.log('PAGEERROR', e.message))

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' })
await page.waitForSelector('svg.board-svg')

const results = await page.evaluate(() => {
  const a = window.__game.adapter
  return a.builtinPuzzles.map((p) => {
    const state = a.createEmptyState(p)
    const t = performance.now()
    const plan = a.planLogicSolve(p, state)
    const ms = Math.round(performance.now() - t)
    const check = plan.finalState ? a.validate(plan.finalState, p) : null
    return {
      name: p.name,
      size: `${p.width}x${p.height}`,
      regions: new Set(p.regions.filter((r) => r >= 0)).size,
      frames: plan.frames.length,
      ruleSteps: plan.ruleSteps,
      saturated: plan.saturated,
      finalSolved: check?.solved ?? false,
      finalEmpty: check?.empty ?? -1,
      ms,
    }
  })
})

for (const row of results) {
  console.log(
    `${row.name.padEnd(16)} ${row.size.padEnd(7)} 区域 ${String(row.regions).padStart(4)}` +
      `  帧 ${String(row.frames).padStart(5)}  步 ${String(row.ruleSteps).padStart(5)}` +
      `  ${row.saturated ? '推满' : '未推满'}  ${row.finalSolved ? '解完' : `剩 ${row.finalEmpty}`}` +
      `  ${String(row.ms).padStart(6)}ms`,
  )
}

const failed = results.filter((r) => !r.finalSolved)
console.log(`共 ${results.length} 题，解完 ${results.length - failed.length}，未解完 ${failed.length}`)
if (failed.length) {
  console.error('未解完:', failed.map((r) => r.name))
  process.exitCode = 1
}
await browser.close()
server?.kill()
