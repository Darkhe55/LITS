/**
 * LITS 四格骨墙 —— 规则引擎（纯函数，无 DOM 依赖）
 *
 * 游戏规则：
 *   1. 棋盘被划分成若干区域，每个区域恰好放一块 4 格骨牌；
 *   2. 骨牌必须是 L / I / S / T 之一（旋转、翻转视为同型）；
 *   3. 任意 2×2 区域不能四格全实心（等价于排除 O 型）；
 *   4. 同型骨牌不能上下左右直接接触（斜角允许）；
 *   5. 所有骨牌必须连成一片。
 *
 * 传播用的安全定式（只删候选/标叉，且全部可证明）：
 *   R2  2×2 已有 3 格必实心 → 第 4 格标叉；
 *   R3  相邻区域的同型候选互斥（候选域弧一致）；
 *   R4  全局连通性：已确定实心格所在的「可能实心」连通块以外的格子标叉；
 *   R5  候选域收缩：所有候选都含 / 都不含的格子确定实心 / 标叉；
 *   R6  候选级 2×2：某个候选与已确定实心格凑出完整 2×2 → 该候选不合法；
 *   R7  候选级连通：某个候选所在的「可能实心」连通块没覆盖全部区域
 *       （必然有别的区域连不过来）→ 该候选不合法。
 * R6/R7 只删候选，不直接落子，因此在空盘回放里不会凭空出现叉。
 *
 * 本文件同时被浏览器端和 Node 题库脚本使用，因此不依赖任何运行时模块。
 */

import type { GameState, Move, Puzzle, ValidationResult } from '../core/types'

export const EMPTY = 0
export const FILLED = 1
/** 玩家标记的叉（不参与 LITS 规则，只作排除记号） */
export const CROSS = 2

export type PieceType = 'I' | 'L' | 'S' | 'T'
export const PIECE_TYPES: PieceType[] = ['I', 'L', 'S', 'T']

/** 题面：regions 每格一个区域号；-1 = 外部/空洞格（不参与游戏）；givens 为预填格（0/1） */
export interface LitsPuzzle extends Puzzle {
  regions: number[]
  givens?: number[]
  solution?: number[]
  /** 1 = 该格在题板之外（异形题板的空洞/外部）；可选，缺省由 regions<0 推断 */
  outside?: number[]
}

/** 棋盘状态 */
export interface LitsState extends GameState {
  cells: number[]
  givens: number[]
}

export interface Candidate {
  cells: number[]
  type: PieceType
}

export interface RegionInfo {
  id: number
  cells: number[]
  filled: number
  complete: boolean
  type: PieceType | null
  invalid: boolean
}

export interface LitsResult extends ValidationResult {
  filled: number
  empty: number
  regionsTotal: number
  regionsDone: number
  overfilled: number
  underfilled: number
  invalidPieces: number
  unassigned: number
  blockCount: number
  blockCells: number[]
  conflictCount: number
  conflictCells: number[]
  parts: number
  trapped: number[]
  changedGivens: number[]
  badCells: number[]
  complete: boolean
  regionInfo: RegionInfo[]
}

export interface LitsContext {
  w: number
  h: number
  n: number
  regions: number[]
  /** 1 = 外部/空洞格 */
  outside: Uint8Array
  regionCount: number
  regionCells: number[][]
  neighborPairs: Array<[number, number]>
  windows: number[][]
  /** 每格所在的 2×2 窗口编号（用于候选级 2×2 检查） */
  cellWindows: number[][]
}

export interface Deduction {
  cells: number[]
  /** FILLED = 填实心，CROSS = 标叉 */
  value: number
  rule: number
  label: string
}

export interface LogicOutcome {
  ok: boolean
  solution: number[] | null
  deductions: Deduction[]
  saturated: boolean
  nodes: number
  usedProbe: boolean
  usedSearch: boolean
  /** 反证探测次数（逐候选 trial 传播记 1） */
  probes: number
  /** 兜底回溯搜索节点数 */
  searchNodes: number
}

export interface SolveOutcome {
  ok: boolean
  solution: number[] | null
  nodes: number
  timedOut: boolean
}

export interface CountOutcome {
  count: number
  nodes: number
  timedOut: boolean
}

/* ────────────────────────── 形状分类 ────────────────────────── */

const SHAPE_PATTERNS: Record<PieceType, Array<[number, number]>> = {
  I: [
    [0, 0],
    [1, 0],
    [2, 0],
    [3, 0],
  ],
  L: [
    [0, 0],
    [0, 1],
    [0, 2],
    [1, 2],
  ],
  S: [
    [0, 0],
    [1, 0],
    [1, 1],
    [2, 1],
  ],
  T: [
    [0, 0],
    [1, 0],
    [2, 0],
    [1, 1],
  ],
}

