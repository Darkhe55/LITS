/**
 * LITS 题库生成器
 *
 * 1. 随机生长出 k 块合法骨牌（L/I/S/T，互不同型接触，已连成一片，无 2×2）；
 * 2. 以每块骨牌为种子，用多源 BFS 把棋盘其余格分给各区域（区域保持连通）；
 * 3. 用候选域求解器统计解的个数，只保留唯一解；
 * 4. 优先保留「纯逻辑（传播 + 反证）即可推满」的题面。
 *
 * 该文件被 scripts/gen-config.mjs 直接 import（Node 24 支持 type stripping）。
 */

import type { Difficulty } from '../core/types'
import {
  buildDomains,
  countSolutions,
  EMPTY,
  FILLED,
  encodeBits,
  encodeRegions,
  makeContext,
  planFromState,
  validateSolution,
  type LitsContext,
  type PieceType,
} from './engine.ts'

export interface RawPuzzleOut {
  id: string
  name: string
  width: number
  height: number
  difficulty: Difficulty
  series: string
  board: string
  solution: string
  givens?: string
}

interface GenSpec {
  w: number
  h: number
  pieces: number
  seed: number
  difficulty: Difficulty
  name: string
  series: string
  attempts: number
  requireLogic: boolean
  maxNodes: number
  maxProbe: number
  maxGivens: number
}

interface PlacedPiece {
  type: PieceType
  cells: number[]
}

