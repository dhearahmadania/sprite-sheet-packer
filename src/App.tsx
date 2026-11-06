import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, DragEvent } from 'react'
import {
  Check,
  Copy,
  Download,
  Layers,
  Pause,
  Play,
  Sliders,
  Trash2,
} from 'lucide-react'

const SHEET_FILE = 'sprite-sheet.png'

type LayoutMode = 'horizontal' | 'grid'
type SnippetTab = 'steps' | 'keyframes'

type SpriteFrame = {
  id: string
  name: string
  url: string
  width: number
  height: number
  source: ImageBitmap
}

type SheetMetrics = {
  cellW: number
  cellH: number
  cols: number
  rows: number
  width: number
  height: number
}

type PackedSheet = {
  count: number
  metrics: SheetMetrics
  canvas: HTMLCanvasElement
  url: string
  bytes: number
}

type AnimationBuild = {
  timing: string
  keyframes: string
  stepsCode: string
  keyframesCode: string
  duration: string
}

function isFrameFile(file: File): boolean {
  if (file.type) return /^image\/(png|webp)$/i.test(file.type)
  return /\.(png|webp)$/i.test(file.name)
}

function hasFiles(event: DragEvent<HTMLElement>): boolean {
  const types = [...event.dataTransfer.types]
  return types.includes('Files') || types.includes('application/x-moz-file')
}

function releaseFrame(frame: SpriteFrame) {
  URL.revokeObjectURL(frame.url)
  frame.source.close()
}

async function loadFrame(file: File): Promise<SpriteFrame | null> {
  const url = URL.createObjectURL(file)
  try {
    const source = await createImageBitmap(file)
    if (source.width < 1 || source.height < 1) {
      source.close()
      URL.revokeObjectURL(url)
      return null
    }
    return {
      id: crypto.randomUUID(),
      name: file.name || 'frame.png',
      url,
      width: source.width,
      height: source.height,
      source,
    }
  } catch {
    URL.revokeObjectURL(url)
    return null
  }
}

function dataUrlBytes(url: string): number {
  const base64 = url.slice(url.indexOf(',') + 1)
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding)
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

function trimNumber(value: number): string {
  return Number(value.toFixed(4)).toString()
}

function packFrames(
  frames: SpriteFrame[],
  layout: LayoutMode,
  columns: number,
): PackedSheet | null {
  if (frames.length === 0) return null

  const cellW = Math.max(...frames.map((frame) => frame.width))
  const cellH = Math.max(...frames.map((frame) => frame.height))
  const cols =
    layout === 'horizontal'
      ? frames.length
      : Math.max(1, Math.min(columns, frames.length))
  const rows = Math.ceil(frames.length / cols)
  const metrics: SheetMetrics = {
    cellW,
    cellH,
    cols,
    rows,
    width: cols * cellW,
    height: rows * cellH,
  }

  const canvas = document.createElement('canvas')
  canvas.width = metrics.width
  canvas.height = metrics.height
  const context = canvas.getContext('2d')
  if (!context) return null
  context.imageSmoothingEnabled = false

  frames.forEach((frame, index) => {
    const col = index % cols
    const row = Math.floor(index / cols)
    const dx = col * cellW + Math.floor((cellW - frame.width) / 2)
    const dy = row * cellH + Math.floor((cellH - frame.height) / 2)
    context.drawImage(frame.source, dx, dy)
  })

  try {
    const url = canvas.toDataURL('image/png')
    return {
      count: frames.length,
      metrics,
      canvas,
      url,
      bytes: dataUrlBytes(url),
    }
  } catch {
    return null
  }
}

function framePosition(index: number, metrics: SheetMetrics, scale: number) {
  const col = index % metrics.cols
  const row = Math.floor(index / metrics.cols)
  return {
    x: -(col * metrics.cellW * scale),
    y: -(row * metrics.cellH * scale),
  }
}

function previewZoom(metrics: SheetMetrics): number {
  const fitCell = Math.max(1, Math.round(112 / metrics.cellH))
  const capped = Math.min(6, fitCell)
  if (metrics.width * capped <= 1600) return capped
  return Math.max(1, Math.floor(1600 / metrics.width))
}