function canonicalPoints(points: Array<[number, number]>): string {
  let best = ''
  for (let t = 0; t < 8; t++) {
    const out: Array<[number, number]> = []
    for (const [x, y] of points) {
      let nx = x
      let ny = y
      if (t & 1) nx = -nx
      if (t & 2) ny = -ny
      if (t & 4) {
        const tmp = nx
        nx = ny
        ny = tmp
      }
      out.push([nx, ny])
    }
    let minX = Infinity
    let minY = Infinity
    for (const [x, y] of out) {
      if (x < minX) minX = x
      if (y < minY) minY = y
    }
    out.sort((a, b) => (a[1] === b[1] ? a[0] - b[0] : a[1] - b[1]))
    const key = out.map(([x, y]) => `${x - minX},${y - minY}`).join(';')
    if (!best || key < best) best = key
  }
  return best
}

const SHAPE_KEYS = new Map<string, PieceType>()
for (const type of PIECE_TYPES) {
  SHAPE_KEYS.set(canonicalPoints(SHAPE_PATTERNS[type]), type)
}

/** 把 4 个格索引分类为 I/L/S/T；O、断开、非四格返回 null */
export function classifyCells(cells: number[], w: number): PieceType | null {
  if (cells.length !== 4) return null
  const seen = new Set<number>()
  const points: Array<[number, number]> = []
  for (const i of cells) {
    if (seen.has(i)) return null
    seen.add(i)
    points.push([i % w, Math.floor(i / w)])
  }
  return SHAPE_KEYS.get(canonicalPoints(points)) ?? null
}

/** 枚举一个区域内所有连通的 4 格候选（只保留 I/L/S/T） */
export function enumerateCandidates(regionCells: number[], w: number): Candidate[] {
  if (regionCells.length < 4) return []
  const inRegion = new Set(regionCells)
  const found = new Map<string, Candidate>()
  const chosen: number[] = []
  const used = new Set<number>()

  const walk = (): void => {
    if (chosen.length === 4) {
      const sorted = chosen.slice().sort((a, b) => a - b)
      const key = sorted.join(',')
      if (found.has(key)) return
      const type = classifyCells(sorted, w)
      if (type) found.set(key, { cells: sorted, type })
      return
    }
    // 从已选集合的任意一格向外长，才能覆盖 T 型（星形无哈密顿路径）
    for (let k = 0; k < chosen.length; k++) {
      const last = chosen[k]!
      const x = last % w
      const y = Math.floor(last / w)
      const neighbors = [
        x > 0 ? last - 1 : -1,
        x + 1 < w ? last + 1 : -1,
        y > 0 ? last - w : -1,
        last + w,
      ]
      for (const nb of neighbors) {
        if (nb < 0 || !inRegion.has(nb) || used.has(nb)) continue
        used.add(nb)
        chosen.push(nb)
        walk()
        chosen.pop()
        used.delete(nb)
      }
    }
  }

  for (const start of regionCells) {
    used.clear()
    chosen.length = 0
    used.add(start)
    chosen.push(start)
    walk()
  }
  return Array.from(found.values())
}

/* ────────────────────────── 上下文 ────────────────────────── */

export function makeContext(regions: number[], w: number, h: number): LitsContext {
  const n = w * h
  if (regions.length !== n) throw new Error(`regions 长度 ${regions.length} != ${n}`)
  const outside = new Uint8Array(n)
  let regionCount = 0
  for (let i = 0; i < n; i++) {
    const r = regions[i]!
    if (!Number.isInteger(r)) throw new Error('regions 含非法值')
    if (r === -1) {
      outside[i] = 1
      continue
    }
    if (r < -1) throw new Error('regions 含未划分格')
    if (r + 1 > regionCount) regionCount = r + 1
  }
  const regionCells: number[][] = Array.from({ length: regionCount }, () => [])
  for (let i = 0; i < n; i++) if (regions[i]! >= 0) regionCells[regions[i]!]!.push(i)

  const pairs = new Set<string>()
  const neighborPairs: Array<[number, number]> = []
  const addPair = (a: number, b: number): void => {
    if (a < 0 || b < 0 || a === b) return
    const lo = Math.min(a, b)
    const hi = Math.max(a, b)
    const key = `${lo},${hi}`
    if (pairs.has(key)) return
    pairs.add(key)
    neighborPairs.push([lo, hi])
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (outside[i]) continue
      if (x + 1 < w) addPair(regions[i]!, regions[i + 1]!)
      if (y + 1 < h) addPair(regions[i]!, regions[i + w]!)
    }
  }

  const windows: number[][] = []
  for (let y = 0; y + 1 < h; y++) {
    for (let x = 0; x + 1 < w; x++) {
      const a = y * w + x
      const quad = [a, a + 1, a + w, a + w + 1]
      if (quad.some((i) => outside[i])) continue
      windows.push(quad)
    }
  }
  const cellWindows: number[][] = Array.from({ length: n }, () => [])
  for (let wi = 0; wi < windows.length; wi++) {
    for (const i of windows[wi]!) cellWindows[i]!.push(wi)
  }

  return { w, h, n, regions, outside, regionCount, regionCells, neighborPairs, windows, cellWindows }
}

/* ────────────────────────── 候选域 ────────────────────────── */

