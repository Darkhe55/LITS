/**
 * 从 LITS 题面图片识别区域并导入题库。
 *
 * 用法：
 *   node scripts/import-image.mjs <图片路径> [--size 15 | --width 15 --height 10] [--name 名称] [--append] [--verify]
 *
 * --size 表示正方形；非正方形题图用 --width/--height（也可只给一个，另一个自动识别）。
 *
 * 识别原理：
 *   1. 用 Playwright 打开图片到 canvas，取像素；
 *   2. 投影暗像素找到网格线与外边界的中心位置；
 *   3. 每个相邻格边界的中点处测量暗线厚度：细线是网格，粗线是区域边界；
 *   4. 按边界做四连通洪泛，得到区域编号矩阵；
 *   5. 用 LITS 规则引擎求解并校验；
 *   6. --append 时写入 src/game/imported-puzzles.ts（不会被 npm run gen 覆盖）。
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright-core'
import {
  buildDomains,
  countSolutions,
  EMPTY,
  encodeBits,
  encodeRegions,
  makeContext,
  planFromState,
} from '../src/game/engine.ts'

const EDGE_PATH =
  process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name)
  if (i < 0) return fallback
  return process.argv[i + 1] ?? fallback
}
function has(name) {
  return process.argv.includes(name)
}

const imagePath = process.argv[2]
if (!imagePath || imagePath.startsWith('--')) {
  console.error(
    '用法：node scripts/import-image.mjs <图片路径> [--size 15 | --width 15 --height 10] [--name 名称] [--append] [--verify]',
  )
  process.exit(1)
}

const sizeOpt = Number(arg('--size', '0')) || 0
const widthOpt = Number(arg('--width', '0')) || 0
const heightOpt = Number(arg('--height', '0')) || 0
const thickOpt = Number(arg('--thick', '0')) || 0
const name = arg('--name', path.basename(imagePath, path.extname(imagePath)))
const append = has('--append')
const verify = has('--verify')
const mergeSmall = has('--merge-small')
const dry = has('--dry')

const dataUrl = `data:image/png;base64,${readFileSync(imagePath).toString('base64')}`

const browser = await chromium.launch({ headless: true, executablePath: EDGE_PATH })
const page = await browser.newPage()
await page.setContent('<canvas id="c"></canvas>')

const analyzed = await page.evaluate(
  async ({ dataUrl, sizeOpt, widthOpt, heightOpt, thickOpt }) => {
    const img = new Image()
    img.src = dataUrl
    await img.decode()
    const W = img.naturalWidth
    const H = img.naturalHeight
    const canvas = document.getElementById('c')
    canvas.width = W
    canvas.height = H
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    ctx.drawImage(img, 0, 0)
    const px = ctx.getImageData(0, 0, W, H).data
    const dark = (x, y) => {
      if (x < 0 || y < 0 || x >= W || y >= H) return false
      const i = (y * W + x) * 4
      const r = px[i]
      const g = px[i + 1]
      const b = px[i + 2]
      return r + g + b < 420
    }

    let minX = W
    let maxX = -1
    let minY = H
    let maxY = -1
    const colCount = new Int32Array(W)
    const rowCount = new Int32Array(H)
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (!dark(x, y)) continue
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
        colCount[x]++
        rowCount[y]++
      }
    }
    if (maxX < 0) throw new Error('图片里没有找到深色网格')

    const clusters = (counts, threshold) => {
      const out = []
      let start = -1
      for (let i = 0; i < counts.length; i++) {
        const on = counts[i] >= threshold
        if (on && start < 0) start = i
        if (!on && start >= 0) {
          out.push((start + i - 1) / 2)
          start = -1
        }
      }
      if (start >= 0) out.push((start + counts.length - 1) / 2)
      return out
    }
    const xs = clusters(colCount, H * 0.45)
    const ys = clusters(rowCount, W * 0.45)
    const autoW = xs.length - 1
    const autoH = ys.length - 1
    const w = widthOpt || sizeOpt || autoW
    const h = heightOpt || sizeOpt || autoH
    if (!(w >= 2) || !(h >= 2)) {
      throw new Error(
        `无法确定网格尺寸：竖线 ${xs.length} 条、横线 ${ys.length} 条（自动识别 ${autoW}×${autoH}）`,
      )
    }
    if (xs.length !== w + 1 || ys.length !== h + 1) {
      throw new Error(
        `网格不匹配：识别到 ${xs.length} 条竖线和 ${ys.length} 条横线，但目标是 ${w}×${h}`,
      )
    }

    const x0 = xs[0]
    const x1 = xs[w]
    const y0 = ys[0]
    const y1 = ys[h]
    const cellX = (x1 - x0) / w
    const cellY = (y1 - y0) / h

    const runX = (cx, cy, radius) => {
      let best = 0
      let run = 0
      for (let x = Math.round(cx - radius); x <= Math.round(cx + radius); x++) {
        if (dark(x, Math.round(cy))) {
          run++
          if (run > best) best = run
        } else run = 0
      }
      return best
    }
    const runY = (cx, cy, radius) => {
      let best = 0
      let run = 0
      for (let y = Math.round(cy - radius); y <= Math.round(cy + radius); y++) {
        if (dark(Math.round(cx), y)) {
          run++
          if (run > best) best = run
        } else run = 0
      }
      return best
    }

    // 先采样所有内部边界的暗线厚度，再用 1D k-means 自动区分细网格与粗区域边界
    const vRuns = []
    const hRuns = []
    for (let i = 1; i < w; i++) {
      for (let j = 0; j < h; j++) {
        const cx = x0 + i * cellX
        const cy = y0 + (j + 0.5) * cellY
        const t = Math.max(
          runX(cx, cy - cellY * 0.22, cellX * 0.28),
          runX(cx, cy, cellX * 0.28),
          runX(cx, cy + cellY * 0.22, cellX * 0.28),
        )
        vRuns.push([i, j, t])
      }
    }
    for (let j = 1; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const cx = x0 + (i + 0.5) * cellX
        const cy = y0 + j * cellY
        const t = Math.max(
          runY(cx - cellX * 0.22, cy, cellY * 0.28),
          runY(cx, cy, cellY * 0.28),
          runY(cx + cellX * 0.22, cy, cellY * 0.28),
        )
        hRuns.push([i, j, t])
      }
    }
    const allRuns = [...vRuns.map((r) => r[2]), ...hRuns.map((r) => r[2])]
    const sorted = allRuns.slice().sort((a, b) => a - b)
    let c1 = sorted[0]
    let c2 = sorted[sorted.length - 1]
    for (let it = 0; it < 30; it++) {
      let s1 = 0
      let n1 = 0
      let s2 = 0
      let n2 = 0
      for (const v of allRuns) {
        if (Math.abs(v - c1) <= Math.abs(v - c2)) {
          s1 += v
          n1++
        } else {
          s2 += v
          n2++
        }
      }
      if (n1) c1 = s1 / n1
      if (n2) c2 = s2 / n2
    }
    const thick = thickOpt > 0 ? thickOpt : Math.max(1.5, Math.min(cellX, cellY) * 0.03, (c1 + c2) / 2)
    // 判断哪些格子属于题板：至少有一条「细线」边。外部坐标/文字没有网格线；
    // 内部空洞四周只有粗边界、没有细网格线，会被判为外部。
    const edgeTX = (ex, ey) => {
      if (ex < 0 || ey < 0 || ex > w || ey >= h) return 0
      const cx = x0 + ex * cellX
      const cy = y0 + (ey + 0.5) * cellY
      return Math.max(
        runX(cx, cy - cellY * 0.22, cellX * 0.28),
        runX(cx, cy, cellX * 0.28),
        runX(cx, cy + cellY * 0.22, cellX * 0.28),
      )
    }
    const edgeTY = (ex, ey) => {
      if (ey < 0 || ex < 0 || ey > h || ex >= w) return 0
      const cx = x0 + (ex + 0.5) * cellX
      const cy = y0 + ey * cellY
      return Math.max(
        runY(cx - cellX * 0.22, cy, cellY * 0.28),
        runY(cx, cy, cellY * 0.28),
        runY(cx + cellX * 0.22, cy, cellY * 0.28),
      )
    }
    const isThin = (v) => v > 0 && v < thick
    const isThick = (v) => v >= thick
    const active = new Uint8Array(w * h)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const edges = [edgeTX(x, y), edgeTX(x + 1, y), edgeTY(x, y), edgeTY(x, y + 1)]
        const thinCount = edges.filter(isThin).length
        const thickCount = edges.filter(isThick).length
        // 题板格通常有两条以上细网格边；缺角/空洞边缘只有一条借来的细线，
        // 再要求至少两条粗边（外轮廓）才排除掉这类“外圈”格。
        active[y * w + x] = thinCount >= 2 || (thinCount >= 1 && thickCount >= 2) ? 1 : 0
      }
    }

    const vWall = Array.from({ length: w }, () => new Uint8Array(h))
    const hWall = Array.from({ length: h }, () => new Uint8Array(w))
    let vCount = 0
    let hCount = 0
    for (let y = 0; y < h; y++) {
      for (let x = 1; x < w; x++) {
        if (!active[y * w + x] || !active[y * w + x - 1]) continue
        if (edgeTX(x, y) >= thick) {
          vWall[x][y] = 1
          vCount++
        }
      }
    }
    for (let y = 1; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!active[y * w + x] || !active[(y - 1) * w + x]) continue
        if (edgeTY(x, y) >= thick) {
          hWall[y][x] = 1
          hCount++
        }
      }
    }

    const regions = new Array(w * h).fill(-1)
    let next = 0
    for (let start = 0; start < w * h; start++) {
      if (!active[start] || regions[start] !== -1) continue
      const id = next++
      regions[start] = id
      const stack = [start]
      while (stack.length) {
        const i = stack.pop()
        const x = i % w
        const y = (i / w) | 0
        const push = (j) => {
          if (j >= 0 && j < w * h && active[j] && regions[j] === -1) {
            regions[j] = id
            stack.push(j)
          }
        }
        if (x > 0 && !vWall[x][y]) push(i - 1)
        if (x + 1 < w && !vWall[x + 1][y]) push(i + 1)
        if (y > 0 && !hWall[y][x]) push(i - w)
        if (y + 1 < h && !hWall[y + 1][x]) push(i + w)
      }
    }

    const sizes = new Array(next).fill(0)
    for (const r of regions) if (r >= 0) sizes[r]++
    return {
      w,
      h,
      regions,
      regionCount: next,
      activeCount: active.reduce((a, b) => a + b, 0),
      minSize: sizes.length ? Math.min(...sizes) : 0,
      maxSize: sizes.length ? Math.max(...sizes) : 0,
      vWalls: vCount,
      hWalls: hCount,
      thick: Number(thick.toFixed(2)),
    }
  },
  { dataUrl, sizeOpt, widthOpt, heightOpt, thickOpt },
)

await browser.close()

let { w, h, regions, regionCount, minSize, maxSize, thick } = analyzed
let workingRegions = regions
let merged = 0

if (mergeSmall && minSize < 4) {
  const sizes = new Map()
  for (const r of workingRegions) if (r >= 0) sizes.set(r, (sizes.get(r) ?? 0) + 1)
  let guard = 0
  while (guard++ < 100) {
    let small = -1
    let smallSize = Infinity
    for (const [r, size] of sizes) {
      if (size < 4 && size < smallSize) {
        small = r
        smallSize = size
      }
    }
    if (small < 0) break
    const shared = new Map()
    for (let i = 0; i < w * h; i++) {
      if (workingRegions[i] !== small) continue
      const x = i % w
      const y = (i / w) | 0
      for (const j of [
        x > 0 ? i - 1 : -1,
        x + 1 < w ? i + 1 : -1,
        y > 0 ? i - w : -1,
        y + 1 < h ? i + w : -1,
      ]) {
        if (j < 0) continue
        const r = workingRegions[j]
        if (r < 0 || r === small) continue
        shared.set(r, (shared.get(r) ?? 0) + 1)
      }
    }
    if (!shared.size) break
    let target = -1
    let best = -1
    for (const [r, count] of shared) {
      if (count > best) {
        best = count
        target = r
      }
    }
    for (let i = 0; i < w * h; i++) if (workingRegions[i] === small) workingRegions[i] = target
    sizes.set(target, (sizes.get(target) ?? 0) + smallSize)
    sizes.delete(small)
    merged++
  }
  const remap = new Map()
  for (let i = 0; i < w * h; i++) {
    const r = workingRegions[i]
    if (r < 0) continue
    if (!remap.has(r)) remap.set(r, remap.size)
    workingRegions[i] = remap.get(r)
  }
  analyzed.regionCount = remap.size
  const finalCounts = new Map()
  for (const r of workingRegions) if (r >= 0) finalCounts.set(r, (finalCounts.get(r) ?? 0) + 1)
  analyzed.minSize = Math.min(...finalCounts.values())
  analyzed.maxSize = Math.max(...finalCounts.values())
  console.log(`[import] 已将 ${merged} 个过小区域并入相邻区域，合并后 ${analyzed.regionCount} 个区域，最小 ${analyzed.minSize} 格`)

  // 合并后仍可能有区域（例如 2×2）放不下 L/I/S/T：继续并入共享边最长的邻区
  const renumber = () => {
    const map = new Map()
    for (let i = 0; i < w * h; i++) {
      const r = workingRegions[i]
      if (r < 0) continue
      if (!map.has(r)) map.set(r, map.size)
      workingRegions[i] = map.get(r)
    }
  }
  const mergeOne = (small) => {
    const shared = new Map()
    for (let i = 0; i < w * h; i++) {
      if (workingRegions[i] !== small) continue
      const x = i % w
      const y = (i / w) | 0
      for (const j of [
        x > 0 ? i - 1 : -1,
        x + 1 < w ? i + 1 : -1,
        y > 0 ? i - w : -1,
        y + 1 < h ? i + w : -1,
      ]) {
        if (j < 0) continue
        const r = workingRegions[j]
        if (r < 0 || r === small) continue
        shared.set(r, (shared.get(r) ?? 0) + 1)
      }
    }
    let target = -1
    let best = -1
    for (const [r, count] of shared) {
      if (count > best) {
        best = count
        target = r
      }
    }
    if (target < 0) return false
    for (let i = 0; i < w * h; i++) if (workingRegions[i] === small) workingRegions[i] = target
    return true
  }

  for (let repair = 0; repair < 1600; repair++) {
    renumber()
    let ctx2
    try {
      ctx2 = makeContext(workingRegions, w, h)
    } catch {
      break
    }
    const d2 = buildDomains(ctx2, new Array(w * h).fill(EMPTY))
    let bad = -1
    for (let r = 0; r < ctx2.regionCount; r++) {
      if (d2[r].length === 0) {
        bad = r
        break
      }
    }
    if (bad < 0) break
    if (!mergeOne(bad)) break
  }
  renumber()
  const repairCounts = new Map()
  for (const r of workingRegions) if (r >= 0) repairCounts.set(r, (repairCounts.get(r) ?? 0) + 1)
  analyzed.regionCount = repairCounts.size
  analyzed.minSize = Math.min(...repairCounts.values())
  analyzed.maxSize = Math.max(...repairCounts.values())
  regionCount = analyzed.regionCount
  minSize = analyzed.minSize
  maxSize = analyzed.maxSize
}

if (regionCount > 1200) {
  console.error(`识别到 ${regionCount} 个区域，超过当前 1200 区域编码上限`)
  process.exit(1)
}
if (analyzed.minSize < 4) {
  console.warn(`警告：有区域只有 ${analyzed.minSize} 格，可能区域边界识别有误`)
}

console.log(
  `[import] ${path.basename(imagePath)}：${w}×${h}，有效格 ${analyzed.activeCount ?? w * h}，区域 ${regionCount} 个（${minSize}–${maxSize} 格），粗线阈值 ${thick}px`,
)

const activeCount = analyzed.activeCount ?? w * h
const suspicious = maxSize > 64 || (regionCount > 1 && maxSize > activeCount * 0.5)
if (suspicious) {
  console.warn(
    `[import] 区域识别异常（有效格 ${activeCount}，最大区域 ${maxSize} 格）。` +
      '先用 --dry --thick 2/3/4 检查；如果最大区域接近整个题板，说明粗线阈值不对。',
  )
  if (!dry) process.exit(1)
}

if (dry) {
  console.log('[import] --dry：仅识别，不求解、不写入。')
  process.exit(0)
}

let ctx
try {
  ctx = makeContext(workingRegions, w, h)
} catch (err) {
  console.error('[import] 区域数据非法：', err)
  process.exit(1)
}

const domains = buildDomains(ctx, new Array(w * h).fill(EMPTY))
if (domains.some((list) => list.length === 0)) {
  console.error('[import] 有区域无法放下 L/I/S/T，区域识别可能不准确')
  process.exit(1)
}

let solution = null
let saturated = false
let nodes = 0
const t0 = Date.now()
if (verify) {
  const counted = countSolutions(ctx, domains, 2, 2_000_000)
  nodes = counted.nodes
  if (counted.timedOut) {
    console.error(`[import] 唯一性检查超时（${counted.nodes} 节点），请用更快的机器或调整阈值`)
    process.exit(1)
  }
  if (counted.count !== 1) {
    console.error(`[import] 解不唯一：${counted.count} 个，可能是边线漏识别/多识别`)
    process.exit(1)
  }
  const plan = planFromState(ctx, new Array(w * h).fill(EMPTY), 2_000_000, 20_000)
  if (!plan.ok || !plan.solution) {
    console.error('[import] 唯一解存在，但求解器没有求出解')
    process.exit(1)
  }
  solution = plan.solution
  saturated = plan.saturated
} else {
  const plan = planFromState(ctx, new Array(w * h).fill(EMPTY), 2_000_000, 20_000)
  if (!plan.ok || !plan.solution) {
    console.error('[import] 求解失败')
    process.exit(1)
  }
  solution = plan.solution
  saturated = plan.saturated
}
console.log(
  `[import] 求解 ${Date.now() - t0}ms，逻辑${saturated ? '可推满' : '需回溯'}，${nodes} 节点`,
)

const board = encodeRegions(workingRegions)
const solutionBits = encodeBits(solution)
const id = arg('--id', `lits-import-${Date.now().toString(36)}`)

if (!append) {
  console.log('[import] 预览模式（未写入）。区域矩阵：')
  for (let y = 0; y < h; y++) {
    console.log(
      workingRegions
        .slice(y * w, y * w + w)
        .map((r) => String(r).padStart(2, '0'))
        .join(' '),
    )
  }
  console.log('[import] 加 --append 可写入题库。')
} else {
  const file = path.resolve('src/game/imported-puzzles.ts')
  const entry = `  { id: ${JSON.stringify(id)}, name: ${JSON.stringify(name)}, width: ${w}, height: ${h}, difficulty: 'hard', series: "导入", board: ${JSON.stringify(board)}, solution: ${JSON.stringify(solutionBits)} },\n`
  if (!existsSync(file)) {
    writeFileSync(
      file,
      `import type { RawPuzzle } from './puzzles-data'\n\nexport const IMPORTED_PUZZLES: RawPuzzle[] = [\n${entry}]\n`,
    )
  } else {
    let text = readFileSync(file, 'utf8')
    const marker = text.lastIndexOf('\n]')
    if (marker < 0) throw new Error('imported-puzzles.ts 格式异常，找不到数组结尾')
    text = text.slice(0, marker + 1) + entry + text.slice(marker + 1)
    writeFileSync(file, text)
  }
  console.log(`[import] 已写入 ${file}`)
}
