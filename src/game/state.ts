/**
 * LITS —— 棋盘状态
 */

import type { GameState, HitTarget, Move, Puzzle } from '../core/types'
import {
  asLitsPuzzle,
  asLitsState,
  CROSS,
  decodeBits,
  encodeBits,
  EMPTY,
  FILLED,
  firstHintMove as engineHint,
  type LitsState,
} from './engine'

export function createEmptyState(puzzle: Puzzle): LitsState {
  const p = asLitsPuzzle(puzzle)
  const size = p.width * p.height
  if (p.regions.length !== size) throw new Error('题面区域数据长度不匹配')
  const givens = new Array<number>(size).fill(EMPTY)
  for (let i = 0; i < size; i++) {
    if (p.regions[i]! < 0) {
      givens[i] = CROSS
      continue
    }
    const v = p.givens?.[i] ?? EMPTY
    givens[i] = v === FILLED ? FILLED : EMPTY
  }
  return {
    puzzleId: p.id,
    width: p.width,
    height: p.height,
    cells: givens.slice(),
    givens,
  }
}

export function cloneState(state: GameState): LitsState {
  const s = asLitsState(state)
  return {
    puzzleId: s.puzzleId,
    width: s.width,
    height: s.height,
    cells: s.cells.slice(),
    givens: s.givens.slice(),
  }
}

export function cycleValue(state: GameState, target: HitTarget): number {
  const s = asLitsState(state)
  const given = s.givens[target.index] ?? EMPTY
  if (given === FILLED || given === CROSS) return given
  return s.cells[target.index] === EMPTY ? FILLED : EMPTY
}

export function rightClickValue(state: GameState, target: HitTarget): number {
  const s = asLitsState(state)
  const given = s.givens[target.index] ?? EMPTY
  if (given === FILLED || given === CROSS) return given
  const current = s.cells[target.index] ?? EMPTY
  return current === EMPTY ? CROSS : EMPTY
}

export function applyMove(state: GameState, move: Move): void {
  const s = asLitsState(state)
  if (move.index < 0 || move.index >= s.cells.length) return
  if ((s.givens[move.index] ?? EMPTY) !== EMPTY) return
  s.cells[move.index] =
    move.to === FILLED || move.to === CROSS ? move.to : EMPTY
}

export function invertMove(move: Move): Move {
  return { index: move.index, from: move.to, to: move.from }
}

export function valueAt(state: GameState, index: number): number {
  return asLitsState(state).cells[index] ?? EMPTY
}

export function serializeState(state: GameState): Record<string, unknown> {
  const s = asLitsState(state)
  return {
    version: 1,
    puzzleId: s.puzzleId,
    width: s.width,
    height: s.height,
    cells: encodeBits(s.cells),
    givens: encodeBits(s.givens),
  }
}

function readBits(value: unknown, size: number): number[] | null {
  if (typeof value === 'string') return decodeBits(value, size)
  if (Array.isArray(value)) {
    if (value.length !== size) return null
    const out: number[] = []
    for (const v of value) {
      const n = Number(v)
      if (n !== EMPTY && n !== FILLED && n !== CROSS) return null
      out.push(n)
    }
    return out
  }
  return null
}

export function deserializeState(data: Record<string, unknown>): LitsState | null {
  if (typeof data.puzzleId !== 'string') return null
  if (typeof data.width !== 'number' || typeof data.height !== 'number') return null
  const w = data.width
  const h = data.height
  if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) return null
  const size = w * h

  const cells = readBits(data.cells, size)
  if (!cells) return null
  const givens = readBits(data.givens, size) ?? new Array<number>(size).fill(EMPTY)

  for (let i = 0; i < size; i++) {
    if (givens[i] !== EMPTY) cells[i] = givens[i]!
  }

  return { puzzleId: data.puzzleId, width: w, height: h, cells, givens }
}

export function firstHintMove(state: GameState, solution: GameState): Move | null {
  return engineHint(asLitsState(state), asLitsState(solution))
}