export function buildDomains(ctx: LitsContext, filled: ArrayLike<number>): Candidate[][] {
  const domains: Candidate[][] = []
  for (let r = 0; r < ctx.regionCount; r++) {
    const cells = ctx.regionCells[r]!
    const must: number[] = []
    const blocked: number[] = []
    for (const i of cells) {
      // 当前盘面就是工作盘面的起点：玩家已涂实心的格子必须属于本区域的骨牌，
      // 玩家已标叉的格子必然不属于骨牌（CROSS 标记也作为已知约束写入）
      if (filled[i] === FILLED) must.push(i)
      else if (filled[i] === CROSS) blocked.push(i)
    }
    if (must.length > 4) {
      domains.push([])
      continue
    }
    const candidates = enumerateCandidates(cells, ctx.w).filter(
      (cand) =>
        must.every((i) => cand.cells.includes(i)) &&
        blocked.every((i) => !cand.cells.includes(i)),
    )
    domains.push(candidates)
  }
  return domains
}

export function cloneDomains(domains: Candidate[][]): Candidate[][] {
  return domains.map((list) => list.slice())
}

function adjacentCells(a: Candidate, b: Candidate, w: number): boolean {
  for (const i of a.cells) {
    const ix = i % w
    const iy = Math.floor(i / w)
    for (const j of b.cells) {
      const jx = j % w
      const jy = Math.floor(j / w)
      if (Math.abs(ix - jx) + Math.abs(iy - jy) === 1) return true
    }
  }
  return false
}

function compatible(a: Candidate, b: Candidate, w: number): boolean {
  if (a.type !== b.type) return true
  return !adjacentCells(a, b, w)
}

/**
 * 规则传播到不动点。
 * 返回 false 表示矛盾。会原地收缩 domains。
 */
export type DeductionRecorder = (
  cell: number,
  value: number,
  rule: number,
  label: string,
) => void

