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
  const gap = 2
  const inner = m.cell - gap
  const radius = m.cell * 0.13
  const bad = new Set<number>(r.badCells ?? [])
  const conflict = new Set<number>(r.conflictCells ?? [])
  const block = new Set<number>(r.blockCells ?? [])
  const infoById = new Map<number, RegionInfo>()
  for (const info of r.regionInfo ?? []) infoById.set(info.id, info)

  const parts: string[] = []
  parts.push(
    `<rect class="lits-board-bg" x="${m.pad - 12}" y="${m.pad - 12}" width="${w * m.cell + 24}" height="${h * m.cell + 24}" rx="${m.cell * 0.22}" />`,
  )

  // —— 单元格 ——
  for (let i = 0; i < w * h; i++) {
    const x = m.pad + (i % w) * m.cell + gap / 2
    const y = m.pad + Math.floor(i / w) * m.cell + gap / 2
    const region = p.regions[i] ?? -1
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

    let content = `<rect class="${cls}" x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${inner.toFixed(2)}" height="${inner.toFixed(2)}" rx="${radius.toFixed(2)}"${fillAttr} />`

    if (filled) {
      content += `<rect class="lits-sheen" x="${(x + 2).toFixed(2)}" y="${(y + 2).toFixed(2)}" width="${(inner - 4).toFixed(2)}" height="${(inner * 0.34).toFixed(2)}" rx="${(radius * 0.7).toFixed(2)}" />`
    } else if (s.cells[i] === CROSS) {
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
  const seenEdges = new Set<string>()
  const lineParts: string[] = []
  const addLine = (x1: number, y1: number, x2: number, y2: number): void => {
    const key = `${x1.toFixed(1)},${y1.toFixed(1)},${x2.toFixed(1)},${y2.toFixed(1)}`
    if (seenEdges.has(key)) return
    seenEdges.add(key)
    lineParts.push(
      `<line class="lits-region-line" x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}" />`,
    )
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      const region = p.regions[i] ?? -1
      const x0 = m.pad + x * m.cell
      const y0 = m.pad + y * m.cell
      const left = x > 0 ? (p.regions[i - 1] ?? -1) : null
      const up = y > 0 ? (p.regions[i - w] ?? -1) : null
      const right = x + 1 < w ? (p.regions[i + 1] ?? -1) : null
      const down = y + 1 < h ? (p.regions[i + w] ?? -1) : null
      if (left === null || left !== region) addLine(x0, y0, x0, y0 + m.cell)
      if (up === null || up !== region) addLine(x0, y0, x0 + m.cell, y0)
      if (right === null || right !== region) addLine(x0 + m.cell, y0, x0 + m.cell, y0 + m.cell)
      if (down === null || down !== region) addLine(x0, y0 + m.cell, x0 + m.cell, y0 + m.cell)
    }
  }
  parts.push(`<g class="lits-region-lines">${lineParts.join('')}</g>`)

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
  return { index: row * puzzle.width + col }
}
