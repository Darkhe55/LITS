/**
 * LITS —— SVG 渲染与命中
 *
 * 视觉层次：
 *   区域淡色底 → 骨牌实心块 → 区域粗边界 → 区域编号 / n/4 / 类型徽章 → 命中层
 */

import type { BoardMetrics, GameState, Puzzle, ValidationResult } from '../core/types'
import {
  asLitsPuzzle,
  asLitsState,
  CROSS,
  FILLED,
  type LitsResult,
  type PieceType,
  type RegionInfo,
} from './engine'

const REGION_FILLS = [
  'hsl(150 32% 93%)',
  'hsl(35 44% 93%)',
  'hsl(210 36% 93%)',
  'hsl(280 28% 94%)',
  'hsl(0 36% 94%)',
  'hsl(180 30% 92%)',
  'hsl(60 36% 93%)',
  'hsl(320 26% 94%)',
  'hsl(105 26% 93%)',
  'hsl(15 40% 93%)',
  'hsl(240 24% 94%)',
  'hsl(195 32% 92%)',
]

function regionFill(region: number): string {
  return REGION_FILLS[((region % REGION_FILLS.length) + REGION_FILLS.length) % REGION_FILLS.length]!
}

function typeClass(type: PieceType): string {
  return `t-${type.toLowerCase()}`
}

export function metricsFor(puzzle: Puzzle): BoardMetrics {
  const cell = 54
  const pad = 30
  return {
    cell,
    pad,
    width: puzzle.width,
    height: puzzle.height,
    svgWidth: pad * 2 + puzzle.width * cell,
    svgHeight: pad * 2 + puzzle.height * cell,
    k: 1,
  }
}