export function propagateDomains(
  ctx: LitsContext,
  domains: Candidate[][],
  record?: DeductionRecorder,
): boolean {
  const { w, n, regionCells, regionCount, neighborPairs, windows } = ctx
  let changed = true

  while (changed) {
    changed = false

    for (let r = 0; r < regionCount; r++) if (!domains[r]!.length) return false

    const forcedFilled = new Uint8Array(n)
    const forcedEmpty = new Uint8Array(n)
    for (let i = 0; i < n; i++) if (ctx.outside[i]) forcedEmpty[i] = 1
    for (let r = 0; r < regionCount; r++) {
      const list = domains[r]!
      const count = new Int32Array(n)
      for (const cand of list) for (const i of cand.cells) count[i]!++
      for (const i of regionCells[r]!) {
        if (count[i] === 0) forcedEmpty[i] = 1
        else if (count[i] === list.length) forcedFilled[i] = 1
      }
    }

    const ban2 = new Uint8Array(n)

    // R2：2×2 三格必实 → 第四格必须为空
    for (const win of windows) {
      let f = 0
      let rem = -1
      for (const i of win) {
        if (forcedFilled[i]) f++
        else if (!forcedEmpty[i]) rem = i
      }
      if (f === 4) return false
      if (f === 3 && rem >= 0) {
        ban2[rem] = 1
        record?.(rem, CROSS, 2, '2×2 已有 3 格实心 → 这一格必须标叉')
      }
    }

    // R3：同型骨牌不能接触 —— 区域之间的弧相容
    for (const [a, b] of neighborPairs) {
      const da = domains[a]!
      const db = domains[b]!
      if (!da.length || !db.length) return false

      const keepA: Candidate[] = []
      for (const ca of da) {
        let ok = false
        for (const cb of db) {
          if (compatible(ca, cb, w)) {
            ok = true
            break
          }
        }
        if (ok) keepA.push(ca)
      }
      if (keepA.length !== da.length) {
        domains[a] = keepA
        changed = true
      }
      if (!keepA.length) return false

      const keepB: Candidate[] = []
      for (const cb of db) {
        let ok = false
        for (const ca of keepA) {
          if (compatible(ca, cb, w)) {
            ok = true
            break
          }
        }
        if (ok) keepB.push(cb)
      }
      if (keepB.length !== db.length) {
        domains[b] = keepB
        changed = true
      }
      if (!keepB.length) return false
    }

    const ban4 = new Uint8Array(n)

    // R4：全局连通性 —— 已确定实心格必须落在同一个“可能实心”连通块里
    let firstForced = -1
    for (let i = 0; i < n; i++) {
      if (forcedFilled[i]) {
        firstForced = i
        break
      }
    }
    if (firstForced >= 0) {
      const possible = new Uint8Array(n)
      for (let i = 0; i < n; i++) if (!forcedEmpty[i]) possible[i] = 1
      const comp = new Uint8Array(n)
      const stack = [firstForced]
      comp[firstForced] = 1
      while (stack.length) {
        const i = stack.pop()!
        const x = i % w
        const y = Math.floor(i / w)
        if (x > 0 && possible[i - 1] && !comp[i - 1]) {
          comp[i - 1] = 1
          stack.push(i - 1)
        }
        if (x + 1 < w && possible[i + 1] && !comp[i + 1]) {
          comp[i + 1] = 1
          stack.push(i + 1)
        }
        if (y > 0 && possible[i - w] && !comp[i - w]) {
          comp[i - w] = 1
          stack.push(i - w)
        }
        if (y + 1 < ctx.h && possible[i + w] && !comp[i + w]) {
          comp[i + w] = 1
          stack.push(i + w)
        }
      }
      for (let i = 0; i < n; i++) if (forcedFilled[i] && !comp[i]) return false
      for (let i = 0; i < n; i++) {
        if (possible[i] && !comp[i]) {
          ban4[i] = 1
          record?.(i, CROSS, 4, '全局连通性：这一格会隔断实心骨牌')
        }
      }
    }

    // R5：候选域收缩 —— 确定实心 / 确定空心
    for (let i = 0; i < n; i++) {
      if (forcedFilled[i]) {
        record?.(i, FILLED, 5, '候选域收缩：所有候选都包含这一格')
      } else if (forcedEmpty[i]) {
        record?.(i, CROSS, 5, '候选域收缩：所有候选都不含这一格')
      }
    }

    // 应用 ban
    const ban = new Uint8Array(n)
    for (let i = 0; i < n; i++) if (ban2[i] || ban4[i]) ban[i] = 1
    let banned = false
    for (let i = 0; i < n; i++) {
      if (ban[i]) {
        banned = true
        break
      }
    }
    if (banned) {
      for (let r = 0; r < regionCount; r++) {
        const before = domains[r]!.length
        if (!before) return false
        const keep = domains[r]!.filter((cand) => cand.cells.every((i) => !ban[i]))
        if (keep.length !== before) {
          domains[r] = keep
          changed = true
        }
        if (!keep.length) return false
      }
    }

    // —— R6/R7：候选级剪枝（不直接落子，只删候选；删完下一轮继续传播） ——
    const possible = new Uint8Array(n)
    for (let i = 0; i < n; i++) if (!forcedEmpty[i] && !ctx.outside[i]) possible[i] = 1
    const compId = new Int32Array(n).fill(-1)
    let compCount = 0
    const stack2: number[] = []
    for (let start = 0; start < n; start++) {
      if (compId[start] >= 0 || !possible[start]) continue
      compId[start] = compCount
      stack2.length = 0
      stack2.push(start)
      while (stack2.length) {
        const i = stack2.pop()!
        const x = i % w
        const y = Math.floor(i / w)
        if (x > 0 && possible[i - 1] && compId[i - 1]! < 0) {
          compId[i - 1] = compCount
          stack2.push(i - 1)
        }
        if (x + 1 < w && possible[i + 1] && compId[i + 1]! < 0) {
          compId[i + 1] = compCount
          stack2.push(i + 1)
        }
        if (y > 0 && possible[i - w] && compId[i - w]! < 0) {
          compId[i - w] = compCount
          stack2.push(i - w)
        }
        if (y + 1 < ctx.h && possible[i + w] && compId[i + w]! < 0) {
          compId[i + w] = compCount
          stack2.push(i + w)
        }
      }
      compCount++
    }
    // 每个「可能实心连通块」覆盖了多少个区域（每个区域必须至少有一格能在最终连通块里）
    const regionCompPresence: Array<Set<number>> = []
    for (let r = 0; r < regionCount; r++) {
      const set = new Set<number>()
      for (const i of regionCells[r]!) {
        if (possible[i]) set.add(compId[i]!)
      }
      regionCompPresence.push(set)
    }
    const compRegionCount = new Int32Array(compCount)
    for (const set of regionCompPresence) for (const cid of set) compRegionCount[cid]!++
    // 候选级 2×2：cand 的 4 格 + 已确定实心格不能凑出完整 2×2
    const filledMark = new Uint8Array(n)
    for (let i = 0; i < n; i++) if (forcedFilled[i]) filledMark[i] = 1
    const candidateBad2x2 = (cand: Candidate): boolean => {
      for (const i of cand.cells) filledMark[i] = 1
      let bad = false
      for (const i of cand.cells) {
        for (const wi of ctx.cellWindows[i]!) {
          const quad = windows[wi]!
          if (
            filledMark[quad[0]!] &&
            filledMark[quad[1]!] &&
            filledMark[quad[2]!] &&
            filledMark[quad[3]!]
          ) {
            bad = true
            break
          }
        }
        if (bad) break
      }
      for (const i of cand.cells) filledMark[i] = forcedFilled[i] ? 1 : 0
      return bad
    }
    for (let r = 0; r < regionCount; r++) {
      const before = domains[r]!.length
      if (before <= 1) continue
      const keep: Candidate[] = []
      for (const cand of domains[r]!) {
        const cid = compId[cand.cells[0]!]!
        // R7：候选必须能和所有其它区域的某条候选连成一片
        if (cid < 0 || compRegionCount[cid] !== regionCount) continue
        // R6：候选不能与已确定实心格凑出 2×2
        if (candidateBad2x2(cand)) continue
        keep.push(cand)
      }
      if (keep.length !== before) {
        domains[r] = keep
        changed = true
      }
      if (!keep.length) return false
    }
  }

  return true
}

/* ────────────────────────── 求解 / 计数 ────────────────────────── */

