/**
 * LITS —— 回溯求解器
 *
 * 候选域 + 规则传播（2×2 / 连通性 / 同型不相触）+ MRV 回溯。
 * 主要用于自定义题板的「显示解 / 求解」和题库唯一解审计。
 */

import type { Puzzle, SolveResult } from '../core/types'
import {
  asLitsPuzzle,
  buildDomains,
  EMPTY,
  FILLED,
  makeContext,
  solveDomains,
  type LitsState,
} from './engine'

function makeState(
  puzzleId: string,
  width: number,
  height: number,
  cells: number[],
  givens: number[],
): LitsState {
  return {
    puzzleId,
    width,
    height,
    cells: cells.slice(),
    givens: givens.slice(),
  }
}

export function solvePuzzle(puzzle: Puzzle, maxNodes = 300_000): SolveResult {
  const p = asLitsPuzzle(puzzle)
  const size = p.width * p.height
  if (p.regions.length !== size) return { solved: false, solution: null, nodes: 0, timedOut: false }
  for (const r of p.regions) {
    if (r < 0) return { solved: false, solution: null, nodes: 0, timedOut: false }
  }

  const givens = new Array<number>(size).fill(EMPTY)
  for (let i = 0; i < size; i++) {
    if (p.givens?.[i] === FILLED) givens[i] = FILLED
  }

  let ctx
  try {
    ctx = makeContext(p.regions, p.width, p.height)
  } catch {
    return { solved: false, solution: null, nodes: 0, timedOut: false }
  }

  const domains = buildDomains(ctx, givens)
  for (const list of domains) {
    if (!list.length) return { solved: false, solution: null, nodes: 0, timedOut: false }
  }

  const result = solveDomains(ctx, domains, maxNodes)
  if (!result.ok || !result.solution) {
    return {
      solved: false,
      solution: null,
      nodes: result.nodes,
      timedOut: result.timedOut,
    }
  }

  return {
    solved: true,
    solution: makeState(p.id, p.width, p.height, result.solution, givens),
    nodes: result.nodes,
    timedOut: false,
  }
}
