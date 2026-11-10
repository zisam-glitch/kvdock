"use client"

// Ink Orbit Features — KVDock Concurrency & Architecture Bento
// Adapted from ink-orbit-saas-template for KVDock with the Cobalt preset palette.
// Features a hatched page background, corner bracket frames, live SVG flow diagrams,
// adapter sync hub, and scrubbable latency benchmark chart.

import React from "react"

export type InkFeatureCopy = { title: string; description: string }
export type InkFeatures = {
  tag: string
  /** `*word*` sets a word in the muted tone; `\n` breaks the line. */
  title: string
  collaboration: InkFeatureCopy
  reports: InkFeatureCopy
  integrations: InkFeatureCopy & { tools: string[] }
  insights: InkFeatureCopy & { values: number[]; forecastFrom: number }
}

export type InkOrbitFeaturesProps = {
  theme?: "light" | "dark" | "cobalt"
  brand?: string
  tag?: string
  title?: string
  collaboration?: { [K in keyof InkFeatureCopy]?: InkFeatureCopy[K] }
  reports?: { [K in keyof InkFeatureCopy]?: InkFeatureCopy[K] }
  integrations?: { [K in keyof InkFeatures["integrations"]]?: InkFeatures["integrations"][K] }
  insights?: { [K in keyof InkFeatures["insights"]]?: InkFeatures["insights"][K] }
  className?: string
  style?: React.CSSProperties
}

function clamp(v: number, a: number, b: number): number {
  return Math.min(b, Math.max(a, v))
}

function chartPaths(values: number[], w: number, h: number, pad: number) {
  const n = values.length
  const lo = Math.min(...values)
  const hi = Math.max(...values)
  const span = hi - lo || 1
  const pts = values.map((v, i) => [
    pad + (n < 2 ? 0 : (i / (n - 1)) * (w - pad * 2)),
    h - pad - ((v - lo) / span) * (h - pad * 2),
  ] as [number, number])
  let line = ""
  pts.forEach(([x, y], i) => {
    if (i === 0) {
      line = "M" + x.toFixed(1) + "," + y.toFixed(1)
      return
    }
    const [px, py] = pts[i - 1]
    const cx = (px + x) / 2
    line += " C" + cx.toFixed(1) + "," + py.toFixed(1) + " " + cx.toFixed(1) + "," + y.toFixed(1) + " " + x.toFixed(1) + "," + y.toFixed(1)
  })
  const area = n ? line + " L" + pts[n - 1][0].toFixed(1) + "," + (h - pad) + " L" + pts[0][0].toFixed(1) + "," + (h - pad) + " Z" : ""
  return { line, area, points: pts }
}

function nearestIndex(xs: number[], x: number): number {
  let best = 0
  for (let i = 1; i < xs.length; i++) if (Math.abs(xs[i] - x) < Math.abs(xs[best] - x)) best = i
  return best
}

function parseTitle(s: string): { text: string; muted: boolean }[][] {
  return s.split(/\n|\\n/).map((line) => {
    const out: { text: string; muted: boolean }[] = []
    line.split("*").forEach((text, i) => {
      if (text) out.push({ text, muted: i % 2 === 1 })
    })
    return out
  })
}

const D_FEATURES: InkFeatures = {
  tag: "Architecture · Concurrency Engine",
  title: "Zero-Contention *Single-Flight*\nRuntime",
  collaboration: {
    title: "Lockless Request Coalescing",
    description: "Concurrent cache misses collapse into a single upstream fetch, shielding your databases from thundering herds.",
  },
  reports: {
    title: "Continuous Cache Stream",
    description: "Cached responses stream back to thousands of awaiting clients in parallel with zero lock contention.",
  },
  integrations: {
    title: "Storage Adapters Hub",
    description: "Plug-and-play zero-dependency adapters for Redis, Cloudflare KV, SQLite, Memory, and D1 across any runtime.",
    tools: ["Redis", "Cloudflare KV", "SQLite / D1", "Memory LRU"],
  },
  insights: {
    title: "Concurrency Benchmarks",
    description: "Eliminate connection pool exhaustion while sustaining sub-millisecond p99 latencies under extreme traffic spikes.",
    values: [22, 28, 26, 35, 32, 45, 42, 58, 65, 82, 94, 99.9],
    forecastFrom: 8,
  },
}