function solutionFromDomains(ctx: LitsContext, domains: Candidate[][]): number[] | null {
  const cells = new Array<number>(ctx.n).fill(CROSS)
  for (let r = 0; r < ctx.regionCount; r++) {
    if (domains[r]!.length !== 1) return null
    for (const i of domains[r]![0]!.cells) cells[i] = FILLED
  }
  return cells
}

export function solveDomains(
  ctx: LitsContext,
  start: Candidate[][],
  maxNodes = 300_000,
): SolveOutcome {
  const domains = cloneDomains(start)
  let nodes = 0
  let timedOut = false

  const dfs = (): number[] | null => {
    if (timedOut) return null
    nodes++
    if (nodes > maxNodes) {
      timedOut = true
      return null
    }
    if (!propagateDomains(ctx, domains)) return null

    let choice = -1
    let best = Infinity
    for (let r = 0; r < ctx.regionCount; r++) {
      const len = domains[r]!.length
      if (len > 1 && len < best) {
        best = len
        choice = r
      }
    }
    if (choice < 0) {
      const solution = solutionFromDomains(ctx, domains)
      if (!solution) return null
      return validateSolution(ctx, solution).ok ? solution : null
    }

    const backup = cloneDomains(domains)
    for (const cand of backup[choice]!) {
      domains.length = 0
      for (const list of backup) domains.push(list.slice())
      domains[choice] = [cand]
      const found = dfs()
      if (found) return found
      if (timedOut) return null
    }
    return null
  }

  const solution = dfs()
  return { ok: !!solution, solution, nodes, timedOut }
}

export function countSolutions(
  ctx: LitsContext,
  start: Candidate[][],
  limit = 2,
  maxNodes = 300_000,
): CountOutcome {
  const domains = cloneDomains(start)
  let count = 0
  let nodes = 0
  let timedOut = false

  const dfs = (): void => {
    if (count >= limit || timedOut) return
    nodes++
    if (nodes > maxNodes) {
      timedOut = true
      return
    }
    if (!propagateDomains(ctx, domains)) return

    let choice = -1
    let best = Infinity
    for (let r = 0; r < ctx.regionCount; r++) {
      const len = domains[r]!.length
      if (len > 1 && len < best) {
        best = len
        choice = r
      }
    }
    if (choice < 0) {
      const solution = solutionFromDomains(ctx, domains)
      if (solution && validateSolution(ctx, solution).ok) count++
      return
    }

    const backup = cloneDomains(domains)
    for (const cand of backup[choice]!) {
      if (count >= limit || timedOut) return
      domains.length = 0
      for (const list of backup) domains.push(list.slice())
      domains[choice] = [cand]
      dfs()
    }
  }

  dfs()
  return { count, nodes, timedOut }
}

/* ────────────────────────── 完整解校验 ────────────────────────── */

export interface SolutionCheck {
  ok: boolean
  reason: string
}

export function validateSolution(ctx: LitsContext, cells: ArrayLike<number>): SolutionCheck {
  const { w, h, n, regions, regionCount, windows } = ctx
  const typeOf: Array<PieceType | null> = new Array(regionCount).fill(null)
  let filledTotal = 0

  for (let r = 0; r < regionCount; r++) {
    const cellsOfRegion: number[] = []
    for (let i = 0; i < n; i++) if (regions[i] === r && cells[i] === FILLED) cellsOfRegion.push(i)
    if (cellsOfRegion.length !== 4) return { ok: false, reason: `区域 ${r + 1} 不是 4 格` }
    const type = classifyCells(cellsOfRegion, w)
    if (!type) return { ok: false, reason: `区域 ${r + 1} 不是 L/I/S/T` }
    typeOf[r] = type
    filledTotal += 4
  }

  for (const win of windows) {
    if (win.every((i) => cells[i] === FILLED)) return { ok: false, reason: '存在 2×2 实心' }
  }

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (cells[i] !== FILLED) continue
      if (x + 1 < w && cells[i + 1] === FILLED) {
        const a = regions[i]!
        const b = regions[i + 1]!
        if (a !== b && typeOf[a] && typeOf[a] === typeOf[b]) {
          return { ok: false, reason: '同型骨牌接触' }
        }
      }
      if (y + 1 < h && cells[i + w] === FILLED) {
        const a = regions[i]!
        const b = regions[i + w]!
        if (a !== b && typeOf[a] && typeOf[a] === typeOf[b]) {
          return { ok: false, reason: '同型骨牌接触' }
        }
      }
    }
  }

  if (filledTotal > 0) {
    let start = -1
    for (let i = 0; i < n; i++) {
      if (cells[i] === FILLED) {
        start = i
        break
      }
    }
    const seen = new Uint8Array(n)
    const stack = [start]
    seen[start] = 1
    let count = 0
    while (stack.length) {
      const i = stack.pop()!
      count++
      const x = i % w
      const y = Math.floor(i / w)
      if (x > 0 && cells[i - 1] === FILLED && !seen[i - 1]) {
        seen[i - 1] = 1
        stack.push(i - 1)
      }
      if (x + 1 < w && cells[i + 1] === FILLED && !seen[i + 1]) {
        seen[i + 1] = 1
        stack.push(i + 1)
      }
      if (y > 0 && cells[i - w] === FILLED && !seen[i - w]) {
        seen[i - w] = 1
        stack.push(i - w)
      }
      if (y + 1 < h && cells[i + w] === FILLED && !seen[i + w]) {
        seen[i + w] = 1
        stack.push(i + w)
      }
    }
    if (count !== filledTotal) return { ok: false, reason: '骨牌未连成一片' }
  }

  return { ok: true, reason: '' }
}

