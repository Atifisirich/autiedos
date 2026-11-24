'use client';
import { useMemo } from 'react';
import { qrSvgPath } from '@autoed/shared/erp-portal';

/** A QR code as inline SVG (no image request, prints sharply). `label` is read out by screen readers. */
export function QrCode({ text, label, size = 168 }: { text: string; label: string; size?: number }) {
  const q = useMemo(() => { try { return qrSvgPath(text); } catch { return null; } }, [text]);
  if (!q) return null;
  return (
    <svg role="img" aria-label={label} width={size} height={size} viewBox={`0 0 ${q.size} ${q.size}`} shapeRendering="crispEdges" className="rounded-lg border border-slate-200 bg-white">
      <path d={q.d} fill="#000" />
    </svg>
  );
}

export interface MapPoint { lat: number; lng: number }
/**
 * A tiny map of the route drawn in SVG from the stops' and the bus's coordinates: no tiles, no key, no tracking, works offline.
 * (A link to a full map app sits next to it.) Longitude is scaled by cos(latitude) so the shape is not stretched.
 */
export function RouteMap({ stops, trail, bus, mineId, label }: { stops: { id: string; name: string; lat: number | null; lng: number | null }[]; trail: MapPoint[]; bus: MapPoint | null; mineId?: string | null; label: string }) {
  const pts = [...stops.filter((s) => s.lat !== null && s.lng !== null).map((s) => ({ lat: Number(s.lat), lng: Number(s.lng) })), ...trail, ...(bus ? [bus] : [])];
  const geo = useMemo(() => {
    if (!pts.length) return null;
    const lat0 = pts.reduce((s, p) => s + p.lat, 0) / pts.length;
    const k = Math.cos((lat0 * Math.PI) / 180);
    const xs = pts.map((p) => p.lng * k);
    const ys = pts.map((p) => p.lat);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const span = Math.max(x1 - x0, y1 - y0, 0.002);
    const W = 320;
    const pad = 28;
    const scale = (W - pad * 2) / span;
    return { k, x0, y1, scale, pad, W, h: Math.max(180, Math.min(320, (y1 - y0) * scale + pad * 2)) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(pts)]);
  if (!geo) return null;
  const px = (p: MapPoint) => (p.lng * geo.k - geo.x0) * geo.scale + geo.pad;
  const py = (p: MapPoint) => (geo.y1 - p.lat) * geo.scale + geo.pad;
  const line = trail.map((p) => `${px(p).toFixed(1)},${py(p).toFixed(1)}`).join(' ');
  return (
    <svg role="img" aria-label={label} viewBox={`0 0 ${geo.W} ${geo.h}`} className="w-full rounded-xl border border-slate-200 bg-emerald-50">
      {trail.length > 1 && <polyline points={line} fill="none" stroke="var(--pt-primary)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" opacity="0.55" />}
      {stops.filter((s) => s.lat !== null && s.lng !== null).map((s) => {
        const p = { lat: Number(s.lat), lng: Number(s.lng) };
        const mine = s.id === mineId;
        return (
          <g key={s.id}>
            <circle cx={px(p)} cy={py(p)} r={mine ? 8 : 5} fill={mine ? 'var(--pt-accent)' : '#fff'} stroke="#334155" strokeWidth="2" />
            {mine && <text x={px(p) + 11} y={py(p) + 4} fontSize="12" fontWeight="700" fill="#0f172a">{s.name}</text>}
          </g>
        );
      })}
      {bus && (
        <g data-testid="bus-marker">
          <circle cx={px(bus)} cy={py(bus)} r="11" fill="var(--pt-primary)" stroke="#fff" strokeWidth="3" />
          <path d={`M${px(bus) - 5} ${py(bus) - 3}h10v6h-10zM${px(bus) - 5} ${py(bus)}h10`} stroke="var(--pt-on-primary)" strokeWidth="1.5" fill="none" />
        </g>
      )}
    </svg>
  );
}