export function renderBoard(
  puzzle: Puzzle,
  state: GameState,
  result: ValidationResult,
  _colorGrid?: unknown,
): string {
  const m = metricsFor(puzzle)
  const p = asLitsPuzzle(puzzle)
  const s = asLitsState(state)
  const r = result as LitsResult
  const w = puzzle.width
  const h = puzzle.height
  const isCustomPuzzle = p.difficulty === 'custom'
  const isOutside = (i: number): boolean => p.regions[i]! < 0 && !isCustomPuzzle
  const baseInner = m.cell
  const radius = m.cell * 0.22
  const bad = new Set<number>(r.badCells ?? [])
  const conflict = new Set<number>(r.conflictCells ?? [])
  const block = new Set<number>(r.blockCells ?? [])
  const infoById = new Map<number, RegionInfo>()
  for (const info of r.regionInfo ?? []) infoById.set(info.id, info)

  const parts: string[] = []
  parts.push(
    `<rect class="lits-board-bg" x="${m.pad - 12}" y="${m.pad - 12}" width="${w * m.cell + 24}" height="${h * m.cell + 24}" rx="${m.cell * 0.22}" />`,
  )

  const regionAt = (x: number, y: number): number =>
    x < 0 || y < 0 || x >= w || y >= h ? -2 : p.regions[y * w + x]!

  /** 铺满整格的路径；只在“凸出的外侧角”做圆角，内部共享边保持直角无缝 */
  const roundedCellPath = (i: number, x0: number, y0: number, x1: number, y1: number): string => {
    const region = regionAt(i % w, Math.floor(i / w))
    const r = Math.min(radius, (x1 - x0) / 2, (y1 - y0) / 2)
    const boundary = (dx: number, dy: number): boolean =>
      regionAt((i % w) + dx, Math.floor(i / w) + dy) !== region
    const sameDiag = (dx: number, dy: number): boolean =>
      regionAt((i % w) + dx, Math.floor(i / w) + dy) === region
    const tl = boundary(-1, 0) && boundary(0, -1) && !sameDiag(-1, -1)
    const tr = boundary(1, 0) && boundary(0, -1) && !sameDiag(1, -1)
    const br = boundary(1, 0) && boundary(0, 1) && !sameDiag(1, 1)
    const bl = boundary(-1, 0) && boundary(0, 1) && !sameDiag(-1, 1)
    let d = `M ${(x0 + (tl ? r : 0)).toFixed(2)} ${y0.toFixed(2)}`
    d += ` L ${(x1 - (tr ? r : 0)).toFixed(2)} ${y0.toFixed(2)}`
    if (tr) d += ` Q ${x1.toFixed(2)} ${y0.toFixed(2)} ${x1.toFixed(2)} ${(y0 + r).toFixed(2)}`
    d += ` L ${x1.toFixed(2)} ${(y1 - (br ? r : 0)).toFixed(2)}`
    if (br) d += ` Q ${x1.toFixed(2)} ${y1.toFixed(2)} ${(x1 - r).toFixed(2)} ${y1.toFixed(2)}`
    d += ` L ${(x0 + (bl ? r : 0)).toFixed(2)} ${y1.toFixed(2)}`
    if (bl) d += ` Q ${x0.toFixed(2)} ${y1.toFixed(2)} ${x0.toFixed(2)} ${(y1 - r).toFixed(2)}`
    d += ` L ${x0.toFixed(2)} ${(y0 + (tl ? r : 0)).toFixed(2)}`
    if (tl) d += ` Q ${x0.toFixed(2)} ${y0.toFixed(2)} ${(x0 + r).toFixed(2)} ${y0.toFixed(2)}`
    return d + ' Z'
  }

  // —— 单元格 ——
  for (let i = 0; i < w * h; i++) {
    const region = p.regions[i] ?? -1
    if (isOutside(i)) continue
    // 同一区域的相邻格无缝拼接：格子铺满整个 cell，不再留 gap/圆角；
    // 只有自定义题板里“尚未划分”的格子保留内缩样式。
    const unassigned = region < 0
    const inset = unassigned ? 1 : 0
    const inner = baseInner - inset * 2
    const x = m.pad + (i % w) * m.cell + inset
    const y = m.pad + Math.floor(i / w) * m.cell + inset
    // 不同区域之间保留一条可见边距；同区域共享边不缩进，保持连续。
    const gapHalf = 1.5
    const col = i % w
    const row = Math.floor(i / w)
    const fx0 = x + (regionAt(col - 1, row) !== region ? gapHalf : 0)
    const fy0 = y + (regionAt(col, row - 1) !== region ? gapHalf : 0)
    const fx1 = x + inner - (regionAt(col + 1, row) !== region ? gapHalf : 0)
    const fy1 = y + inner - (regionAt(col, row + 1) !== region ? gapHalf : 0)
    const info = region >= 0 ? infoById.get(region) : undefined
    const filled = s.cells[i] === FILLED
    const completeType = info?.complete ? info.type : null
    const given = s.givens[i] === FILLED

    let cls = 'lits-cell'
    let fillAttr = ''
    if (region < 0) {
      cls += ' unassigned'
    } else if (filled) {
      cls += completeType ? ` filled ${typeClass(completeType)}` : ' filled pending'
    } else {
      fillAttr = ` fill="${regionFill(region)}"`
    }
    if (given) cls += ' given'
    if (bad.has(i)) cls += ' bad'
    if (conflict.has(i)) cls += ' conflict'
    if (block.has(i)) cls += ' block'

    let content = unassigned
      ? `<rect class="${cls}" x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${inner.toFixed(2)}" height="${inner.toFixed(2)}" rx="${radius.toFixed(2)}"${fillAttr} />`
      : `<path class="${cls}" d="${roundedCellPath(i, fx0, fy0, fx1, fy1)}"${fillAttr} />`

    if (s.cells[i] === CROSS) {
      const pad = inner * 0.28
      content += `<line class="lits-cross" x1="${(x + pad).toFixed(2)}" y1="${(y + pad).toFixed(2)}" x2="${(x + inner - pad).toFixed(2)}" y2="${(y + inner - pad).toFixed(2)}" />`
      content += `<line class="lits-cross" x1="${(x + inner - pad).toFixed(2)}" y1="${(y + pad).toFixed(2)}" x2="${(x + pad).toFixed(2)}" y2="${(y + inner - pad).toFixed(2)}" />`
    }

    if (given) {
      content += `<circle class="lits-given-dot${filled ? ' on-fill' : ''}" cx="${(x + inner - 7).toFixed(2)}" cy="${(y + 7).toFixed(2)}" r="${(m.cell * 0.07).toFixed(2)}" />`
    }

    if (region < 0) {
      content += `<text class="lits-unassigned-mark" x="${(x + inner / 2).toFixed(2)}" y="${(y + inner / 2).toFixed(2)}">?</text>`
    }

    if (bad.has(i)) {
      content += `<rect class="lits-bad" x="${(x + 0.8).toFixed(2)}" y="${(y + 0.8).toFixed(2)}" width="${(inner - 1.6).toFixed(2)}" height="${(inner - 1.6).toFixed(2)}" rx="${radius.toFixed(2)}" />`
    } else if (conflict.has(i)) {
      content += `<rect class="lits-conflict" x="${(x + 0.8).toFixed(2)}" y="${(y + 0.8).toFixed(2)}" width="${(inner - 1.6).toFixed(2)}" height="${(inner - 1.6).toFixed(2)}" rx="${radius.toFixed(2)}" />`
    }

    parts.push(`<g data-index="${i}" class="lits-cell-group">${content}</g>`)
  }

  // —— 区域粗边界 ——
  // 按区域边界描边，凸角使用与填充相同的圆角半径，避免小区域看起来是方框。
  type Point = [number, number]
  interface Edge {
    a: Point
    b: Point
  }
  const boundaries = new Map<number, Edge[]>()
  const edgeKeys = new Set<string>()
  const addEdge = (region: number, a: Point, b: Point): void => {
    const key = `${region}:${a[0].toFixed(1)},${a[1].toFixed(1)}:${b[0].toFixed(1)},${b[1].toFixed(1)}`
    const reverse = `${region}:${b[0].toFixed(1)},${b[1].toFixed(1)}:${a[0].toFixed(1)},${a[1].toFixed(1)}`
    if (edgeKeys.has(key) || edgeKeys.has(reverse)) return
    edgeKeys.add(key)
    let list = boundaries.get(region)
    if (!list) {
      list = []
      boundaries.set(region, list)
    }
    list.push({ a, b })
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (isOutside(i)) continue
      const region = p.regions[i] ?? -1
      const x0 = m.pad + x * m.cell
      const y0 = m.pad + y * m.cell
      const left = x > 0 ? (p.regions[i - 1] ?? -1) : null
      const up = y > 0 ? (p.regions[i - w] ?? -1) : null
      const right = x + 1 < w ? (p.regions[i + 1] ?? -1) : null
      const down = y + 1 < h ? (p.regions[i + w] ?? -1) : null
      if (left === null || left !== region) addEdge(region, [x0, y0], [x0, y0 + m.cell])
      if (up === null || up !== region) addEdge(region, [x0, y0], [x0 + m.cell, y0])
      if (right === null || right !== region)
        addEdge(region, [x0 + m.cell, y0], [x0 + m.cell, y0 + m.cell])
      if (down === null || down !== region)
        addEdge(region, [x0, y0 + m.cell], [x0 + m.cell, y0 + m.cell])
    }
  }

  const pointKey = (p: Point): string => `${p[0].toFixed(2)},${p[1].toFixed(2)}`
  const dist = (a: Point, b: Point): number => Math.hypot(a[0] - b[0], a[1] - b[1])
  const trim = (from: Point, to: Point, length: number): Point => {
    const d = dist(from, to)
    if (d <= 0) return from
    const t = Math.min(0.5, length / d)
    return [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t]
  }
  const regionLineParts: string[] = []
  for (const edges of boundaries.values()) {
    const byPoint = new Map<string, number[]>()
    edges.forEach((edge, index) => {
      for (const p of [edge.a, edge.b]) {
        const key = pointKey(p)
        const list = byPoint.get(key)
        if (list) list.push(index)
        else byPoint.set(key, [index])
      }
    })
    const used = new Set<number>()
    for (let startIndex = 0; startIndex < edges.length; startIndex++) {
      if (used.has(startIndex)) continue
      const first = edges[startIndex]!
      const start = first.a
      const points: Point[] = [start]
      let current = first.b
      used.add(startIndex)
      while (true) {
        points.push(current)
        if (pointKey(current) === pointKey(start)) break
        const candidates = byPoint.get(pointKey(current)) ?? []
        const next = candidates.find((idx) => !used.has(idx))
        if (next === undefined) break
        used.add(next)
        const edge = edges[next]!
        current = pointKey(edge.a) === pointKey(current) ? edge.b : edge.a
        if (points.length > edges.length + 2) break
      }
      if (points.length > 1 && pointKey(points[points.length - 1]!) === pointKey(points[0]!)) {
        points.pop()
      }
      if (points.length < 4) continue

      let area = 0
      for (let k = 0; k < points.length; k++) {
        const a = points[k]!
        const b = points[(k + 1) % points.length]!
        area += a[0] * b[1] - b[0] * a[1]
      }
      const orientation = area >= 0 ? 1 : -1
      let d = ''
      for (let k = 0; k < points.length; k++) {
        const prev = points[(k - 1 + points.length) % points.length]!
        const cur = points[k]!
        const next = points[(k + 1) % points.length]!
        const cross =
          (cur[0] - prev[0]) * (next[1] - cur[1]) -
          (cur[1] - prev[1]) * (next[0] - cur[0])
        const convex = cross * orientation > 0
        const r = convex
          ? Math.min(radius, dist(prev, cur) / 2, dist(cur, next) / 2)
          : 0
        const inPoint = convex ? trim(cur, prev, r) : cur
        const outPoint = convex ? trim(cur, next, r) : cur
        if (k === 0) {
          d = `M ${outPoint[0].toFixed(2)} ${outPoint[1].toFixed(2)}`
        } else {
          d += ` L ${inPoint[0].toFixed(2)} ${inPoint[1].toFixed(2)}`
          if (convex) {
            d += ` Q ${cur[0].toFixed(2)} ${cur[1].toFixed(2)} ${outPoint[0].toFixed(2)} ${outPoint[1].toFixed(2)}`
          }
        }
      }
      const firstPrev = points[points.length - 1]!
      const firstCur = points[0]!
      const firstNext = points[1]!
      const firstCross =
        (firstCur[0] - firstPrev[0]) * (firstNext[1] - firstCur[1]) -
        (firstCur[1] - firstPrev[1]) * (firstNext[0] - firstCur[0])
      const firstConvex = firstCross * orientation > 0
      const firstR = firstConvex
        ? Math.min(radius, dist(firstPrev, firstCur) / 2, dist(firstCur, firstNext) / 2)
        : 0
      const firstIn = firstConvex ? trim(firstCur, firstPrev, firstR) : firstCur
      const firstOut = firstConvex ? trim(firstCur, firstNext, firstR) : firstCur
      d += ` L ${firstIn[0].toFixed(2)} ${firstIn[1].toFixed(2)}`
      if (firstConvex) {
        d += ` Q ${firstCur[0].toFixed(2)} ${firstCur[1].toFixed(2)} ${firstOut[0].toFixed(2)} ${firstOut[1].toFixed(2)}`
      }
      regionLineParts.push(`<path class="lits-region-line" fill="none" d="${d} Z" />`)
    }
  }
  parts.push(`<g class="lits-region-lines">${regionLineParts.join('')}</g>`)

  // —— 区域编号（每个区域左上角） ——
  const regionAnchors = new Map<number, number>()
  for (let i = 0; i < w * h; i++) {
    const region = p.regions[i] ?? -1
    if (region < 0) continue
    const old = regionAnchors.get(region)
    if (old === undefined || i < old) regionAnchors.set(region, i)
  }
  const labelParts: string[] = []
  for (const [region, index] of regionAnchors) {
    const col = index % w
    const row = Math.floor(index / w)
    const filled = s.cells[index] === FILLED
    labelParts.push(
      `<text class="lits-region-no${filled ? ' on-fill' : ''}" x="${(m.pad + col * m.cell + 5).toFixed(2)}" y="${(m.pad + row * m.cell + 13).toFixed(2)}">${region + 1}</text>`,
    )
  }
  parts.push(`<g class="lits-region-labels">${labelParts.join('')}</g>`)

  // —— 进度 / 类型徽章 ——
  const badgeParts: string[] = []
  for (const info of r.regionInfo ?? []) {
    if (info.cells.length === 0) continue
    const cellCoords = info.cells.map((i) => ({
      x: m.pad + (i % w) * m.cell + m.cell / 2,
      y: m.pad + Math.floor(i / w) * m.cell + m.cell / 2,
    }))
    const center = cellCoords.reduce(
      (acc, cur) => ({ x: acc.x + cur.x / cellCoords.length, y: acc.y + cur.y / cellCoords.length }),
      { x: 0, y: 0 },
    )

    if (info.complete && info.type) {
      const filledCoords = info.cells
        .filter((i) => s.cells[i] === FILLED)
        .map((i) => ({
          x: m.pad + (i % w) * m.cell + m.cell / 2,
          y: m.pad + Math.floor(i / w) * m.cell + m.cell / 2,
        }))
      const c =
        filledCoords.length === 4
          ? filledCoords.reduce(
              (acc, cur) => ({ x: acc.x + cur.x / 4, y: acc.y + cur.y / 4 }),
              { x: 0, y: 0 },
            )
          : center
      const isBad = conflict.size > 0 && info.cells.some((i) => conflict.has(i))
      badgeParts.push(
        `<g class="lits-type-badge ${typeClass(info.type)}${isBad ? ' bad' : ''}"><circle cx="${c.x.toFixed(2)}" cy="${c.y.toFixed(2)}" r="${(m.cell * 0.23).toFixed(2)}" /><text x="${c.x.toFixed(2)}" y="${(c.y + 0.5).toFixed(2)}">${info.type}</text></g>`,
      )
    } else if (info.invalid) {
      badgeParts.push(
        `<g class="lits-type-badge bad"><circle cx="${center.x.toFixed(2)}" cy="${center.y.toFixed(2)}" r="${(m.cell * 0.23).toFixed(2)}" /><text x="${center.x.toFixed(2)}" y="${(center.y + 0.5).toFixed(2)}">!</text></g>`,
      )
    } else if (info.filled > 0 && info.filled < 4) {
      const bw = m.cell * 0.72
      const bh = m.cell * 0.34
      badgeParts.push(
        `<g class="lits-count-badge"><rect x="${(center.x - bw / 2).toFixed(2)}" y="${(center.y - bh / 2).toFixed(2)}" width="${bw.toFixed(2)}" height="${bh.toFixed(2)}" rx="${(bh / 2).toFixed(2)}" /><text x="${center.x.toFixed(2)}" y="${(center.y + 0.5).toFixed(2)}">${info.filled}/4</text></g>`,
      )
    }
  }
  parts.push(`<g class="lits-badges">${badgeParts.join('')}</g>`)

  // —— 命中层 ——
  for (let i = 0; i < w * h; i++) {
    if (isOutside(i)) continue
    const x = m.pad + (i % w) * m.cell
    const y = m.pad + Math.floor(i / w) * m.cell
    parts.push(
      `<rect class="cell-hit" data-index="${i}" x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${m.cell.toFixed(2)}" height="${m.cell.toFixed(2)}" />`,
    )
  }

  return `<svg class="board-svg lits-board" viewBox="0 0 ${m.svgWidth} ${m.svgHeight}" width="${m.svgWidth}" height="${m.svgHeight}" xmlns="http://www.w3.org/2000/svg">${parts.join('')}</svg>`
}

export function hitTest(
  m: BoardMetrics,
  puzzle: Puzzle,
  x: number,
  y: number,
): { index: number } | null {
  const col = Math.floor((x - m.pad) / m.cell)
  const row = Math.floor((y - m.pad) / m.cell)
  if (col < 0 || row < 0 || col >= puzzle.width || row >= puzzle.height) return null
  const index = row * puzzle.width + col
  const p = asLitsPuzzle(puzzle)
  if (p.regions[index]! < 0 && p.difficulty !== 'custom') return null
  return { index }
}
