// Small dependency-free SVG charts: thin marks, rounded data-ends, hairline
// grids, hover tooltips, and text in ink colours (never in the series colour).
import { useState } from 'react';

const niceMax = (v) => {
  if (v <= 5) return 5;
  const p = 10 ** Math.floor(Math.log10(v));
  return Math.ceil(v / p) * p;
};
// Show ~7 evenly spaced date labels; the last one only if it won't collide
const showTick = (i, n) => { const step = Math.ceil(n / 7); return i % step === 0 || (i === n - 1 && (n - 1) % step >= step / 2); };
const shortDay = (d) => new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

/** Column with only the TOP corners rounded (data-end), square at the baseline */
function colPath(x, y, w, h, r = 4) {
  if (h <= 0) return '';
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h} V${y + rr} Q${x},${y} ${x + rr},${y} H${x + w - rr} Q${x + w},${y} ${x + w},${y + rr} V${y + h} Z`;
}
/** Horizontal bar rounded only at its right (data) end */
function barPath(x, y, w, h, r = 4) {
  if (w <= 0) return '';
  const rr = Math.min(r, h / 2, w);
  return `M${x},${y} H${x + w - rr} Q${x + w},${y} ${x + w},${y + rr} V${y + h - rr} Q${x + w},${y + h} ${x + w - rr},${y + h} H${x} Z`;
}

function Tooltip({ tip }) {
  if (!tip) return null;
  return (
    <div className="chart-tip" style={{ left: tip.x, top: tip.y }} role="status">
      <strong>{tip.title}</strong>
      {tip.rows.map((r) => (
        <div key={r.label} className="chart-tip-row"><i style={{ background: r.color }} />{r.label}<b>{r.value}</b></div>
      ))}
    </div>
  );
}

export function Legend({ items }) {
  return (
    <div className="legend">
      {items.map((i) => <span key={i.label}><i style={{ background: i.color }} />{i.label}</span>)}
    </div>
  );
}

// ---------------------------------------------------------------- line (single series, area wash)
export function LineChart({ data, valueKey, color = 'var(--series-1)', height = 220, label }) {
  const [hover, setHover] = useState(null);
  const W = 640, H = height, m = { t: 16, r: 36, b: 28, l: 36 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const max = niceMax(Math.max(1, ...data.map((d) => d[valueKey])));
  const x = (i) => m.l + (data.length === 1 ? iw / 2 : (i / (data.length - 1)) * iw);
  const y = (v) => m.t + ih - (v / max) * ih;
  const pts = data.map((d, i) => [x(i), y(d[valueKey])]);
  const line = pts.map(([px, py], i) => `${i ? 'L' : 'M'}${px},${py}`).join(' ');
  const area = `${line} L${x(data.length - 1)},${m.t + ih} L${x(0)},${m.t + ih} Z`;
  const ticks = [0, max / 2, max];
  const last = data[data.length - 1];

  const onMove = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    const i = Math.max(0, Math.min(data.length - 1, Math.round(((px - m.l) / iw) * (data.length - 1))));
    setHover(i);
  };
  const tip = hover === null ? null : {
    x: `${(x(hover) / W) * 100}%`, y: `${(y(data[hover][valueKey]) / H) * 100}%`,
    title: shortDay(data[hover].day), rows: [{ label, value: data[hover][valueKey], color }],
  };

  return (
    <div className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${label} over the last ${data.length} days`} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={m.l} x2={W - m.r} y1={y(t)} y2={y(t)} className="grid" />
            <text x={m.l - 8} y={y(t) + 4} className="axis" textAnchor="end">{Math.round(t)}</text>
          </g>
        ))}
        {data.map((d, i) => showTick(i, data.length) && (
          <text key={d.day} x={x(i)} y={H - 8} className="axis" textAnchor="middle">{shortDay(d.day)}</text>
        ))}
        <path d={area} fill={color} opacity="0.1" />
        <path d={line} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={m.t} y2={m.t + ih} className="crosshair" />}
        <circle cx={pts.at(-1)[0]} cy={pts.at(-1)[1]} r="4.5" fill={color} stroke="var(--surface)" strokeWidth="2" />
        {hover !== null && <circle cx={pts[hover][0]} cy={pts[hover][1]} r="4.5" fill={color} stroke="var(--surface)" strokeWidth="2" />}
        <text x={pts.at(-1)[0] + 8} y={pts.at(-1)[1] + 4} className="value-label">{last[valueKey]}</text>
      </svg>
      <Tooltip tip={tip} />
    </div>
  );
}