export default function InkOrbitFeatures({
  theme = "cobalt",
  brand = "KVDock Engine",
  tag = D_FEATURES.tag,
  title = D_FEATURES.title,
  collaboration,
  reports,
  integrations,
  insights,
  className = "",
  style,
}: InkOrbitFeaturesProps) {
  const uid = "ib" + React.useId().replace(/[^a-zA-Z0-9]/g, "")
  const F: InkFeatures = {
    tag,
    title,
    collaboration: { ...D_FEATURES.collaboration, ...collaboration },
    reports: { ...D_FEATURES.reports, ...reports },
    integrations: { ...D_FEATURES.integrations, ...integrations },
    insights: { ...D_FEATURES.insights, ...insights },
  }

  const [featRef, featIn] = useInView(0.12)

  return (
    <div className={"ib-root " + className} data-theme={theme} style={style}>
      <div className="ib-shell">
        <section className="ib-sec" aria-labelledby={uid + "feat"}>
          <div className="ib-reveal" ref={featRef as never} data-in={featIn}>
            <div className="ib-head" id={uid + "feat"}>
              {F.tag && <span className="ib-tag">{F.tag}</span>}
              <Title text={F.title} />
            </div>
            <div className="ib-bento">
              <FlowCard brand={brand} features={F} uid={uid} inView={featIn} />
              <IntegrationsCard copy={F.integrations} />
              <InsightsCard copy={F.insights} uid={uid} />
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}

function useInView(threshold = 0.2) {
  const ref = React.useRef(null as HTMLElement | null)
  const [inView, setInView] = React.useState(false)
  React.useEffect(() => {
    const el = ref.current
    if (!el || inView) return
    if (typeof IntersectionObserver !== "function") {
      setInView(true)
      return
    }
    const io = new IntersectionObserver(
      (es) => {
        if (es.some((e) => e.isIntersecting)) {
          setInView(true)
          io.disconnect()
        }
      },
      { threshold },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [inView, threshold])
  return [ref, inView] as const
}

function Brackets() {
  return (
    <>
      <span className="ib-c ib-c-tl" aria-hidden="true" />
      <span className="ib-c ib-c-tr" aria-hidden="true" />
      <span className="ib-c ib-c-bl" aria-hidden="true" />
      <span className="ib-c ib-c-br" aria-hidden="true" />
    </>
  )
}

function Title({ text, className = "ib-h2", as = "h2" }: { text: string; className?: string; as?: "h2" | "h3" }) {
  const Tag = as
  return (
    <Tag className={className}>
      {parseTitle(text).map((line, i) => (
        <span key={i}>
          {line.map((run, j) => (
            <React.Fragment key={j}>
              {run.muted ? <span className="ib-muted" style={{ display: "inline" }}>{run.text}</span> : run.text}
            </React.Fragment>
          ))}
        </span>
      ))}
    </Tag>
  )
}

function Mark({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 4v16" />
      <path d="M4 12h7l7-8" />
      <path d="M11 12l7 8" />
    </svg>
  )
}

function ToolGlyph({ index }: { index: number }) {
  const k = index % 4
  return (
    <g fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      {k === 0 && (
        <>
          <ellipse cx="0" cy="-4" rx="6" ry="2.5" />
          <path d="M-6 -4v8c0 1.4 2.7 2.5 6 2.5s6 -1.1 6 -2.5v-8" />
          <path d="M-6 0c0 1.4 2.7 2.5 6 2.5s6 -1.1 6 -2.5" />
        </>
      )}
      {k === 1 && (
        <path d="M-5 4a3.5 3.5 0 0 1 0 -7 4.5 4.5 0 0 1 8.5 -1.5 3.5 3.5 0 0 1 3.5 3.5 3.5 3.5 0 0 1 -3.5 5z" />
      )}
      {k === 2 && (
        <>
          <rect x="-6" y="-6" width="12" height="12" rx="2" />
          <path d="M-6 0h12M0 -6v12" />
        </>
      )}
      {k === 3 && (
        <path d="M-1 -6L-6 1h6l-1 5 6 -7h-6z" />
      )}
    </g>
  )
}

function FlowCard({ brand, features, uid, inView }: { brand: string; features: InkFeatures; uid: string; inView: boolean }) {
  const [reports, setReports] = React.useState(128)
  const [side, setSide] = React.useState("" as "" | "left" | "right")
  React.useEffect(() => {
    if (!inView) return
    const t = setInterval(() => setReports((n) => n + 1), 2800)
    return () => clearInterval(t)
  }, [inView])
  const team = [
    { x: 58, y: 38, name: "client-1 · product:catalog" },
    { x: 104, y: 22, name: "client-2 · coalescing" },
    { x: 150, y: 40, name: "client-3 · in-flight wait" },
    { x: 46, y: 92, name: "client-4 · listening" },
    { x: 146, y: 114, name: "client-5 · awaiting response" },
  ]
  const L1 = "M117,67 C196,67 210,100 262,100"
  const L2 = "M117,73 C186,73 206,120 262,120"
  const R1 = "M378,100 C412,100 418,86 450,86"
  const R2 = "M378,120 C412,120 418,134 450,134"
  const chip = "KVDOCK"
  const glow = uid + "glow"
  return (
    <div className="ib-frame ib-frame-hover ib-wide">
      <Brackets />
      <div className="ib-card" style={{ padding: 0, overflow: "hidden" }}>
        <svg className="ib-diagram" viewBox="0 0 640 178" role="img" aria-label="Incoming requests flow through KVDock into finished cached responses">
          <defs>
            <radialGradient id={glow} cx="320" cy="110" r="190" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="var(--ib-raise)" stopOpacity="1" />
              <stop offset="1" stopColor="var(--ib-raise)" stopOpacity="0" />
            </radialGradient>
          </defs>
          <rect x="0" y="0" width="640" height="178" fill={"url(#" + glow + ")"} />

          {/* client cluster */}
          <g onMouseEnter={() => setSide("left")} onMouseLeave={() => setSide("")}>
            <rect x="20" y="8" width="170" height="130" fill="transparent" />
            {team.map((m, i) => (
              <line key={"l" + i} x1={m.x} y1={m.y} x2="104" y2="70" stroke="var(--ib-line-strong)" strokeDasharray="2 3" />
            ))}
            <g transform="translate(91,57)">
              <rect width="26" height="26" rx="5" className="ib-node" />
              <g transform="translate(5,5)" style={{ color: "var(--ib-gold)" }}>
                <Mark size={16} />
              </g>
            </g>
            {team.map((m, i) => (
              <g key={i} className="ib-av" tabIndex={0} role="img" aria-label={m.name}>
                <circle cx={m.x} cy={m.y} r="10" fill="var(--ib-raise)" stroke="var(--ib-line-strong)" strokeWidth="1.2" />
                <circle cx={m.x} cy={m.y} r="4" fill="var(--ib-gold)" />
                <circle cx={m.x + 8} cy={m.y + 8} r="2.6" fill="#22c55e" stroke="var(--ib-paper)" className="ib-presence" />
                <g className="ib-av-tip" transform={"translate(" + m.x + "," + (m.y - 18) + ")"}>
                  <rect x={-m.name.length * 2.5 - 6} y="-9" width={m.name.length * 5 + 12} height="14" rx="2" fill="var(--ib-inv)" />
                  <text x="0" y="1" textAnchor="middle" fontSize="7.5" fill="var(--ib-inv-ink)" fontFamily="var(--ib-sans)">
                    {m.name}
                  </text>
                </g>
              </g>
            ))}
          </g>

          {/* connectors */}
          {[L1, L2].map((d, i) => (
            <path key={d} d={d} className={"ib-flow" + (side === "left" ? " ib-flow-on" : "") + (i ? " ib-dash" : "")} />
          ))}
          {[R1, R2].map((d, i) => (
            <path key={d} d={d} className={"ib-flow" + (side === "right" ? " ib-flow-on" : "") + (i ? " ib-dash" : "")} />
          ))}
          {[L1, L2, R1, R2].map((d, i) => (
            <circle key={"p" + i} r="2.4" className="ib-pkt">
              <animateMotion dur={2.2 + (i % 2) * 0.6 + "s"} begin={i * 0.35 + "s"} repeatCount="indefinite" path={d} />
            </circle>
          ))}

          {/* the hub chip */}
          <g transform="translate(262,88)">
            <rect x="-4" y="-4" width="124" height="52" rx="8" fill="none" stroke="var(--ib-gold)" opacity="0.3" className="ib-glow" />
            <rect width="116" height="44" rx="6" className="ib-node" style={{ filter: "drop-shadow(0 6px 12px rgba(0,0,0,.3))" }} />
            <g transform="translate(13,14)" style={{ color: "var(--ib-gold)" }}>
              <Mark size={16} />
            </g>
            <text x="36" y="26" fontSize="8.5" letterSpacing="1.4" fontWeight="700" fill="var(--ib-gold)" fontFamily="var(--ib-mono)">
              {chip}
            </text>
            <path d="M100 18l4 4-4 4" fill="none" stroke="var(--ib-muted)" strokeWidth="1.3" />
          </g>

          {/* the cached response stack */}
          <g onMouseEnter={() => setSide("right")} onMouseLeave={() => setSide("")}>
            {[2, 1, 0].map((k) => (
              <g key={reports - k} transform={"translate(" + (450 + k * 12) + "," + (40 - k * 10) + ")"} opacity={1 - k * 0.25}>
                <g className={"ib-sheet" + (k === 0 ? " ib-sheet-new" : "")}>
                  <rect width="138" height="102" rx="3" fill="var(--ib-raise)" stroke="var(--ib-line-strong)" />
                  {k === 0 && (
                    <>
                      <text x="10" y="16" fontSize="7" fill="var(--ib-gold)" fontFamily="var(--ib-mono)">
                        {"STREAM BATCH #" + reports}
                      </text>
                      <rect x="10" y="24" width="64" height="5" rx="1" fill="var(--ib-ink)" opacity=".8" />
                      <rect x="10" y="33" width="92" height="3" rx="1" fill="var(--ib-line-strong)" />
                      <rect x="10" y="39" width="80" height="3" rx="1" fill="var(--ib-line-strong)" />
                      {[18, 26, 14, 30, 22, 34].map((h, j) => (
                        <rect key={j} x={12 + j * 13} y={92 - h} width="8" height={h} fill="var(--ib-gold)" opacity={0.35 + j * 0.12} />
                      ))}
                      <path d="M92 64h34M92 72h28M92 80h32" stroke="var(--ib-line-strong)" strokeWidth="2.5" />
                    </>
                  )}
                </g>
              </g>
            ))}
          </g>
        </svg>
        <div className="ib-wide-copy" style={{ padding: "0 22px 20px" }}>
          <div>
            <h3>{features.collaboration.title}</h3>
            <p>{features.collaboration.description}</p>
          </div>
          <div>
            <h3>{features.reports.title}</h3>
            <p>{features.reports.description}</p>
          </div>
        </div>
      </div>
    </div>
  )
}

function IntegrationsCard({ copy }: { copy: InkFeatures["integrations"] }) {
  const [hover, setHover] = React.useState(-1)
  const [auto, setAuto] = React.useState(0)
  React.useEffect(() => {
    if (hover >= 0) return
    const t = setInterval(() => setAuto((a) => (a + 1) % 4), 1700)
    return () => clearInterval(t)
  }, [hover])
  const on = hover >= 0 ? hover : auto
  const tiles = [
    { x: 66, y: 34 },
    { x: 66, y: 116 },
    { x: 234, y: 34 },
    { x: 234, y: 116 },
  ]
  const path = (i: number) => {
    const t = tiles[i]
    const dir = t.x < 150 ? -1 : 1
    return "M" + (150 + dir * 17) + ",75 H" + (150 + dir * 42) + " V" + t.y + " H" + (t.x - dir * 15)
  }
  return (
    <div className="ib-frame ib-frame-hover">
      <Brackets />
      <div className="ib-card">
        <svg className="ib-diagram" viewBox="0 0 300 150" role="group" aria-label="Integrations">
          {tiles.map((_, i) => (
            <path key={i} d={path(i)} className={"ib-flow" + (on === i ? " ib-flow-on" : "")} />
          ))}
          {on >= 0 && (
            <circle key={on} r="2.2" className="ib-pkt">
              <animateMotion dur="1.1s" repeatCount="indefinite" path={path(on)} />
            </circle>
          )}
          <g transform="translate(133,58)">
            <rect width="34" height="34" rx="7" className="ib-node" style={{ filter: "drop-shadow(0 4px 8px rgba(0,0,0,.2))" }} />
            <g transform="translate(8,8)" style={{ color: "var(--ib-gold)" }}>
              <Mark size={18} />
            </g>
          </g>
          {tiles.map((t, i) => (
            <g
              key={i}
              className={"ib-tool" + (on === i ? " ib-tool-on" : "")}
              tabIndex={0}
              role="img"
              aria-label={copy.tools[i] ?? "Adapter"}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(-1)}
              onFocus={() => setHover(i)}
              onBlur={() => setHover(-1)}
            >
              <rect x={t.x - 15} y={t.y - 15} width="30" height="30" rx="6" className="ib-node" />
              <g transform={"translate(" + t.x + "," + t.y + ")"} style={{ color: on === i ? "var(--ib-gold)" : "var(--ib-ink)" }}>
                <ToolGlyph index={i} />
              </g>
              <text x={t.x} y={t.y + (t.y < 75 ? -21 : 28)} textAnchor="middle" fontSize="8" fill="var(--ib-gold)" fontFamily="var(--ib-sans)" opacity={on === i ? 1 : 0} style={{ transition: "opacity .25s" }}>
                {copy.tools[i] ?? ""}
              </text>
            </g>
          ))}
          <text x="150" y="112" textAnchor="middle" fontSize="7" fill="var(--ib-faint)" fontFamily="var(--ib-mono)">
            {on >= 0 ? "active adapter · " + (copy.tools[on] ?? "").toLowerCase() : "4 native adapters"}
          </text>
        </svg>
        <div style={{ marginTop: "auto" }}>
          <h3>{copy.title}</h3>
          <p>{copy.description}</p>
        </div>
      </div>
    </div>
  )
}

function InsightsCard({ copy, uid }: { copy: InkFeatures["insights"]; uid: string }) {
  const [ref, inView] = useInView(0.3)
  const [hover, setHover] = React.useState(-1)
  const W = 300
  const H = 130
  const vals = copy.values.length > 1 ? copy.values : [1, 2]
  const { line, area, points } = chartPaths(vals, W, H, 14)
  const split = clamp(copy.forecastFrom, 1, vals.length - 1)
  const fill = uid + "area"
  const last = points[points.length - 1]
  const i = hover >= 0 ? hover : points.length - 1
  const p = points[i]
  const pct = vals[i]
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    setHover(nearestIndex(points.map((q) => q[0]), ((e.clientX - r.left) / r.width) * W))
  }
  return (
    <div className="ib-frame ib-frame-hover" ref={ref as never} data-in={inView}>
      <Brackets />
      <div className="ib-card">
        <svg className="ib-diagram ib-chart" viewBox={"0 0 " + W + " " + (H + 6)} onPointerMove={onMove} onPointerLeave={() => setHover(-1)} role="img" aria-label={copy.title + " chart"}>
          <defs>
            <linearGradient id={fill} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="var(--ib-gold)" stopOpacity=".2" />
              <stop offset="1" stopColor="var(--ib-gold)" stopOpacity="0" />
            </linearGradient>
          </defs>
          {[0.25, 0.5, 0.75].map((g) => (
            <line key={g} x1="14" x2={W - 14} y1={H * g} y2={H * g} stroke="var(--ib-line)" />
          ))}
          <path d={area} fill={"url(#" + fill + ")"} />
          <path d={line} fill="none" stroke="var(--ib-gold)" strokeWidth="1.6" pathLength={1} className="ib-line-draw" opacity=".95" />
          <line x1={points[split][0]} x2={points[split][0]} y1="10" y2={H - 14} stroke="var(--ib-line-strong)" strokeDasharray="2 3" />
          <text x={points[split][0] - 4} y={H - 18} textAnchor="end" fontSize="7" fill="var(--ib-faint)" fontFamily="var(--ib-mono)">
            STRESS TEST
          </text>
          {hover >= 0 && <line x1={p[0]} x2={p[0]} y1="8" y2={H - 14} stroke="var(--ib-gold)" strokeOpacity=".4" />}
          {hover < 0 && <circle cx={last[0]} cy={last[1]} r="7" fill="var(--ib-gold)" opacity=".18" className="ib-glow" />}
          <circle cx={p[0]} cy={p[1]} r="3.2" fill="var(--ib-raise)" stroke="var(--ib-gold)" strokeWidth="1.8" />
          <g transform={"translate(" + clamp(p[0], 40, W - 40) + "," + (p[1] < 34 ? p[1] + 22 : p[1] - 12) + ")"}>
            <rect x="-34" y="-11" width="68" height="15" rx="2" fill="var(--ib-inv)" />
            <text x="0" y="-1" textAnchor="middle" fontSize="7.5" fill="var(--ib-inv-ink)" fontFamily="var(--ib-mono)">
              {"p99 · " + pct + "% saved"}
            </text>
          </g>
        </svg>
        <div style={{ marginTop: "auto" }}>
          <h3>{copy.title}</h3>
          <p>{copy.description}</p>
        </div>
      </div>
    </div>
  )
}