/* ────────────────────────── 实时校验 ────────────────────────── */

export function validatePartial(
  ctx: LitsContext,
  cells: ArrayLike<number>,
  givens: ArrayLike<number>,
): LitsResult {
  const { w, h, n, regions, regionCount, windows } = ctx
  const regionInfo: RegionInfo[] = []
  const bad = new Set<number>()
  let filled = 0
  let overfilled = 0
  let underfilled = 0
  let invalidPieces = 0
  let regionsDone = 0

  for (let r = 0; r < regionCount; r++) {
    const cellsOfRegion: number[] = []
    for (let i = 0; i < n; i++) if (regions[i] === r) cellsOfRegion.push(i)
    const filledCells = cellsOfRegion.filter((i) => cells[i] === FILLED)
    const count = filledCells.length
    filled += count
    const type = count === 4 ? classifyCells(filledCells, w) : null
    const invalid = count > 4 || (count === 4 && !type)
    if (count > 4) overfilled++
    if (count < 4) underfilled++
    if (count === 4 && !type) invalidPieces++
    if (invalid) for (const i of filledCells) bad.add(i)
    const complete = count === 4 && !!type
    if (complete) regionsDone++
    regionInfo.push({ id: r, cells: cellsOfRegion, filled: count, complete, type, invalid })
  }

  let blockCount = 0
  const blockCells: number[] = []
  for (const win of windows) {
    if (win.every((i) => cells[i] === FILLED)) {
      blockCount++
      for (const i of win) {
        blockCells.push(i)
        bad.add(i)
      }
    }
  }

  const conflictPairs = new Set<string>()
  const conflictCells: number[] = []
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (cells[i] !== FILLED) continue
      const ri = regions[i]!
      const ti = regionInfo[ri]?.type ?? null
      if (!ti) continue
      if (x + 1 < w && cells[i + 1] === FILLED) {
        const rj = regions[i + 1]!
        if (ri !== rj && regionInfo[rj]?.type === ti) {
          conflictPairs.add(`${Math.min(ri, rj)},${Math.max(ri, rj)}`)
          conflictCells.push(i, i + 1)
          bad.add(i)
          bad.add(i + 1)
        }
      }
      if (y + 1 < h && cells[i + w] === FILLED) {
        const rj = regions[i + w]!
        if (ri !== rj && regionInfo[rj]?.type === ti) {
          conflictPairs.add(`${Math.min(ri, rj)},${Math.max(ri, rj)}`)
          conflictCells.push(i, i + w)
          bad.add(i)
          bad.add(i + w)
        }
      }
    }
  }

  // 全局连通块
  const comps: number[][] = []
  const seen = new Uint8Array(n)
  for (let start = 0; start < n; start++) {
    if (cells[start] !== FILLED || seen[start]) continue
    const comp: number[] = []
    const stack = [start]
    seen[start] = 1
    while (stack.length) {
      const i = stack.pop()!
      comp.push(i)
      const x = i % w
      const y = Math.floor(i / w)
      if (x > 0 && cells[i - 1] === FILLED && !seen[i - 1]) {
        seen[i - 1] = 1
        stack.push(i - 1)
      }
      if (x + 1 < w && cells[i + 1] === FILLED && !seen[i + 1]) {
        seen[i + 1] = 1
        stack.push(i + 1)
      }
      if (y > 0 && cells[i - w] === FILLED && !seen[i - w]) {
        seen[i - w] = 1
        stack.push(i - w)
      }
      if (y + 1 < h && cells[i + w] === FILLED && !seen[i + w]) {
        seen[i + w] = 1
        stack.push(i + w)
      }
    }
    comps.push(comp)
  }

  const trapped: number[] = []
  if (comps.length > 1) {
    for (const comp of comps) {
      let canGrow = false
      for (const i of comp) {
        const x = i % w
        const y = Math.floor(i / w)
        if (x > 0 && cells[i - 1] !== FILLED) canGrow = true
        if (x + 1 < w && cells[i + 1] !== FILLED) canGrow = true
        if (y > 0 && cells[i - w] !== FILLED) canGrow = true
        if (y + 1 < h && cells[i + w] !== FILLED) canGrow = true
      }
      if (!canGrow) {
        for (const i of comp) {
          trapped.push(i)
          bad.add(i)
        }
      }
    }
    // 所有区域都完成时，除最大块外都标红
    if (regionsDone === regionCount && comps.length > 1) {
      let largest = 0
      for (let k = 1; k < comps.length; k++) {
        if (comps[k]!.length > comps[largest]!.length) largest = k
      }
      for (let k = 0; k < comps.length; k++) {
        if (k === largest) continue
        for (const i of comps[k]!) bad.add(i)
      }
    }
  }

  const changedGivens: number[] = []
  for (let i = 0; i < n; i++) {
    if (givens[i] === FILLED && cells[i] !== FILLED) {
      changedGivens.push(i)
      bad.add(i)
    }
  }

  let unassigned = 0
  let outsideCount = 0
  for (let i = 0; i < n; i++) {
    if (ctx.outside[i]) outsideCount++
    else if (regions[i]! < 0) unassigned++
  }

  const complete = regionsDone === regionCount
  const solved =
    complete &&
    blockCount === 0 &&
    conflictPairs.size === 0 &&
    comps.length === 1 &&
    changedGivens.length === 0 &&
    unassigned === 0

  return {
    solved,
    filled,
    empty: n - outsideCount - filled,
    regionsTotal: regionCount,
    regionsDone,
    overfilled,
    underfilled,
    invalidPieces,
    unassigned,
    blockCount,
    blockCells: Array.from(new Set(blockCells)),
    conflictCount: conflictPairs.size,
    conflictCells: Array.from(new Set(conflictCells)),
    parts: comps.length,
    trapped: Array.from(new Set(trapped)),
    changedGivens,
    badCells: Array.from(bad),
    complete,
    regionInfo,
  }
}