// ---------------------------------------------------------------- grouped columns (2 series)
export function GroupedColumns({ data, series, height = 220 }) {
  const [hover, setHover] = useState(null);
  const W = 640, H = height, m = { t: 16, r: 12, b: 28, l: 36 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const max = niceMax(Math.max(1, ...data.flatMap((d) => series.map((s) => d[s.key]))));
  const band = iw / data.length;
  const bw = Math.min(14, (band - 8) / series.length - 2);
  const y = (v) => m.t + ih - (v / max) * ih;

  const tip = hover === null ? null : {
    x: `${((m.l + band * hover + band / 2) / W) * 100}%`, y: '8%',
    title: shortDay(data[hover].day), rows: series.map((s) => ({ label: s.label, value: data[hover][s.key], color: s.color })),
  };

  return (
    <div className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={series.map((s) => s.label).join(' and ') + ' per day'} onMouseLeave={() => setHover(null)}>
        {[0, max / 2, max].map((t) => (
          <g key={t}>
            <line x1={m.l} x2={W - m.r} y1={y(t)} y2={y(t)} className="grid" />
            <text x={m.l - 8} y={y(t) + 4} className="axis" textAnchor="end">{Math.round(t)}</text>
          </g>
        ))}
        {data.map((d, i) => {
          const gx = m.l + band * i + (band - (bw + 2) * series.length + 2) / 2;
          return (
            <g key={d.day} onMouseEnter={() => setHover(i)}>
              <rect x={m.l + band * i} y={m.t} width={band} height={ih} className={hover === i ? 'hover-band' : 'hit'} />
              {series.map((s, k) => (
                <path key={s.key} d={colPath(gx + k * (bw + 2), y(d[s.key]), bw, m.t + ih - y(d[s.key]))} fill={s.color} />
              ))}
              {showTick(i, data.length) && (
                <text x={m.l + band * i + band / 2} y={H - 8} className="axis" textAnchor="middle">{shortDay(d.day)}</text>
              )}
            </g>
          );
        })}
      </svg>
      <Tooltip tip={tip} />
    </div>
  );
}

// ---------------------------------------------------------------- horizontal bars (optionally stacked)
export function HBars({ rows, segments, marker, labelWidth = 120 }) {
  const [hover, setHover] = useState(null);
  const rowH = 30, bh = 16, W = 520, H = Math.max(rowH, rows.length * rowH);
  const total = (r) => segments.reduce((s, seg) => s + (r[seg.key] || 0), 0);
  const max = niceMax(Math.max(1, ...rows.map((r) => Math.max(total(r), marker ? r[marker] || 0 : 0))));
  const iw = W - labelWidth - 44;
  const sx = (v) => (v / max) * iw;

  if (!rows.length) return <p className="muted small">No data yet.</p>;
  const tip = hover === null ? null : {
    x: `${((labelWidth + sx(total(rows[hover]))) / W) * 100}%`, y: `${((hover * rowH) / H) * 100}%`,
    title: rows[hover].name,
    rows: [...segments.map((s) => ({ label: s.label, value: rows[hover][s.key] || 0, color: s.color })),
      ...(marker && rows[hover][marker] ? [{ label: 'WIP limit', value: rows[hover][marker], color: 'var(--ink-3)' }] : [])],
  };

  return (
    <div className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Bar chart" onMouseLeave={() => setHover(null)}>
        {rows.map((r, i) => {
          let acc = 0;
          const y0 = i * rowH + (rowH - bh) / 2;
          const visibleSegs = segments.filter((s) => (r[s.key] || 0) > 0);
          return (
            <g key={r.name + i} onMouseEnter={() => setHover(i)}>
              <rect x="0" y={i * rowH} width={W} height={rowH} className={hover === i ? 'hover-band' : 'hit'} />
              <text x={labelWidth - 10} y={y0 + bh / 2 + 4} className="axis-strong" textAnchor="end">
                {r.name.length > 16 ? `${r.name.slice(0, 15)}…` : r.name}
              </text>
              {visibleSegs.map((s, k) => {
                const w = sx(r[s.key]);
                const x0 = labelWidth + sx(acc) + (k > 0 ? 2 : 0); // 2px surface gap between segments
                acc += r[s.key];
                const isEnd = k === visibleSegs.length - 1;
                return isEnd
                  ? <path key={s.key} d={barPath(x0, y0, Math.max(0, w - (k > 0 ? 2 : 0)), bh)} fill={s.color} />
                  : <rect key={s.key} x={x0} y={y0} width={Math.max(0, w - (k > 0 ? 2 : 0))} height={bh} fill={s.color} />;
              })}
              {marker && r[marker] && (
                <line x1={labelWidth + sx(r[marker])} x2={labelWidth + sx(r[marker])} y1={y0 - 4} y2={y0 + bh + 4} className="wip-marker" />
              )}
              <text x={labelWidth + sx(total(r)) + 8} y={y0 + bh / 2 + 4} className="value-label">{total(r)}</text>
            </g>
          );
        })}
      </svg>
      <Tooltip tip={tip} />
    </div>
  );
}