const BASE_PATTERNS: Record<PieceType, Array<[number, number]>> = {
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

function normalize(points: Array<[number, number]>): Array<[number, number]> {
  let minX = Infinity
  let minY = Infinity
  for (const [x, y] of points) {
    if (x < minX) minX = x
    if (y < minY) minY = y
  }
  const out = points.map(([x, y]) => [x - minX, y - minY] as [number, number])
  out.sort((a, b) => (a[1] === b[1] ? a[0] - b[0] : a[1] - b[1]))
  return out
}

function keyOf(points: Array<[number, number]>): string {
  return points.map(([x, y]) => `${x},${y}`).join(';')
}

function buildOrientations(base: Array<[number, number]>): Array<Array<[number, number]>> {
  const seen = new Set<string>()
  const out: Array<Array<[number, number]>> = []
  for (let t = 0; t < 8; t++) {
    const transformed: Array<[number, number]> = []
    for (const [x0, y0] of base) {
      let x = x0
      let y = y0
      if (t & 1) x = -x
      if (t & 2) y = -y
      if (t & 4) {
        const tmp = x
        x = y
        y = tmp
      }
      transformed.push([x, y])
    }
    const norm = normalize(transformed)
    const key = keyOf(norm)
    if (!seen.has(key)) {
      seen.add(key)
      out.push(norm)
    }
  }
  return out
}

const ORIENTATIONS: Record<PieceType, Array<Array<[number, number]>>> = {
  I: buildOrientations(BASE_PATTERNS.I),
  L: buildOrientations(BASE_PATTERNS.L),
  S: buildOrientations(BASE_PATTERNS.S),
  T: buildOrientations(BASE_PATTERNS.T),
}

const TYPES: PieceType[] = ['I', 'L', 'S', 'T']

function mulberry32(a: number): () => number {
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function shuffle<T>(list: T[], rng: () => number): T[] {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    const tmp = list[i]!
    list[i] = list[j]!
    list[j] = tmp
  }
  return list
}

function cellsAt(
  orient: Array<[number, number]>,
  ox: number,
  oy: number,
  w: number,
  h: number,
): number[] | null {
  const out: number[] = []
  for (const [dx, dy] of orient) {
    const x = ox + dx
    const y = oy + dy
    if (x < 0 || y < 0 || x >= w || y >= h) return null
    out.push(y * w + x)
  }
  return out
}

function has2x2(occupied: Set<number>, cells: number[], w: number, h: number): boolean {
  const set = new Set(occupied)
  for (const i of cells) set.add(i)
  for (const i of cells) {
    const x = i % w
    const y = Math.floor(i / w)
    const corners: Array<[number, number]> = [
      [x - 1, y - 1],
      [x, y - 1],
      [x - 1, y],
      [x, y],
    ]
    for (const [tx, ty] of corners) {
      if (tx < 0 || ty < 0 || tx + 1 >= w || ty + 1 >= h) continue
      const a = ty * w + tx
      if (set.has(a) && set.has(a + 1) && set.has(a + w) && set.has(a + w + 1)) return true
    }
  }
  return false
}

function touches(a: number[], b: number[], w: number): boolean {
  for (const i of a) {
    const ix = i % w
    const iy = Math.floor(i / w)
    for (const j of b) {
      const jx = j % w
      const jy = Math.floor(j / w)
      if (Math.abs(ix - jx) + Math.abs(iy - jy) === 1) return true
    }
  }
  return false
}

function tryPlacePieces(
  w: number,
  h: number,
  k: number,
  rng: () => number,
): PlacedPiece[] | null {
  const pieces: PlacedPiece[] = []
  const occupied = new Set<number>()

  const addPiece = (piece: PlacedPiece): void => {
    pieces.push(piece)
    for (const i of piece.cells) occupied.add(i)
  }

  // 第一块：任意位置
  let first: PlacedPiece | null = null
  for (let tries = 0; tries < 300 && !first; tries++) {
    const type = TYPES[Math.floor(rng() * TYPES.length)]!
    const orient = ORIENTATIONS[type][Math.floor(rng() * ORIENTATIONS[type].length)]!
    let maxX = 0
    let maxY = 0
    for (const [x, y] of orient) {
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
    }
    if (maxX >= w || maxY >= h) continue
    const ox = Math.floor(rng() * (w - maxX))
    const oy = Math.floor(rng() * (h - maxY))
    const cells = cellsAt(orient, ox, oy, w, h)
    if (!cells) continue
    first = { type, cells }
  }
  if (!first) return null
  addPiece(first)

  for (let p = 1; p < k; p++) {
    const anchors: number[] = []
    for (const i of occupied) {
      const x = i % w
      const y = Math.floor(i / w)
      if (x > 0 && !occupied.has(i - 1)) anchors.push(i - 1)
      if (x + 1 < w && !occupied.has(i + 1)) anchors.push(i + 1)
      if (y > 0 && !occupied.has(i - w)) anchors.push(i - w)
      if (y + 1 < h && !occupied.has(i + w)) anchors.push(i + w)
    }
    shuffle(anchors, rng)

    let placed = false
    for (const anchor of anchors) {
      const ax = anchor % w
      const ay = Math.floor(anchor / w)
      const options: PlacedPiece[] = []
      for (const type of TYPES) {
        for (const orient of ORIENTATIONS[type]) {
          for (const [dx, dy] of orient) {
            const ox = ax - dx
            const oy = ay - dy
            const cells = cellsAt(orient, ox, oy, w, h)
            if (!cells) continue
            if (cells.some((i) => occupied.has(i))) continue
            if (has2x2(occupied, cells, w, h)) continue
            if (pieces.some((pc) => pc.type === type && touches(pc.cells, cells, w))) continue
            options.push({ type, cells })
          }
        }
      }
      if (options.length) {
        const chosen = options[Math.floor(rng() * options.length)]!
        addPiece(chosen)
        placed = true
        break
      }
    }
    if (!placed) return null
  }

  const kinds = new Set(pieces.map((p) => p.type)).size
  const need = k >= 8 ? 4 : 3
  if (kinds < need) return null
  return pieces
}

function partition(pieces: PlacedPiece[], w: number, h: number, rng: () => number): number[] {
  const n = w * h
  const owner = new Int32Array(n)
  owner.fill(-1)
  const sizes = pieces.map(() => 0)
  const frontiers: number[][] = pieces.map(() => [])

  const addFrontier = (r: number, i: number): void => {
    if (owner[i] === -1) frontiers[r]!.push(i)
  }

  for (let p = 0; p < pieces.length; p++) {
    for (const i of pieces[p]!.cells) {
      owner[i] = p
      sizes[p]!++
    }
  }

  for (let i = 0; i < n; i++) {
    if (owner[i] === -1) continue
    const r = owner[i]!
    const x = i % w
    const y = Math.floor(i / w)
    if (x > 0) addFrontier(r, i - 1)
    if (x + 1 < w) addFrontier(r, i + 1)
    if (y > 0) addFrontier(r, i - w)
    if (y + 1 < h) addFrontier(r, i + w)
  }

  let remaining = n - pieces.length * 4
  while (remaining > 0) {
    let best = Infinity
    for (let r = 0; r < pieces.length; r++) {
      if (sizes[r]! >= best) continue
      if (frontiers[r]!.some((i) => owner[i] === -1)) best = sizes[r]!
    }
    const choices: number[] = []
    for (let r = 0; r < pieces.length; r++) {
      if (sizes[r]! <= best + 1 && frontiers[r]!.some((i) => owner[i] === -1)) choices.push(r)
    }
    if (!choices.length) break
    const r = choices[Math.floor(rng() * choices.length)]!

    let cell = -1
    while (frontiers[r]!.length) {
      const idx = Math.floor(rng() * frontiers[r]!.length)
      const candidate = frontiers[r]!.splice(idx, 1)[0]!
      if (owner[candidate] === -1) {
        cell = candidate
        break
      }
    }
    if (cell < 0) continue
    owner[cell] = r
    sizes[r]!++
    remaining--
    const x = cell % w
    const y = Math.floor(cell / w)
    if (x > 0) addFrontier(r, cell - 1)
    if (x + 1 < w) addFrontier(r, cell + 1)
    if (y > 0) addFrontier(r, cell - w)
    if (y + 1 < h) addFrontier(r, cell + w)
  }

  return Array.from(owner)
}

const EMPTY_FILLED = (n: number): number[] => new Array<number>(n).fill(EMPTY)

interface AttemptStats {
  placeFail: number
  partitionFail: number
  domainFail: number
  notUnique: number
  timeout: number
  planFail: number
  logicFail: number
  invalid: number
}

function attemptPuzzle(
  spec: GenSpec,
  rng: () => number,
  stats: AttemptStats,
): { pieces: PlacedPiece[]; regions: number[]; solution: number[]; givens: number[] } | null {
  const { w, h } = spec
  const n = w * h
  const pieces = tryPlacePieces(w, h, spec.pieces, rng)
  if (!pieces) {
    stats.placeFail++
    return null
  }
  const regions = partition(pieces, w, h, rng)
  if (regions.some((r) => r < 0)) {
    stats.partitionFail++
    return null
  }

  let ctx: LitsContext
  try {
    ctx = makeContext(regions, w, h)
  } catch {
    stats.partitionFail++
    return null
  }

  const zeros = EMPTY_FILLED(n)
  let givens = zeros.slice()
  let domains = buildDomains(ctx, givens)
  for (const list of domains) {
    if (!list.length) {
      stats.domainFail++
      return null
    }
  }

  let counted = countSolutions(ctx, domains, 2, spec.maxNodes)
  if (counted.timedOut) {
    stats.timeout++
    return null
  }

  // 标准 LITS 不预填任何格子：区域布局本身必须唯一
  if (counted.count !== 1) {
    stats.notUnique++
    return null
  }

  const plan = planFromState(ctx, givens, spec.maxNodes, spec.maxProbe)
  if (!plan.ok || !plan.solution) {
    stats.planFail++
    return null
  }
  if (spec.requireLogic && (!plan.saturated || plan.usedSearch)) {
    stats.logicFail++
    return null
  }

  const check = validateSolution(ctx, plan.solution)
  if (!check.ok) {
    stats.invalid++
    return null
  }

  return { pieces, regions, solution: plan.solution, givens }
}

const SPECS: GenSpec[] = [
  {
    w: 6,
    h: 6,
    pieces: 6,
    seed: 0x4c49545301,
    difficulty: 'easy',
    name: '初识骨墙',
    series: '入门',
    attempts: 30000,
    requireLogic: true,
    maxNodes: 120_000,
    maxProbe: 1200,
    maxGivens: 0,
  },
  {
    w: 6,
    h: 6,
    pieces: 6,
    seed: 0x4c49545302,
    difficulty: 'easy',
    name: '四格初阵',
    series: '入门',
    attempts: 30000,
    requireLogic: false,
    maxNodes: 120_000,
    maxProbe: 1200,
    maxGivens: 0,
  },
  {
    w: 6,
    h: 6,
    pieces: 6,
    seed: 0x4c49545303,
    difficulty: 'medium',
    name: 'L 形回廊',
    series: '进阶',
    attempts: 30000,
    requireLogic: false,
    maxNodes: 120_000,
    maxProbe: 1200,
    maxGivens: 0,
  },
  {
    w: 6,
    h: 6,
    pieces: 6,
    seed: 0x4c49545304,
    difficulty: 'medium',
    name: '交错墙影',
    series: '进阶',
    attempts: 30000,
    requireLogic: false,
    maxNodes: 120_000,
    maxProbe: 1200,
    maxGivens: 0,
  },
  {
    w: 6,
    h: 6,
    pieces: 6,
    seed: 0x4c49545305,
    difficulty: 'hard',
    name: '骨墙迷宫',
    series: '挑战',
    attempts: 30000,
    requireLogic: false,
    maxNodes: 120_000,
    maxProbe: 1200,
    maxGivens: 0,
  },
  {
    w: 6,
    h: 6,
    pieces: 6,
    seed: 0x4c49545306,
    difficulty: 'hard',
    name: '四型终局',
    series: '挑战',
    attempts: 30000,
    requireLogic: false,
    maxNodes: 120_000,
    maxProbe: 1200,
    maxGivens: 0,
  },
]

export function generatePuzzles(): RawPuzzleOut[] {
  const out: RawPuzzleOut[] = []
  for (const spec of SPECS) {
    const rng = mulberry32(spec.seed)
    const stats: AttemptStats = {
      placeFail: 0,
      partitionFail: 0,
      domainFail: 0,
      notUnique: 0,
      timeout: 0,
      planFail: 0,
      logicFail: 0,
      invalid: 0,
    }
    let made: {
      pieces: PlacedPiece[]
      regions: number[]
      solution: number[]
      givens: number[]
    } | null = null
    for (let attempt = 0; attempt < spec.attempts; attempt++) {
      made = attemptPuzzle(spec, rng, stats)
      if (made) break
    }
    if (!made) {
      console.error(`[LITS gen] ${spec.name} 失败统计：`, stats)
      throw new Error(`[LITS gen] ${spec.name} 在 ${spec.attempts} 次尝试内没有生成合法题`)
    }
    const kinds = Array.from(new Set(made.pieces.map((p) => p.type))).sort().join('')
    console.log(
      `[LITS gen] ${spec.name} ${spec.w}×${spec.h}：${spec.pieces} 块（${kinds}），区域 ${spec.pieces} 个，实心 ${made.solution.filter((v) => v === 1).length} 格`,
    )
    out.push({
      id: `lits2-${spec.w}x${spec.h}-${spec.seed.toString(36)}`,
      name: spec.name,
      width: spec.w,
      height: spec.h,
      difficulty: spec.difficulty,
      series: spec.series,
      board: encodeRegions(made.regions),
      solution: encodeBits(made.solution),
      ...(made.givens.some((v) => v === FILLED) ? { givens: encodeBits(made.givens) } : {}),
    })
  }
  return out
}
