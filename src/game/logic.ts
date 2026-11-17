/**
 * LITS —— 逻辑解题回放计划
 *
 * 回放严格基于「当前已经显示出来的盘面」触发规则：
 *   1. 枚举区域候选
 *   2. 2×2 三格可见实心 → 第四格标叉
 *   3. 同型骨牌不能接触 + 候选级 2×2 / 连通剪枝（内部剪枝，不直接落子）
 *   4. 全局连通性 → 被隔断的格子标叉
 *   5. 候选域收缩 → 确定实心 / 标叉
 *   6. 反证探测
 *   7. 仍卡住时才回溯
 *
 * 回放从「当前盘面」开始：当前格子（实心 FILLED / 标叉 CROSS）都作为工作盘面的
 * 已知约束写入候选域（buildDomains），回放帧的 from 也取当前值，不会覆盖已有标记。
 * 只有当玩家标记与规则矛盾（候选域被清空）时，才退回只看题面的旧路径，
 * 并用规则 7 帧纠正错误的实心/标叉。
 *
 * 2×2 不会使用求解器内部的“隐藏必然填色”，否则空盘上会凭空出现叉。
 * 因此空盘通常先由第 5 条给出第一批确定实心，下一轮第 2 条才开始标叉。
 * 第 3 条里的候选级剪枝只是缩小候选集合，不会直接产生回放帧。
 */

import type { GameState, LogicPlan, Move, PlaybackFrame, Puzzle } from '../core/types'
import {
  asLitsPuzzle,
  asLitsState,
  CROSS,
  EMPTY,
  FILLED,
  makeContext,
  planFromState,
  type Deduction,
} from './engine.ts'

/** 逻辑回放计划 + 审计计数（计数不影响回放内容） */
export interface LitsLogicPlan extends LogicPlan {
  /** 反证探测次数 */
  probes: number
  /** 兜底回溯搜索节点数 */
  searchNodes: number
  /** 按规则编号统计的推导帧数 */
  ruleFrames: Record<number, number>
}

export function planLogicSolve(puzzle: Puzzle, initialState: GameState): LitsLogicPlan {
  const p = asLitsPuzzle(puzzle)
  const s = asLitsState(initialState)
  const emptyPlan: LitsLogicPlan = {
    puzzleId: p.id,
    frames: [],
    finalState: null,
    ruleSteps: 0,
    saturated: false,
    probes: 0,
    searchNodes: 0,
    ruleFrames: {},
  }

  if (p.regions.length !== p.width * p.height) return emptyPlan
  for (const r of p.regions) if (r < 0) return emptyPlan

  const ctx = makeContext(p.regions, p.width, p.height)
  // 从当前盘面开始推：玩家已涂实心 / 已标叉都会写进候选域；矛盾时退回只看题面
  let outcome = planFromState(ctx, s.cells)
  const hasExtraMarks = s.cells.some((v, i) => v !== (s.givens[i] ?? EMPTY))
  if ((!outcome.ok || !outcome.solution) && hasExtraMarks) {
    outcome = planFromState(ctx, s.givens)
  }
  if (!outcome.ok || !outcome.solution) return emptyPlan
  const solution = outcome.solution

  const byRule = new Map<number, Deduction[]>()
  for (const d of outcome.deductions) {
    const list = byRule.get(d.rule) ?? []
    list.push(d)
    byRule.set(d.rule, list)
  }

  const frames: PlaybackFrame[] = []
  const ruleFrames: Record<number, number> = {}
  const display = s.cells.slice()
  let lastRule = -1
  let streak = 0

  const emit = (index: number, value: number, rule: number, label: string): boolean => {
    if (display[index] === value) return false
    if (index < 0 || index >= display.length) return false
    if (value === FILLED && solution[index] !== FILLED) return false
    if (value === CROSS && solution[index] === FILLED) return false
    if (rule === lastRule) streak++
    else {
      lastRule = rule
      streak = 1
    }
    const move: Move = { index, from: display[index] ?? EMPTY, to: value }
    display[index] = value
    frames.push({ rule, label, move, streak })
    ruleFrames[rule] = (ruleFrames[rule] ?? 0) + 1
    return true
  }

  const apply = (d: Deduction): boolean => {
    let any = false
    for (const index of d.cells) {
      if (emit(index, d.value, d.rule, d.label)) any = true
    }
    return any
  }

  const rule2Pass = (): boolean => {
    let changed = false
    for (let guard = 0; guard < 100; guard++) {
      let any = false
      for (const win of ctx.windows) {
        let filled = 0
        let emptyCell = -1
        let emptyCount = 0
        for (const i of win) {
          if (display[i] === FILLED) filled++
          else if (display[i] === EMPTY) {
            emptyCell = i
            emptyCount++
          }
        }
        if (
          filled === 3 &&
          emptyCount === 1 &&
          emit(emptyCell, CROSS, 2, '2×2 已有 3 格实心 → 这一格必须标叉')
        ) {
          any = true
          changed = true
        }
      }
      if (!any) break
    }
    return changed
  }

  // 规则 2/3/4/5 循环应用；3 是内部剪枝，不直接落子
  for (let guard = 0; guard < 300; guard++) {
    let progress = false
    if (rule2Pass()) progress = true

    if (display.some((v) => v === FILLED)) {
      for (const d of byRule.get(4) ?? []) if (apply(d)) progress = true
    }
    for (const d of byRule.get(5) ?? []) if (apply(d)) progress = true
    if (!progress) break
  }

  // 规则 6：反证探测
  for (const d of byRule.get(6) ?? []) apply(d)

  // 规则 7：仍未知的实心格用回溯结果补完；玩家标错/漏标的格子也在这里对齐
  for (let i = 0; i < display.length; i++) {
    if (solution[i] === FILLED) {
      if (display[i] !== FILLED) emit(i, FILLED, 7, '回溯试探：该格最终为实心')
    } else if (display[i] === FILLED && (s.givens[i] ?? EMPTY) === EMPTY) {
      // 玩家在非解格上涂了实心（只可能出现在「退回只看题面」的路径）：补一帧标叉
      emit(i, CROSS, 7, '回溯试探：该格最终不能放骨牌')
    }
  }

  const finalCells = display.slice()
  for (let i = 0; i < finalCells.length; i++) {
    if (solution[i] === FILLED) finalCells[i] = FILLED
    else if (finalCells[i] === FILLED && (s.givens[i] ?? EMPTY) === EMPTY) finalCells[i] = CROSS
  }

  const finalState = {
    puzzleId: p.id,
    width: p.width,
    height: p.height,
    cells: finalCells,
    givens: s.givens.slice(),
  }

  return {
    puzzleId: p.id,
    frames,
    finalState,
    ruleSteps: frames.length,
    saturated: outcome.saturated,
    probes: outcome.probes,
    searchNodes: outcome.searchNodes,
    ruleFrames: { ...ruleFrames },
  }
}
