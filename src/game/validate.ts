/**
 * LITS —— 实时校验（接模板 ValidationResult）
 */

import type { GameState, Puzzle, ValidationResult } from '../core/types'
import {
  asLitsPuzzle,
  asLitsState,
  classifyCells,
  FILLED,
  makeContext,
  statusBits as engineStatusBits,
  validatePartial,
  type LitsResult,
  type RegionInfo,
} from './engine'

export function hasUnassigned(regions: number[]): boolean {
  for (const r of regions) if (r < 0) return true
  return false
}

/** 未划分完的自定义题板：不进入规则引擎，只给出结构提示 */
function validateUnassigned(
  puzzle: Puzzle,
  state: GameState,
  unassigned: number,
): LitsResult {
  const p = asLitsPuzzle(puzzle)
  const s = asLitsState(state)
  const size = p.width * p.height
  let maxRegion = -1
  for (const r of p.regions) if (r > maxRegion) maxRegion = r
  const regionInfo: RegionInfo[] = []
  const bad = new Set<number>()
  for (let i = 0; i < size; i++) if (p.regions[i]! < 0) bad.add(i)

  for (let r = 0; r <= maxRegion; r++) {
    const cells: number[] = []
    for (let i = 0; i < size; i++) if (p.regions[i] === r) cells.push(i)
    const filledCells = cells.filter((i) => s.cells[i] === FILLED)
    const type = filledCells.length === 4 ? classifyCells(filledCells, p.width) : null
    regionInfo.push({
      id: r,
      cells,
      filled: filledCells.length,
      complete: filledCells.length === 4 && !!type,
      type,
      invalid: filledCells.length > 4 || (filledCells.length === 4 && !type),
    })
  }

  let filled = 0
  for (let i = 0; i < size; i++) if (s.cells[i] === FILLED) filled++

  return {
    solved: false,
    filled,
    empty: size - filled,
    regionsTotal: maxRegion + 1,
    regionsDone: regionInfo.filter((x) => x.complete).length,
    overfilled: regionInfo.filter((x) => x.filled > 4).length,
    underfilled: regionInfo.filter((x) => x.filled < 4).length,
    invalidPieces: regionInfo.filter((x) => x.invalid).length,
    unassigned,
    blockCount: 0,
    blockCells: [],
    conflictCount: 0,
    conflictCells: [],
    parts: 0,
    trapped: [],
    changedGivens: [],
    badCells: Array.from(bad),
    complete: false,
    regionInfo,
  }
}

export function validate(state: GameState, puzzle: Puzzle): LitsResult {
  const p = asLitsPuzzle(puzzle)
  // 只有自定义题板把 -1 当作「尚未划分区域」；导入的异形题板中 -1 是外部/空洞格。
  let unassigned = 0
  if (p.difficulty === 'custom') {
    for (const r of p.regions) if (r < 0) unassigned++
  }
  if (unassigned > 0) return validateUnassigned(puzzle, state, unassigned)

  const s = asLitsState(state)
  const ctx = makeContext(p.regions, p.width, p.height)
  return validatePartial(ctx, s.cells, s.givens)
}

export function statusBits(result: ValidationResult): string[] {
  return engineStatusBits(result)
}
