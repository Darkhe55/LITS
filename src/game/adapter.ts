/**
 * ════════════════════════════════════════════════════════════════════
 *  LITS 四格骨墙 —— 游戏适配器
 * ════════════════════════════════════════════════════════════════════
 *
 * 规则：
 *   1. 每个区域放一块 4 格骨牌；
 *   2. 骨牌只能是 L / I / S / T（旋转、翻转同型）；
 *   3. 不能出现 2×2 实心；
 *   4. 同型骨牌不能上下左右接触；
 *   5. 所有骨牌连成一片。
 *
 * 状态用 0/1：0 = 空，1 = 实心。
 */

import { playDrop, playPluck } from '../core/audio'
import type {
  CustomCellColor,
  CustomSupport,
  GameAdapter,
  Move,
  Puzzle,
  SolveResult,
} from '../core/types'
import { planLogicSolve } from './logic'
import { builtinPuzzles, getReferenceSolution } from './puzzles'
import { hitTest, metricsFor, renderBoard } from './render'
import { solvePuzzle } from './solver'
import {
  applyMove,
  cloneState,
  createEmptyState,
  cycleValue,
  deserializeState,
  firstHintMove,
  invertMove,
  rightClickValue,
  serializeState,
  valueAt,
} from './state'
import { statusBits, validate } from './validate'
import {
  decodeRegions,
  EMPTY,
  encodeRegions,
  type LitsPuzzle,
} from './engine'

const meta = {
  title: 'LITS 四格骨墙',
  tagline: '每个区域一块 L/I/S/T 四格骨牌 —— 同型不相触，全部连成一片',
  footerNote:
    '规则：每个区域恰好放一块 4 格骨牌，形状只能是 L、I、S、T（旋转/翻转视为同型）；任意 2×2 不能全实心；同型骨牌不能上下左右接触；所有骨牌必须连成一片。',
  storageKeyPrefix: 'lits',
  customIdPrefix: 'lits-custom-',
  customMinW: 5,
  customMinH: 5,
  customMaxW: 60,
  customMaxH: 60,
}

/** 自定义题板的预设色板 */
const CUSTOM_PALETTE = [
  '#e05a5a',
  '#e8873c',
  '#d8a800',
  '#8bbf3f',
  '#3fae6b',
  '#2fb3a3',
  '#2a9fd6',
  '#3b82f6',
  '#6366f1',
  '#8b5cf6',
  '#a855f7',
  '#d946ef',
  '#ec4899',
  '#a06a4f',
  '#6b7280',
]

/**
 * 把颜色映射成整数标记：同色同号，未上色为 -1。
 * 不同颜色必然不同区域；同色还需再按连通性拆分。
 */
function colorOwners(grid: ReadonlyArray<string | null>): number[] {
  const map = new Map<string, number>()
  let next = 0
  return grid.map((color) => {
    if (!color) return -1
    let id = map.get(color)
    if (id === undefined) {
      id = next++
      map.set(color, id)
    }
    return id
  })
}

/**
 * 把相同编号但不四连通的格子拆成不同区域。
 * 编号相同的连通块保留为一个区域；返回 0..k-1 的连续编号。
 */
function splitDisconnected(w: number, h: number, owners: ArrayLike<number>): number[] {
  const size = w * h
  const out = new Array<number>(size).fill(-1)
  let next = 0
  for (let start = 0; start < size; start++) {
    if (out[start] !== -1 || owners[start]! < 0) continue
    const value = owners[start]!
    const id = next++
    out[start] = id
    const stack = [start]
    while (stack.length) {
      const i = stack.pop()!
      const x = i % w
      const y = (i / w) | 0
      const neighbours = [
        x > 0 ? i - 1 : -1,
        x + 1 < w ? i + 1 : -1,
        y > 0 ? i - w : -1,
        y + 1 < h ? i + w : -1,
      ]
      for (const j of neighbours) {
        if (j < 0 || out[j] !== -1) continue
        if (owners[j] !== value) continue
        out[j] = id
        stack.push(j)
      }
    }
  }
  return out
}

const custom: CustomSupport = {
  palette: CUSTOM_PALETTE,
  defaultColor: CUSTOM_PALETTE[7],

  hint: '选择颜色后左键拖动涂色；点击已上色格子会把当前颜色切换成该格颜色；右键拖动擦除。同色相连算同一区域，不连通会自动拆成不同区域。',

  makePuzzle: (w, h, grid, existingId) => {
    const owners = colorOwners(grid)
    const regions = splitDisconnected(w, h, owners)
    return {
      id: existingId ?? `${meta.customIdPrefix}${w}x${h}-${Date.now()}`,
      name: `自定义 · ${w}×${h}`,
      width: w,
      height: h,
      difficulty: 'custom',
      regions,
    } satisfies LitsPuzzle
  },

  encodePuzzle: (p) => ({
    regions: encodeRegions((p as LitsPuzzle).regions ?? []),
  }),

  decodePuzzle: (record) => {
    if (typeof record.id !== 'string') return null
    if (typeof record.width !== 'number' || typeof record.height !== 'number') return null
    const w = record.width
    const h = record.height
    if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) return null
    const size = w * h

    let regions: number[] | null = null
    if (typeof record.regions === 'string') {
      regions = decodeRegions(record.regions, size)
    } else if (Array.isArray(record.regions)) {
      if (record.regions.length !== size) return null
      regions = []
      for (const v of record.regions) {
        const n = Number(v)
        if (!Number.isInteger(n) || n < -1) return null
        regions.push(n)
      }
    }
    if (!regions) return null

    return {
      id: record.id,
      name: typeof record.name === 'string' ? record.name : `自定义 · ${w}×${h}`,
      width: w,
      height: h,
      difficulty: 'custom',
      regions: splitDisconnected(w, h, regions),
    } satisfies LitsPuzzle
  },

  /**
   * 把已保存的题面还原成编辑器网格：每个区域给一个唯一颜色。
   * 颜色只用于在编辑器里区分区域，保存时会重新按连通性拆回区域。
   */
  toGrid: (p) => {
    const lp = p as LitsPuzzle
    const size = p.width * p.height
    if (!lp.regions || lp.regions.length !== size) return null
    const colorFor = (region: number): string => {
      // 奇数乘数散列到 24bit：不同区域必然得到不同颜色，避免还原时被合并
      const h = (Math.imul(region + 1, 2654435761) >>> 8) & 0xffffff
      return `#${h.toString(16).padStart(6, '0')}`
    }
    const grid: CustomCellColor[] = lp.regions.map((region) =>
      region < 0 ? null : colorFor(region),
    )
    return { width: p.width, height: p.height, grid }
  },
}

function playForMove(move: Move, streak: number): void {
  if (move.from === EMPTY) playPluck(streak, 1)
  else playDrop(streak)
}

export const adapter: GameAdapter = {
  meta,
  builtinPuzzles,
  getReferenceSolution,
  createEmptyState,
  cloneState,
  cycleValue,
  rightClickValue,
  applyMove,
  invertMove,
  valueAt,
  serializeState,
  deserializeState,
  validate,
  statusBits,
  metricsFor,
  renderBoard,
  hitTest,
  planLogicSolve,
  solvePuzzle: (puzzle: Puzzle, maxNodes?: number): SolveResult => solvePuzzle(puzzle, maxNodes),
  firstHintMove,
  custom,
  playForMove,
}