function buildAnimation(
  packed: PackedSheet,
  scale: number,
  fps: number,
): AnimationBuild {
  const { metrics, count } = packed
  const duration = `${trimNumber(count / fps)}s`
  const frameW = metrics.cellW * scale
  const frameH = metrics.cellH * scale
  const sheetW = metrics.width * scale
  const sheetH = metrics.height * scale
  const positions = Array.from({ length: count }, (_, index) =>
    framePosition(index, metrics, scale),
  )

  const stepsTiming = metrics.rows === 1 ? `steps(${count})` : 'steps(1, end)'
  const stepsFrames =
    metrics.rows === 1
      ? `  from { background-position: 0 0; }\n  to { background-position: -${sheetW}px 0; }`
      : positions
          .map((position, index) => {
            const percent = trimNumber((index / count) * 100)
            return `  ${percent}% { background-position: ${position.x}px ${position.y}px; }`
          })
          .join('\n')

  const keyframeFrames = positions
    .map((position, index) => {
      const start = trimNumber((index / count) * 100)
      const end =
        index === count - 1
          ? '100'
          : trimNumber(((index + 1) / count) * 100 - 0.0001)
      return `  ${start}%, ${end}% { background-position: ${position.x}px ${position.y}px; }`
    })
    .join('\n')

  const comment = `/* ${count} frames · native cell ${metrics.cellW}×${metrics.cellH} · sheet ${metrics.width}×${metrics.height} · ${metrics.cols}×${metrics.rows} · ${fps} fps · scale ${scale}× */`

  const spriteRule = (timing: string) => `.sprite {
  width: ${frameW}px;
  height: ${frameH}px;
  background-image: url("${SHEET_FILE}");
  background-repeat: no-repeat;
  background-size: ${sheetW}px ${sheetH}px;
  image-rendering: pixelated;
  animation: sprite-play ${duration} ${timing} infinite;
}`

  return {
    timing: stepsTiming,
    keyframes: stepsFrames,
    duration,
    stepsCode: `${comment}
/* steps() advances background-position once per frame. Save the PNG as ${SHEET_FILE}. */

${spriteRule(stepsTiming)}

@keyframes sprite-play {
${stepsFrames}
}`,
    keyframesCode: `${comment}
/* Each stop holds one cell. step-end keeps the frames from blending together. */

${spriteRule('step-end')}

@keyframes sprite-play {
${keyframeFrames}
}`,
  }
}

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function Slider({
  label,
  min,
  max,
  value,
  display,
  onChange,
}: {
  label: string
  min: number
  max: number
  value: number
  display: string
  onChange: (value: number) => void
}) {
  const id = useId()
  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-3 text-xs">
        <label htmlFor={id} className="text-zinc-400">
          {label}
        </label>
        <span className="font-mono text-sm tabular-nums text-zinc-100">{display}</span>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={1}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="w-full cursor-pointer accent-emerald-400"
      />
    </div>
  )
}

function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: T
  options: { value: T; label: string }[]
  onChange: (value: T) => void
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="flex rounded-xl border border-zinc-800 bg-zinc-950 p-1"
    >
      {options.map((option) => {
        const selected = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(option.value)}
            className={
              selected
                ? 'rounded-lg bg-zinc-800 px-3 py-1.5 text-sm font-medium text-zinc-50'
                : 'rounded-lg px-3 py-1.5 text-sm font-medium text-zinc-400 transition hover:text-zinc-200'
            }
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950/80 px-3 py-2">
      <dt className="text-[11px] tracking-wide text-zinc-500 uppercase">{label}</dt>
      <dd className="mt-1 font-mono text-sm text-zinc-100">{value}</dd>
    </div>
  )
}

