/**
 * 通用自定义题板编辑器（颜色标记版）
 *
 * 职责：
 * - 尺寸输入（宽/高）+ 生成网格
 * - 调色板：预设色块 / 拖动色相滑块 / 直接输入色号
 * - 网格涂色：
 *     左键在空格上按下并拖动 → 涂成当前颜色
 *     左键点击已上色格子   → 把当前颜色切换成该格颜色
 *     右键在已上色格上拖动 → 擦除颜色
 * - 「载入题板」：构造 Puzzle → 交给 app 载入会话并入库
 * - 「保存到题库」：构造 Puzzle → 入库
 * - 「求解」/「逻辑解题」：委托 app 执行
 *
 * 键盘约定：
 *   方向键移动光标；Space/Backspace/Delete 清空格子；
 *   Enter/Tab 下一格（Shift 上一格）；Home/End 行首/行尾；Esc 关闭。
 */

import type { CustomCellColor, GameAdapter, Puzzle } from './types'

export interface CustomHost {
  setStatus(text: string, tone?: 'ok' | 'bad' | 'solving' | ''): void
  message(text: string, tone?: string): void
  loadPuzzle(p: Puzzle): void
  savePuzzle(p: Puzzle): void
  solveCurrent(): void
  runLogic(): void
}

const HEX_RE = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/

/** 把各种写法的色号规范成 #rrggbb；非法返回 null */
function normalizeHex(input: string): string | null {
  const match = HEX_RE.exec(input.trim())
  if (!match) return null
  let hex = match[1]!.toLowerCase()
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('')
  return `#${hex}`
}

function hexToRgb(hex: string): [number, number, number] {
  let h = hex.replace('#', '')
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  return [
    Number.parseInt(h.slice(0, 2), 16),
    Number.parseInt(h.slice(2, 4), 16),
    Number.parseInt(h.slice(4, 6), 16),
  ]
}

function hexToHsl(hex: string): { h: number; s: number; l: number } {
  const [r, g, b] = hexToRgb(hex)
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  const d = max - min
  let h = 0
  let s = 0
  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1))
    if (max === rn) h = ((gn - bn) / d) % 6
    else if (max === gn) h = (bn - rn) / d + 2
    else h = (rn - gn) / d + 4
    h *= 60
    if (h < 0) h += 360
  }
  return { h, s: s * 100, l: l * 100 }
}