export function statusBits(result: ValidationResult): string[] {
  const r = result as LitsResult
  if (r.solved) return ['完成']
  const bits: string[] = []
  if (typeof r.unassigned === 'number' && r.unassigned > 0) bits.push(`${r.unassigned} 格未划分区域`)
  if (r.underfilled > 0) bits.push(`${r.underfilled} 个区域未满 4 格`)
  if (r.overfilled > 0) bits.push(`${r.overfilled} 个区域超过 4 格`)
  if (r.invalidPieces > 0) bits.push(`${r.invalidPieces} 个区域不是 L/I/S/T`)
  if (r.blockCount > 0) bits.push(`${r.blockCount} 处 2×2 实心`)
  if (r.conflictCount > 0) bits.push(`${r.conflictCount} 处同型骨牌接触`)
  if (r.complete && r.parts > 1) bits.push(`骨牌分成 ${r.parts} 块未连通`)
  else if (r.trapped.length > 0) bits.push(`有 ${r.trapped.length} 格被永久隔断`)
  if (r.changedGivens.length > 0) bits.push('题面给定格被改动')
  if (!bits.length) bits.push('继续放置骨牌')
  return bits
}

/* ────────────────────────── 逻辑推演计划 ────────────────────────── */

function recordSingletons(
  ctx: LitsContext,
  domains: Candidate[][],
  recorded: Uint8Array,
  deductions: Deduction[],
  rule: number,
  label: string,
): boolean {
  let any = false
  for (let r = 0; r < ctx.regionCount; r++) {
    if (!recorded[r] && domains[r]!.length === 1) {
      recorded[r] = 1
      deductions.push({
        cells: domains[r]![0]!.cells,
        value: FILLED,
        rule,
        label,
      })
      any = true
    }
  }
  return any
}

function allRecorded(ctx: LitsContext, recorded: Uint8Array): boolean {
  for (let r = 0; r < ctx.regionCount; r++) if (!recorded[r]) return false
  return true
}

/**
 * 从当前盘面出发做推演。
 * 先传播必然结论；卡住时逐区域反证；仍卡住时才回溯补完（saturated=false）。
 */
export function planFromState(
  ctx: LitsContext,
  filled: ArrayLike<number>,
  maxNodes = 200_000,
  maxProbe = 3000,
): LogicOutcome {
  const domains = buildDomains(ctx, filled)
  const deductions: Deduction[] = []
  const recorded = new Uint8Array(ctx.regionCount)
  const seenCells = new Set<number>()
  const record: DeductionRecorder = (cell, value, rule, label) => {
    if (seenCells.has(cell)) return
    seenCells.add(cell)
    deductions.push({ cells: [cell], value, rule, label })
  }
  const empty: LogicOutcome = {
    ok: false,
    solution: null,
    deductions,
    saturated: false,
    nodes: 0,
    usedProbe: false,
    usedSearch: false,
    probes: 0,
    searchNodes: 0,
  }

  for (let r = 0; r < ctx.regionCount; r++) if (!domains[r]!.length) return empty

  if (!propagateDomains(ctx, domains, record)) return empty
  recordSingletons(
    ctx,
    domains,
    recorded,
    deductions,
    5,
    '候选域收缩：该区域只剩这一种 L/I/S/T 形状',
  )

  // 反证：逐个区域尝试候选；若某候选立刻矛盾则删掉
  let probeUsed = false
  let probes = 0
  let probeOut = false
  for (let round = 0; round < ctx.regionCount * 4; round++) {
    if (allRecorded(ctx, recorded)) break
    let removedAny = false
    for (let r = 0; r < ctx.regionCount; r++) {
      if (recorded[r] || domains[r]!.length <= 1) continue
      const keep: Candidate[] = []
      for (const cand of domains[r]!) {
        if (probes++ >= maxProbe) {
          probeOut = true
          break
        }
        const trial = cloneDomains(domains)
        trial[r] = [cand]
        if (propagateDomains(ctx, trial)) {
          keep.push(cand)
        } else {
          removedAny = true
          probeUsed = true
        }
      }
      if (probeOut) break
      if (!keep.length) return empty
      if (keep.length !== domains[r]!.length) {
        domains[r] = keep
        if (!propagateDomains(ctx, domains, record)) return empty
        recordSingletons(
          ctx,
          domains,
          recorded,
          deductions,
          6,
          '反证探测：其余候选形状都会导致矛盾',
        )
      }
    }
    if (probeOut || !removedAny) break
  }

  let solution: number[] | null = null
  let saturated = false
  let fallbackNodes = 0

  if (allRecorded(ctx, recorded)) {
    solution = solutionFromDomains(ctx, domains)
    if (solution && validateSolution(ctx, solution).ok) {
      saturated = true
    } else {
      solution = null
    }
  }

  if (!solution) {
    const fallback = solveDomains(ctx, domains, maxNodes)
    fallbackNodes = fallback.nodes
    if (!fallback.ok || !fallback.solution) return empty
    solution = fallback.solution
    // 为尚未记录的区域补上最终形状
    for (let r = 0; r < ctx.regionCount; r++) {
      if (recorded[r]) continue
      const cells: number[] = []
      for (let i = 0; i < ctx.n; i++) {
        if (ctx.regions[i] === r && solution[i] === FILLED) cells.push(i)
      }
      deductions.push({
        cells,
        value: FILLED,
        rule: 7,
        label: '回溯试探：该区域最终放这一块',
      })
      recorded[r] = 1
    }
  }

  return {
    ok: true,
    solution,
    deductions,
    saturated,
    nodes: 0,
    usedProbe: probeUsed,
    usedSearch: !saturated,
    probes,
    searchNodes: fallbackNodes,
  }
}