function GridOverlay({ metrics }: { metrics: SheetMetrics }) {
  const vertical = Array.from(
    { length: metrics.cols + 1 },
    (_, index) => index * metrics.cellW,
  )
  const horizontal = Array.from(
    { length: metrics.rows + 1 },
    (_, index) => index * metrics.cellH,
  )

  return (
    <svg
      className="pointer-events-none absolute inset-0 h-full w-full"
      viewBox={`0 0 ${metrics.width} ${metrics.height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <g
        fill="none"
        stroke="rgba(244,244,245,0.78)"
        strokeWidth="1"
        shapeRendering="crispEdges"
        vectorEffect="non-scaling-stroke"
      >
        {vertical.map((x) => (
          <line key={`v-${x}`} x1={x} y1={0} x2={x} y2={metrics.height} />
        ))}
        {horizontal.map((y) => (
          <line key={`h-${y}`} x1={0} y1={y} x2={metrics.width} y2={y} />
        ))}
      </g>
    </svg>
  )
}

export default function App() {
  const inputId = useId()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const framesRef = useRef<SpriteFrame[]>([])
  const dragDepth = useRef(0)
  const copyTimer = useRef<number | null>(null)

  const [frames, setFrames] = useState<SpriteFrame[]>([])
  const [layout, setLayout] = useState<LayoutMode>('horizontal')
  const [columns, setColumns] = useState(4)
  const [showGrid, setShowGrid] = useState(true)
  const [fps, setFps] = useState(12)
  const [scale, setScale] = useState(3)
  const [playing, setPlaying] = useState(() => !prefersReducedMotion())
  const [exportTab, setExportTab] = useState<SnippetTab>('steps')
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fileHover, setFileHover] = useState(false)
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [overIndex, setOverIndex] = useState<number | null>(null)

  useEffect(() => {
    framesRef.current = frames
  }, [frames])

  const packed = useMemo(
    () => packFrames(frames, layout, columns),
    [frames, layout, columns],
  )
  const animation = useMemo(
    () => (packed ? buildAnimation(packed, scale, fps) : null),
    [packed, scale, fps],
  )

  const columnCount = Math.max(1, Math.min(columns, Math.max(frames.length, 1)))
  const mixedSizes =
    frames.length > 1 &&
    frames.some(
      (frame) => frame.width !== frames[0].width || frame.height !== frames[0].height,
    )
  const exportCode =
    exportTab === 'steps' ? animation?.stepsCode ?? '' : animation?.keyframesCode ?? ''
  const zoom = packed ? previewZoom(packed.metrics) : 1

  useEffect(() => {
    return () => {
      framesRef.current.forEach(releaseFrame)
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current)
    }
  }, [])

  useLayoutEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !packed) return
    canvas.width = packed.metrics.width
    canvas.height = packed.metrics.height
    const context = canvas.getContext('2d')
    if (!context) return
    context.imageSmoothingEnabled = false
    context.drawImage(packed.canvas, 0, 0)
  }, [packed])

  async function addFiles(list: FileList | File[]) {
    const files = [...list]
    if (files.length === 0) return

    const accepted: File[] = []
    let rejected = 0
    for (const file of files) {
      if (isFrameFile(file)) accepted.push(file)
      else rejected += 1
    }

    const loaded = await Promise.all(accepted.map(loadFrame))
    const next = loaded.filter((frame): frame is SpriteFrame => frame !== null)
    const failed = accepted.length - next.length

    if (rejected > 0 || failed > 0) {
      const reasons = [
        rejected > 0 ? `${rejected} not PNG or WEBP` : null,
        failed > 0 ? `${failed} unreadable` : null,
      ].filter(Boolean)
      setError(`Skipped ${reasons.join(', ')}.`)
    } else {
      setError(null)
    }

    if (next.length > 0) setFrames((current) => [...current, ...next])
  }

  function onPick(event: ChangeEvent<HTMLInputElement>) {
    if (event.target.files) void addFiles(event.target.files)
    event.target.value = ''
  }

  function removeFrame(id: string) {
    setFrames((current) => {
      const target = current.find((frame) => frame.id === id)
      if (target) releaseFrame(target)
      return current.filter((frame) => frame.id !== id)
    })
  }

  function clearFrames() {
    setFrames((current) => {
      current.forEach(releaseFrame)
      return []
    })
    setError(null)
  }

  function moveFrame(from: number, to: number) {
    setFrames((current) => {
      if (from < 0 || to < 0 || from >= current.length || to >= current.length || from === to) {
        return current
      }
      const next = [...current]
      const [item] = next.splice(from, 1)
      next.splice(to, 0, item)
      return next
    })
  }

  function onDragEnter(event: DragEvent<HTMLDivElement>) {
    if (!hasFiles(event)) return
    dragDepth.current += 1
    setFileHover(true)
  }

  function onDragOver(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    if (hasFiles(event)) event.dataTransfer.dropEffect = 'copy'
  }

  function onDragLeave(event: DragEvent<HTMLDivElement>) {
    if (!hasFiles(event)) return
    dragDepth.current -= 1
    if (dragDepth.current <= 0) {
      dragDepth.current = 0
      setFileHover(false)
    }
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    if (!hasFiles(event)) return
    event.preventDefault()
    dragDepth.current = 0
    setFileHover(false)
    void addFiles(event.dataTransfer.files)
  }

  function onFrameDragStart(index: number, event: DragEvent<HTMLLIElement>) {
    const target = event.target
    if (target instanceof HTMLElement && target.closest('[data-no-drag]')) {
      event.preventDefault()
      return
    }
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', String(index))
    setDragIndex(index)
  }

  function onFrameDragOver(index: number, event: DragEvent<HTMLLIElement>) {
    if (hasFiles(event)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    setOverIndex(index)
  }

  function onFrameDrop(index: number, event: DragEvent<HTMLLIElement>) {
    if (hasFiles(event)) return
    event.preventDefault()
    const from = dragIndex
    if (from !== null) moveFrame(from, index)
    setDragIndex(null)
    setOverIndex(null)
  }

  function onFrameDragEnd() {
    setDragIndex(null)
    setOverIndex(null)
  }

  function downloadSheet() {
    const canvas = canvasRef.current
    if (!canvas || !packed) return
    canvas.toBlob((blob) => {
      if (!blob) return
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = SHEET_FILE
      document.body.appendChild(link)
      link.click()
      link.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    })
  }

  function copySnippet() {
    if (!exportCode) return
    void navigator.clipboard.writeText(exportCode).then(
      () => {
        setCopied(true)
        if (copyTimer.current !== null) window.clearTimeout(copyTimer.current)
        copyTimer.current = window.setTimeout(() => {
          setCopied(false)
          copyTimer.current = null
        }, 1600)
      },
      () => setError('Could not copy to the clipboard.'),
    )
  }

  const playerKey = `${frames.map((frame) => frame.id).join('.')}|${layout}|${columnCount}|${scale}`

  return (
    <div
      className="min-h-screen text-zinc-100 selection:bg-emerald-400/30"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="mx-auto flex min-h-screen w-full max-w-6xl flex-col px-4 py-6 sm:px-6 lg:px-8">
        <header className="mb-6 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex size-11 items-center justify-center rounded-2xl border border-emerald-400/20 bg-emerald-400/10 text-emerald-400">
              <Layers className="size-5" aria-hidden="true" />
            </div>
            <div>
              <h1 className="text-xl font-semibold tracking-tight text-zinc-50">
                Sprite Sheet Packer
              </h1>
              <p className="text-sm text-zinc-400">
                Stitch frames, preview the loop, and export PNG plus CSS.
              </p>
            </div>
          </div>
          <p className="font-mono text-xs text-zinc-500">
            {packed
              ? `${packed.metrics.width}×${packed.metrics.height} · ${formatBytes(packed.bytes)}`
              : 'No sheet yet'}
          </p>
        </header>

        <div className="grid flex-1 items-start gap-4 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
          <aside className="rounded-2xl border border-zinc-800 bg-zinc-900/80 p-4 shadow-xl shadow-black/20 lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:overflow-y-auto">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h2 className="text-sm font-semibold text-zinc-100">Frames</h2>
              <div className="flex items-center gap-2">
                <span className="rounded-full border border-zinc-800 bg-zinc-950 px-2 py-0.5 font-mono text-[11px] text-zinc-400">
                  {frames.length}
                </span>
                {frames.length > 0 && (
                  <button
                    type="button"
                    onClick={clearFrames}
                    className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-zinc-400 transition hover:bg-red-500/10 hover:text-red-300"
                  >
                    <Trash2 className="size-3.5" aria-hidden="true" />
                    Clear
                  </button>
                )}
              </div>
            </div>

            <label
              htmlFor={inputId}
              className={
                fileHover
                  ? 'mb-3 flex cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed border-emerald-400/70 bg-emerald-400/5 px-4 py-6 text-center transition'
                  : 'mb-3 flex cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed border-zinc-700 bg-zinc-950/50 px-4 py-6 text-center transition hover:border-zinc-500 hover:bg-zinc-950'
              }
            >
              <input
                id={inputId}
                type="file"
                accept="image/png,image/webp,.png,.webp"
                multiple
                className="sr-only"
                onChange={onPick}
              />
              <Layers className="mb-2 size-5 text-emerald-400" aria-hidden="true" />
              <span className="text-sm font-medium text-zinc-100">
                Drop PNG or WEBP frames
              </span>
              <span className="mt-1 text-xs text-zinc-500">or click to browse</span>
            </label>

            {error && (
              <p
                role="alert"
                className="mb-3 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200"
              >
                {error}
              </p>
            )}

            {frames.length === 0 ? (
              <p className="px-1 text-sm text-zinc-500">
                Upload the frames in playback order. Drag them later to restack the sheet.
              </p>
            ) : (
              <>
                <ul
                  aria-label="Animation frames"
                  className="sprite-scroll max-h-80 space-y-1.5 overflow-y-auto pr-1 lg:max-h-[calc(100vh-22rem)]"
                >
                  {frames.map((frame, index) => {
                    const activeDrop = overIndex === index && dragIndex !== null && dragIndex !== index
                    return (
                      <li
                        key={frame.id}
                        draggable
                        tabIndex={0}
                        aria-label={`${index + 1}. ${frame.name}`}
                        title="Drag to reorder"
                        onDragStart={(event) => onFrameDragStart(index, event)}
                        onDragOver={(event) => onFrameDragOver(index, event)}
                        onDrop={(event) => onFrameDrop(index, event)}
                        onDragEnd={onFrameDragEnd}
                        onKeyDown={(event) => {
                          if (!event.altKey && !event.metaKey) return
                          if (event.key === 'ArrowUp') {
                            event.preventDefault()
                            moveFrame(index, index - 1)
                          } else if (event.key === 'ArrowDown') {
                            event.preventDefault()
                            moveFrame(index, index + 1)
                          }
                        }}
                        className={
                          activeDrop
                            ? 'flex cursor-grab items-center gap-2.5 rounded-xl border border-emerald-400/70 bg-emerald-400/5 p-2 outline-none active:cursor-grabbing focus-visible:ring-2 focus-visible:ring-emerald-400/70'
                            : 'flex cursor-grab items-center gap-2.5 rounded-xl border border-zinc-800 bg-zinc-950/70 p-2 outline-none active:cursor-grabbing focus-visible:ring-2 focus-visible:ring-emerald-400/70'
                        }
                        style={{ opacity: dragIndex === index ? 0.45 : 1 }}
                      >
                        <span className="w-4 text-center font-mono text-[10px] text-zinc-500" aria-hidden="true">
                          {index + 1}
                        </span>
                        <span className="checker size-12 shrink-0 overflow-hidden rounded-lg border border-zinc-800">
                          <img
                            src={frame.url}
                            alt=""
                            draggable={false}
                            className="size-full object-contain"
                            style={{ imageRendering: 'pixelated' }}
                          />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm text-zinc-100" title={frame.name}>
                            {frame.name}
                          </span>
                          <span className="font-mono text-[11px] text-zinc-500">
                            {frame.width}×{frame.height}
                          </span>
                        </span>
                        <button
                          type="button"
                          data-no-drag
                          aria-label={`Remove ${frame.name}`}
                          onClick={() => removeFrame(frame.id)}
                          className="rounded-lg p-2 text-zinc-500 transition hover:bg-red-500/10 hover:text-red-300"
                        >
                          <Trash2 className="size-4" aria-hidden="true" />
                        </button>
                      </li>
                    )
                  })}
                </ul>
                <p className="mt-3 text-[11px] text-zinc-500">
                  Drag to reorder. Alt and the arrow keys move a focused frame.
                </p>
              </>
            )}
          </aside>

          <main className="flex min-w-0 flex-col gap-4">
            <section className="rounded-2xl border border-zinc-800 bg-zinc-900/80 p-4 shadow-xl shadow-black/20 sm:p-5">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-sm font-semibold text-zinc-100">Sprite sheet</h2>
                <div className="flex flex-wrap items-center gap-2">
                  <Segmented
                    label="Sheet layout"
                    value={layout}
                    onChange={setLayout}
                    options={[
                      { value: 'horizontal', label: 'Horizontal' },
                      { value: 'grid', label: 'Grid' },
                    ]}
                  />
                  <button
                    type="button"
                    aria-pressed={showGrid}
                    onClick={() => setShowGrid((current) => !current)}
                    className={
                      showGrid
                        ? 'rounded-xl border border-emerald-400/40 bg-emerald-400/10 px-3 py-1.5 text-sm font-medium text-emerald-300'
                        : 'rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-sm font-medium text-zinc-400 hover:text-zinc-200'
                    }
                  >
                    Grid
                  </button>
                </div>
              </div>

              {layout === 'grid' && frames.length > 0 && (
                <div className="mb-4 max-w-sm">
                  <Slider
                    label="Columns"
                    min={1}
                    max={frames.length}
                    value={columnCount}
                    display={String(columnCount)}
                    onChange={setColumns}
                  />
                </div>
              )}

              <div className="checker max-h-[440px] min-h-56 overflow-auto rounded-xl border border-zinc-800 p-3">
                {packed ? (
                  <div
                    className="relative"
                    style={{ width: '100%', maxWidth: packed.metrics.width * zoom }}
                  >
                    <canvas
                      ref={canvasRef}
                      width={packed.metrics.width}
                      height={packed.metrics.height}
                      role="img"
                      aria-label="Packed sprite sheet preview"
                      className="block h-auto w-full"
                      style={{ imageRendering: 'pixelated' }}
                    />
                    {showGrid && <GridOverlay metrics={packed.metrics} />}
                  </div>
                ) : (
                  <div className="flex min-h-52 flex-col items-center justify-center gap-2 text-center">
                    <Layers className="size-6 text-zinc-600" aria-hidden="true" />
                    <p className="text-sm text-zinc-500">
                      {frames.length > 0
                        ? 'This sheet is too large to preview.'
                        : 'The packed PNG will show up here.'}
                    </p>
                  </div>
                )}
              </div>

              {packed && (
                <dl className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <Stat label="Frames" value={String(packed.count)} />
                  <Stat
                    label="Cell"
                    value={`${packed.metrics.cellW}×${packed.metrics.cellH}`}
                  />
                  <Stat
                    label="Sheet"
                    value={`${packed.metrics.width}×${packed.metrics.height}`}
                  />
                  <Stat
                    label="Grid"
                    value={`${packed.metrics.cols}×${packed.metrics.rows}`}
                  />
                </dl>
              )}
              {mixedSizes && packed && (
                <p className="mt-3 text-xs text-amber-200/90">
                  Mixed frame sizes are centered in a {packed.metrics.cellW}×
                  {packed.metrics.cellH} cell.
                </p>
              )}
            </section>

            <section className="rounded-2xl border border-zinc-800 bg-zinc-900/80 p-4 shadow-xl shadow-black/20 sm:p-5">
              <div className="mb-4 flex items-center gap-2">
                <Sliders className="size-4 text-emerald-400" aria-hidden="true" />
                <h2 className="text-sm font-semibold text-zinc-100">Playback</h2>
                <span className="text-xs text-zinc-500">background-position steps</span>
              </div>

              {animation && (
                <style>{`@keyframes sprite-pack-play {\n${animation.keyframes}\n}`}</style>
              )}

              <div className="checker h-72 overflow-auto rounded-xl border border-zinc-800">
                <div className="flex min-h-full w-max min-w-full items-center justify-center p-6">
                  {packed && animation ? (
                    <div
                      key={playerKey}
                      role="img"
                      aria-label="Sprite animation preview"
                      className="shadow-[0_0_0_1px_rgba(255,255,255,0.18)]"
                      style={{
                        width: packed.metrics.cellW * scale,
                        height: packed.metrics.cellH * scale,
                        backgroundImage: `url("${packed.url}")`,
                        backgroundRepeat: 'no-repeat',
                        backgroundSize: `${packed.metrics.width * scale}px ${packed.metrics.height * scale}px`,
                        imageRendering: 'pixelated',
                        animationName: 'sprite-pack-play',
                        animationDuration: animation.duration,
                        animationTimingFunction: animation.timing,
                        animationIterationCount: 'infinite',
                        animationPlayState: playing ? 'running' : 'paused',
                      }}
                    />
                  ) : (
                    <p className="text-sm text-zinc-500">Upload frames to play the loop.</p>
                  )}
                </div>
              </div>

              <div className="mt-4 flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  aria-pressed={playing}
                  disabled={!packed}
                  onClick={() => setPlaying((current) => !current)}
                  className="inline-flex size-11 items-center justify-center rounded-full bg-emerald-400 text-zinc-950 transition hover:bg-emerald-300 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {playing ? (
                    <Pause className="size-5" aria-hidden="true" />
                  ) : (
                    <Play className="ml-0.5 size-5" aria-hidden="true" />
                  )}
                  <span className="sr-only">{playing ? 'Pause animation' : 'Play animation'}</span>
                </button>
                <p className="font-mono text-xs text-zinc-400">
                  {animation
                    ? `${animation.timing} · ${fps} fps · ${animation.duration}`
                    : 'Waiting for frames'}
                </p>
              </div>

              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <Slider
                  label="FPS"
                  min={1}
                  max={60}
                  value={fps}
                  display={`${fps} fps`}
                  onChange={setFps}
                />
                <Slider
                  label="Frame scale"
                  min={1}
                  max={8}
                  value={scale}
                  display={`${scale}×`}
                  onChange={setScale}
                />
              </div>
            </section>

            <section className="rounded-2xl border border-zinc-800 bg-zinc-900/80 p-4 shadow-xl shadow-black/20 sm:p-5">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-sm font-semibold text-zinc-100">Export</h2>
                <button
                  type="button"
                  onClick={downloadSheet}
                  disabled={!packed}
                  className="inline-flex items-center gap-2 rounded-xl bg-emerald-400 px-3.5 py-2 text-sm font-semibold text-zinc-950 transition hover:bg-emerald-300 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Download className="size-4" aria-hidden="true" />
                  Download PNG
                </button>
              </div>

              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <Segmented
                  label="CSS snippet"
                  value={exportTab}
                  onChange={(tab) => {
                    setExportTab(tab)
                    setCopied(false)
                  }}
                  options={[
                    { value: 'steps', label: 'steps()' },
                    { value: 'keyframes', label: '@keyframes' },
                  ]}
                />
                <button
                  type="button"
                  onClick={copySnippet}
                  disabled={!exportCode}
                  className="inline-flex items-center gap-2 rounded-xl border border-zinc-700 bg-zinc-950 px-3.5 py-2 text-sm font-medium text-zinc-100 transition hover:border-zinc-500 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {copied ? (
                    <Check className="size-4 text-emerald-400" aria-hidden="true" />
                  ) : (
                    <Copy className="size-4" aria-hidden="true" />
                  )}
                  {copied ? 'Copied' : 'Copy CSS'}
                </button>
              </div>

              <pre
                tabIndex={0}
                spellCheck={false}
                aria-label="Generated CSS"
                className="sprite-scroll max-h-72 overflow-auto rounded-xl border border-zinc-800 bg-zinc-950 p-4 font-mono text-[12.5px] leading-relaxed text-zinc-300"
              >
                {exportCode || 'Upload frames to generate the CSS animation.'}
              </pre>
              <p className="mt-3 text-xs text-zinc-500">
                The snippet uses the current FPS and frame scale.
                {packed ? ` PNG is about ${formatBytes(packed.bytes)}.` : ''}
              </p>
            </section>
          </main>
        </div>
      </div>
    </div>
  )
}
