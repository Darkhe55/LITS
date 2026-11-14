/**
 * LITS —— 题库加载
 *
 * puzzles-data.ts 由 scripts/gen-puzzles.mjs + src/game/generator.ts 生成：
 *   board    = 区域编码（每格一个 base36 字符，0 起）
 *   solution = 参考解（0/1 串）
 */

import { RAW_PUZZLES } from './puzzles-data'
import { IMPORTED_PUZZLES } from './imported-puzzles'
import {
  asLitsPuzzle,
  decodeBits,
  decodeRegions,
  EMPTY,
  FILLED,
  makeContext,
  type LitsPuzzle,
  type LitsState,
} from './engine'

/** 把区域号规范成 0..k-1（按首次出现顺序） */
export function normalizeRegions(regions: number[]): number[] {
  const map = new Map<number, number>()
  let next = 0
  const out: number[] = []
  for (const r of regions) {
    if (r < 0) {
      out.push(-1)
      continue
    }
    if (!map.has(r)) map.set(r, next++)
    out.push(map.get(r)!)
  }
  return out
}

export const builtinPuzzles: LitsPuzzle[] = []
const solutions = new Map<string, number[]>()

for (const raw of [...RAW_PUZZLES, ...IMPORTED_PUZZLES]) {
  const size = raw.width * raw.height
  const decoded = decodeRegions(raw.board, size)
  if (!decoded) {
    console.warn(`[LITS] 区域解码失败：${raw.id}`)
    continue
  }
  if (decoded.some((r) => r < 0)) {
    console.warn(`[LITS] 区域未划分完：${raw.id}`)
    continue
  }
  const regions = normalizeRegions(decoded)
  try {
    makeContext(regions, raw.width, raw.height)
  } catch (err) {
    console.warn(`[LITS] 区域数据非法：${raw.id}`, err)
    continue
  }

  let givens: number[] | undefined
  if (raw.givens) {
    const decodedGivens = decodeBits(raw.givens, size)
    if (!decodedGivens) {
      console.warn(`[LITS] 给定格解码失败：${raw.id}`)
      continue
    }
    givens = decodedGivens
  }

  const puzzle: LitsPuzzle = {
    id: raw.id,
    name: raw.name,
    width: raw.width,
    height: raw.height,
    difficulty: raw.difficulty,
    regions,
    givens,
  }
  builtinPuzzles.push(puzzle)

  if (raw.solution) {
    const solution = decodeBits(raw.solution, size)
    if (solution) {
      puzzle.solution = solution
      solutions.set(raw.id, solution)
    }
  }
}

export function getReferenceSolution(id: string): LitsState | null {
  const cells = solutions.get(id)
  if (!cells) return null
  const puzzle = builtinPuzzles.find((p) => p.id === id)
  if (!puzzle) return null
  const size = puzzle.width * puzzle.height
  const givens = new Array<number>(size).fill(EMPTY)
  for (let i = 0; i < size; i++) givens[i] = puzzle.givens?.[i] === FILLED ? FILLED : EMPTY
  return {
    puzzleId: puzzle.id,
    width: puzzle.width,
    height: puzzle.height,
    cells: cells.slice(),
    givens,
  }
}

export function puzzleById(id: string): LitsPuzzle | undefined {
  return builtinPuzzles.find((p) => p.id === id)
}

export function referenceFor(puzzle: LitsPuzzle): number[] | null {
  return asLitsPuzzle(puzzle).solution ?? solutions.get(puzzle.id) ?? null
}