/* ────────────────────────── 编码 / 解码 ────────────────────────── */

const BASE62 = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'

export function encodeRegions(regions: number[]): string {
  let maxRegion = -1
  for (const r of regions) if (r > maxRegion) maxRegion = r
  // 超过单字符 base62 容量时，每格改用两个 base62 字符，最多 62² = 3844 个区域。
  const wide = maxRegion >= BASE62.length
  let out = ''
  for (const r of regions) {
    if (r < 0) {
      out += wide ? '..' : '.'
    } else if (wide) {
      out += BASE62[Math.floor(r / BASE62.length)]! + BASE62[r % BASE62.length]!
    } else {
      out += BASE62[r]!
    }
  }
  return out
}

export function decodeRegions(text: string, expected: number): number[] | null {
  if (typeof text !== 'string') return null
  const wide = text.length === expected * 2 && text.length !== expected
  if (text.length !== expected && !wide) return null
  const out: number[] = []
  if (wide) {
    for (let i = 0; i < expected; i++) {
      const a = text[i * 2]!
      const b = text[i * 2 + 1]!
      if (a === '.' || a === '?' || a === '-' || b === '.' || b === '?' || b === '-') {
        out.push(-1)
        continue
      }
      const va = BASE62.indexOf(a)
      const vb = BASE62.indexOf(b)
      if (va < 0 || vb < 0) return null
      out.push(va * BASE62.length + vb)
    }
    return out
  }
  for (let i = 0; i < expected; i++) {
    const ch = text[i]!
    if (ch === '.' || ch === '?' || ch === '-') {
      out.push(-1)
      continue
    }
    const v = BASE62.indexOf(ch)
    if (v < 0) return null
    out.push(v)
  }
  return out
}

export function encodeBits(cells: ArrayLike<number>): string {
  let out = ''
  for (let i = 0; i < cells.length; i++) {
    out += cells[i] === FILLED ? '1' : cells[i] === CROSS ? '2' : '0'
  }
  return out
}

export function decodeBits(text: string, expected: number): number[] | null {
  if (typeof text !== 'string' || text.length !== expected) return null
  const out: number[] = []
  for (let i = 0; i < expected; i++) {
    const ch = text[i]!
    if (ch === '1' || ch === '#' || ch === 'X' || ch === 'x') out.push(FILLED)
    else if (ch === '2') out.push(CROSS)
    else if (ch === '0' || ch === '.' || ch === '-') out.push(EMPTY)
    else return null
  }
  return out
}

/* ────────────────────────── 提示 ────────────────────────── */

export function firstHintMove(state: LitsState, solution: LitsState): Move | null {
  const size = Math.min(state.cells.length, solution.cells.length)
  for (let i = 0; i < size; i++) {
    if (state.givens[i] === FILLED) continue
    if (state.cells[i] !== FILLED && solution.cells[i] === FILLED) {
      return { index: i, from: state.cells[i]!, to: FILLED }
    }
  }
  for (let i = 0; i < size; i++) {
    if (state.givens[i] === FILLED) continue
    if (state.cells[i] !== solution.cells[i]) {
      return { index: i, from: state.cells[i]!, to: solution.cells[i]! }
    }
  }
  return null
}

/* ────────────────────────── 类型守卫 ────────────────────────── */

export function asLitsPuzzle(p: Puzzle): LitsPuzzle {
  return p as LitsPuzzle
}

export function asLitsState(s: GameState): LitsState {
  return s as LitsState
}
