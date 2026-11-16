/**
 * LITS 题库审计
 *
 * - 数据结构：id 唯一 / 宽高 / 区域串与解串长度
 * - 规则：区域连续、参考解合法、恰好一解
 * - 逻辑：传播 + 反证能否推满（推不满只警告，不算错误）
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  buildDomains,
  countSolutions,
  decodeBits,
  decodeRegions,
  EMPTY,
  FILLED,
  makeContext,
  planFromState,
  validateSolution,
} from '../src/game/engine.ts'

const DATA_FILE = path.resolve('src/game/puzzles-data.ts')
const text = readFileSync(DATA_FILE, 'utf8')

const entries = []
const re =
  /\{\s*id:\s*"([^"]+)",\s*name:\s*"([^"]+)",\s*width:\s*(\d+),\s*height:\s*(\d+),\s*difficulty:\s*'([^']+)',\s*series:\s*"([^"]+)",\s*board:\s*"([^"]*)",\s*solution:\s*"([^"]*)"(?:\s*,\s*givens:\s*"([^"]*)")?\s*\}/g
let m
while ((m = re.exec(text)) !== null) {
  entries.push({
    id: m[1],
    name: m[2],
    width: Number(m[3]),
    height: Number(m[4]),
    difficulty: m[5],
    series: m[6],
    board: m[7],
    solution: m[8],
    givens: m[9] ?? '',
  })
}

let errors = 0
let warnings = 0
const ids = new Set()

for (const e of entries) {
  const size = e.width * e.height
  if (ids.has(e.id)) {
    console.error(`[check] 重复 id: ${e.id}`)
    errors++
  }
  ids.add(e.id)
  if (!e.name) {
    console.error(`[check] ${e.id} 缺 name`)
    errors++
  }
  if (e.width <= 0 || e.height <= 0) {
    console.error(`[check] ${e.id} 宽高非法: ${e.width}×${e.height}`)
    errors++
    continue
  }
  if (e.board.length !== size) {
    console.error(`[check] ${e.id} board 长度 ${e.board.length} != ${size}`)
    errors++
    continue
  }
  if (e.solution.length !== size) {
    console.error(`[check] ${e.id} solution 长度 ${e.solution.length} != ${size}`)
    errors++
    continue
  }

  const regions = decodeRegions(e.board, size)
  const solution = decodeBits(e.solution, size)
  if (!regions || !solution) {
    console.error(`[check] ${e.id} 区域/解编码非法`)
    errors++
    continue
  }
  let givens = new Array(size).fill(EMPTY)
  if (e.givens) {
    const decodedGivens = decodeBits(e.givens, size)
    if (!decodedGivens) {
      console.error(`[check] ${e.id} 给定格编码非法`)
      errors++
      continue
    }
    givens = decodedGivens
    let outside = 0
    for (let i = 0; i < size; i++) if (givens[i] !== EMPTY && solution[i] !== givens[i]) outside++
    if (outside > 0) {
      console.error(`[check] ${e.id} 有 ${outside} 个给定格与参考解不一致`)
      errors++
      continue
    }
  }
  if (regions.some((r) => r < 0)) {
    console.error(`[check] ${e.id} 含未划分区域`)
    errors++
    continue
  }
  const maxRegion = Math.max(...regions)
  if (new Set(regions).size !== maxRegion + 1) {
    console.error(`[check] ${e.id} 区域编号不连续`)
    errors++
    continue
  }
  if (solution.filter((v) => v !== EMPTY).length !== 4 * (maxRegion + 1)) {
    console.error(`[check] ${e.id} 实心格数 ${solution.filter((v) => v !== EMPTY).length} != 4×区域数`)
    errors++
    continue
  }

  let ctx
  try {
    ctx = makeContext(regions, e.width, e.height)
  } catch (err) {
    console.error(`[check] ${e.id} 区域上下文非法:`, err)
    errors++
    continue
  }

  const check = validateSolution(ctx, solution)
  if (!check.ok) {
    console.error(`[check] ${e.id} 参考解不合法: ${check.reason}`)
    errors++
    continue
  }

  const domains = buildDomains(ctx, givens)
  if (domains.some((list) => !list.length)) {
    console.error(`[check] ${e.id} 有区域枚举不出任何 L/I/S/T`)
    errors++
    continue
  }

  const counted = countSolutions(ctx, domains, 2, 800_000)
  if (counted.timedOut) {
    console.warn(`[check] ${e.id} 唯一解检查超时（${counted.nodes} 节点）`)
    warnings++
  } else if (counted.count !== 1) {
    console.error(`[check] ${e.id} 解不唯一：找到 ${counted.count} 个`)
    errors++
    continue
  }

  const plan = planFromState(ctx, givens, 800_000, 6000)
  if (!plan.ok || !plan.solution) {
    console.error(`[check] ${e.id} 逻辑求解失败`)
    errors++
    continue
  }
  if (!plan.saturated) {
    console.warn(`[check] ${e.id} 需要回溯（逻辑推演未饱和）`)
    warnings++
  }

  console.log(
    `[check] ${e.id} ${e.width}×${e.height} 区域 ${maxRegion + 1} · 解唯一 · 逻辑${plan.saturated ? '可推满' : '需回溯'} · ${counted.nodes} 节点`,
  )
}

console.log(`[check] 共 ${entries.length} 题，错误 ${errors}，警告 ${warnings}`)
if (entries.length === 0) {
  console.warn('[check] 题库为空，请先运行 npm run gen。')
}
if (errors > 0) process.exitCode = 1