function hslToHex(h: number, s: number, l: number): string {
  const sn = s / 100
  const ln = l / 100
  const c = (1 - Math.abs(2 * ln - 1)) * sn
  const hp = (((h % 360) + 360) % 360) / 60
  const x = c * (1 - Math.abs((hp % 2) - 1))
  let r = 0
  let g = 0
  let b = 0
  if (hp < 1) [r, g, b] = [c, x, 0]
  else if (hp < 2) [r, g, b] = [x, c, 0]
  else if (hp < 3) [r, g, b] = [0, c, x]
  else if (hp < 4) [r, g, b] = [0, x, c]
  else if (hp < 5) [r, g, b] = [x, 0, c]
  else [r, g, b] = [c, 0, x]
  const m = ln - c / 2
  const toHex = (v: number) =>
    Math.round(Math.min(1, Math.max(0, v + m)) * 255)
      .toString(16)
      .padStart(2, '0')
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`
}

export class CustomEditor {
  private w = 5
  private h = 5
  private grid: CustomCellColor[] = []
  private cursor = 0
  private selected: string
  private adapter: GameAdapter
  private gridEventsBound = false
  private colorEventsBound = false
  private stroke: 'paint' | 'erase' | null = null

  constructor(adapter: GameAdapter, private host: CustomHost) {
    this.adapter = adapter
    this.selected = normalizeHex(adapter.custom.defaultColor) ?? '#3b82f6'
  }

  isOpen(): boolean {
    const panel = document.getElementById('custom-editor')
    return !!panel && !panel.hidden
  }

  close(): void {
    const panel = document.getElementById('custom-editor')
    if (panel) panel.hidden = true
  }

  // —— 内部工具 ——

  private cellButton(i: number): HTMLButtonElement | null {
    return document.querySelector<HTMLButtonElement>(`.custom-cell[data-i="${i}"]`)
  }

  private stampCell(btn: HTMLElement, value: CustomCellColor): void {
    btn.classList.toggle('empty', value === null)
    btn.style.background = value ?? ''
    btn.title = value ?? '空格'
  }

  private setCell(i: number, value: CustomCellColor): void {
    if (i < 0 || i >= this.grid.length) return
    this.grid[i] = value
    const btn = this.cellButton(i)
    if (btn) this.stampCell(btn, value)
  }

  private selectCell(i: number): void {
    const max = this.w * this.h
    if (max <= 0) return
    this.cursor = Math.max(0, Math.min(max - 1, i))
    document.querySelectorAll('.custom-cell').forEach((el) => {
      const idx = Number((el as HTMLElement).dataset.i)
      el.classList.toggle('selected', idx === this.cursor)
    })
    this.cellButton(this.cursor)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }

  private moveCursor(dx: number, dy: number): void {
    const w = this.w
    const row = Math.floor(this.cursor / w)
    const col = this.cursor % w
    this.selectCell((row + dy) * w + (col + dx))
  }

  private readSize(): { w: number; h: number } {
    const wEl = document.getElementById('custom-w') as HTMLInputElement | null
    const hEl = document.getElementById('custom-h') as HTMLInputElement | null
    const meta = this.adapter.meta
    const w = Math.max(meta.customMinW, Math.min(meta.customMaxW, Number(wEl?.value) || 5))
    const h = Math.max(meta.customMinH, Math.min(meta.customMaxH, Number(hEl?.value) || 5))
    if (wEl) wEl.value = String(w)
    if (hEl) hEl.value = String(h)
    return { w, h }
  }

  // —— 颜色选择 ——

  private selectColor(color: string): void {
    const normalized = normalizeHex(color)
    if (!normalized) return
    this.selected = normalized
    this.refreshColorUI()
  }

  private refreshColorUI(): void {
    const hexEl = document.getElementById('custom-hex') as HTMLInputElement | null
    const picker = document.getElementById('custom-picker') as HTMLInputElement | null
    const hueEl = document.getElementById('custom-hue') as HTMLInputElement | null
    const swatch = document.getElementById('custom-swatch')
    if (hexEl && document.activeElement !== hexEl) hexEl.value = this.selected
    if (picker) picker.value = this.selected
    if (swatch) swatch.style.background = this.selected
    if (hueEl) hueEl.value = String(Math.round(hexToHsl(this.selected).h))
    document.querySelectorAll('.custom-swatch').forEach((el) => {
      el.classList.toggle('active', (el as HTMLElement).dataset.color === this.selected)
    })
  }

  private renderPalette(): void {
    const box = document.getElementById('custom-palette')
    if (!box || box.childElementCount) return
    box.innerHTML = this.adapter.custom.palette
      .map((color) => {
        const hex = normalizeHex(color) ?? '#000000'
        return `<button type="button" class="custom-swatch" data-color="${hex}" style="background:${hex}" title="${hex}"></button>`
      })
      .join('')
    box.querySelectorAll<HTMLButtonElement>('.custom-swatch').forEach((btn) => {
      btn.addEventListener('click', () => {
        const color = btn.dataset.color
        if (color) this.selectColor(color)
      })
    })
  }

  private bindColorControls(): void {
    if (this.colorEventsBound) return
    const hexEl = document.getElementById('custom-hex') as HTMLInputElement | null
    const picker = document.getElementById('custom-picker') as HTMLInputElement | null
    const hueEl = document.getElementById('custom-hue') as HTMLInputElement | null
    if (!hexEl && !picker && !hueEl) return
    this.colorEventsBound = true

    hexEl?.addEventListener('input', () => {
      const hex = normalizeHex(hexEl.value)
      if (hex) this.selectColor(hex)
    })
    hexEl?.addEventListener('change', () => {
      const hex = normalizeHex(hexEl.value)
      if (hex) this.selectColor(hex)
      else hexEl.value = this.selected
    })
    hexEl?.addEventListener('blur', () => {
      if (!normalizeHex(hexEl.value)) hexEl.value = this.selected
    })

    picker?.addEventListener('input', () => this.selectColor(picker.value))

    hueEl?.addEventListener('input', () => {
      const { s, l } = hexToHsl(this.selected)
      const nextS = Math.max(s, 55)
      const nextL = Math.min(Math.max(l, 45), 62)
      this.selectColor(hslToHex(Number(hueEl.value), nextS, nextL))
    })
  }

  // —— 渲染 ——

  renderGrid(): void {
    const grid = document.getElementById('custom-grid')
    if (!grid) return
    const { w, h } = this.readSize()
    this.w = w
    this.h = h
    if (this.grid.length !== w * h) {
      this.grid = new Array<CustomCellColor>(w * h).fill(null)
    }
    grid.style.gridTemplateColumns = `repeat(${w}, 36px)`
    grid.innerHTML = this.grid
      .map((v, i) => {
        const sel = i === this.cursor ? ' selected' : ''
        const bg = v ? ` style="background:${v}"` : ''
        const title = v ?? '空格'
        return `<button type="button" class="custom-cell${v === null ? ' empty' : ''}${sel}" data-i="${i}"${bg} title="${title}"></button>`
      })
      .join('')
    grid.tabIndex = 0
    this.bindGridEvents()
  }

  private bindGridEvents(): void {
    const grid = document.getElementById('custom-grid')
    if (!grid || this.gridEventsBound) return
    this.gridEventsBound = true

    grid.addEventListener('contextmenu', (e) => e.preventDefault())

    grid.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.button !== 2) return
      const target = (e.target as HTMLElement).closest<HTMLButtonElement>('.custom-cell')
      if (!target) return
      e.preventDefault()

      const i = Number(target.dataset.i)
      this.selectCell(i)
      const current = this.grid[i] ?? null
      this.stroke = null

      if (e.button === 0) {
        if (current === null) {
          this.stroke = 'paint'
          this.setCell(i, this.selected)
        } else {
          this.selectColor(current)
        }
      } else if (current !== null) {
        this.stroke = 'erase'
        this.setCell(i, null)
      }

      if (this.stroke) grid.setPointerCapture(e.pointerId)
    })

    grid.addEventListener('pointermove', (e) => {
      if (!this.stroke) return
      const el = document.elementFromPoint(e.clientX, e.clientY)
      const btn = el instanceof Element ? el.closest<HTMLButtonElement>('.custom-cell') : null
      if (!btn) return
      const i = Number(btn.dataset.i)
      if (this.stroke === 'paint') {
        if (this.grid[i] === null) this.setCell(i, this.selected)
      } else if (this.grid[i] !== null) {
        this.setCell(i, null)
      }
    })

    const endStroke = (e: PointerEvent): void => {
      if (!this.stroke) return
      this.stroke = null
      try {
        grid.releasePointerCapture(e.pointerId)
      } catch {
        /* ignore */
      }
    }
    grid.addEventListener('pointerup', endStroke)
    grid.addEventListener('pointercancel', endStroke)
  }

  open(): void {
    const panel = document.getElementById('custom-editor')
    if (!panel) return
    panel.hidden = false
    const wEl = document.getElementById('custom-w') as HTMLInputElement | null
    const hEl = document.getElementById('custom-h') as HTMLInputElement | null
    if (wEl) wEl.value = String(this.w)
    if (hEl) hEl.value = String(this.h)
    if (this.cursor >= this.w * this.h) this.cursor = 0
    this.renderPalette()
    this.bindColorControls()
    this.refreshColorUI()
    this.renderGrid()
    this.host.message(`键盘：方向键移动 · ${this.adapter.custom.hint}`)
    document.getElementById('custom-grid')?.focus()
  }

  regen(): void {
    this.grid = new Array<CustomCellColor>(this.w * this.h).fill(null)
    this.cursor = 0
    this.renderGrid()
    this.host.message(`已生成 ${this.w}×${this.h} 网格。${this.adapter.custom.hint}`)
    document.getElementById('custom-grid')?.focus()
  }

  // —— 键盘 ——

  /** 返回 true 表示已消费该按键（编辑器打开时优先处理） */
  handleKey(e: KeyboardEvent): boolean {
    if (!this.isOpen()) return false
    const k = e.key

    if (k === '.' || k === 'Backspace' || k === 'Delete' || k === ' ') {
      e.preventDefault()
      this.setCell(this.cursor, null)
      if (k === 'Backspace') this.moveCursor(-1, 0)
      else this.moveCursor(1, 0)
      return true
    }
    if (k === 'ArrowLeft') {
      e.preventDefault()
      this.moveCursor(-1, 0)
      return true
    }
    if (k === 'ArrowRight') {
      e.preventDefault()
      this.moveCursor(1, 0)
      return true
    }
    if (k === 'ArrowUp') {
      e.preventDefault()
      this.moveCursor(0, -1)
      return true
    }
    if (k === 'ArrowDown') {
      e.preventDefault()
      this.moveCursor(0, 1)
      return true
    }
    if (k === 'Enter' || k === 'Tab') {
      e.preventDefault()
      if (e.shiftKey) this.moveCursor(-1, 0)
      else this.moveCursor(1, 0)
      return true
    }
    if (k === 'Home') {
      e.preventDefault()
      this.selectCell(Math.floor(this.cursor / this.w) * this.w)
      return true
    }
    if (k === 'End') {
      e.preventDefault()
      this.selectCell(Math.floor(this.cursor / this.w) * this.w + this.w - 1)
      return true
    }
    if (k === 'Escape') {
      e.preventDefault()
      this.close()
      return true
    }
    return false
  }

  // —— 动作 ——

  private makePuzzle(existingId?: string): Puzzle {
    return this.adapter.custom.makePuzzle(this.w, this.h, this.grid.slice(), existingId)
  }

  load(): void {
    const { w, h } = this.readSize()
    this.w = w
    this.h = h
    if (this.grid.length !== w * h) {
      this.grid = new Array<CustomCellColor>(w * h).fill(null)
      this.renderGrid()
      this.host.message('网格已重置，请先填好内容。', 'bad')
      return
    }
    // 用「宽x高」做稳定 id，重复载入同尺寸只覆盖同一条（进度按 id 存）
    const stableId = `${this.adapter.meta.customIdPrefix}${w}x${h}`
    const puzzle = this.makePuzzle(stableId)
    this.host.loadPuzzle(puzzle)
  }

  save(): void {
    const { w, h } = this.readSize()
    if (this.grid.length !== w * h) {
      this.host.message('请先生成网格并填好内容。', 'bad')
      return
    }
    const stamp = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    const name = `自定义 · ${w}×${h} · ${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}${pad(stamp.getHours())}${pad(stamp.getMinutes())}`
    const puzzle = { ...this.makePuzzle(), name }
    this.host.savePuzzle(puzzle)
    this.host.message(`已保存到题库：「${name}」，下次启动仍可选用。`, 'ok')
  }

  solve(): void {
    this.host.solveCurrent()
  }

  logic(): void {
    this.close()
    this.host.runLogic()
  }
}
