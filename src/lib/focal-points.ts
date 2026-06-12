/**
 * OSIRIS — Focal Point Convergence Detection
 *
 * Inspired by World Monitor's multi-signal convergence concept.
 * Implementation from scratch (WM focal points were not found in public source).
 *
 * Algorithm:
 *  1. Bin every geo-tagged event into a 1°×1° grid cell (floor lat/lng)
 *  2. Track which signal types appear in each cell within the last 24 h
 *  3. If 3+ distinct signal types converge in the same cell → convergence alert
 *  4. Score = distinct_signal_count × avg_severity × recency_factor
 */

export type SignalType = 'news' | 'fire' | 'earthquake' | 'vessel' | 'flight' | 'cyber' | 'conflict';

export interface GeoSignal {
  lat: number;
  lng: number;
  type: SignalType;
  severity?: number;    // 1–10 scale
  timestamp?: number;   // epoch ms
  title?: string;
}

export interface ConvergenceAlert {
  cellKey: string;        // "lat:lng" e.g. "31:34"
  lat: number;
  lng: number;
  signalTypes: SignalType[];
  signalCount: number;
  convergenceScore: number;
  severity: 'high' | 'critical';
  summary: string;
}

const CONVERGENCE_THRESHOLD = 3;    // min distinct signal types to trigger alert
const WINDOW_MS = 24 * 60 * 60 * 1000;  // 24-hour rolling window

// ─── In-memory signal store ───────────────────────────────────────────────────
const G = globalThis as unknown as {
  focalSignals: Array<GeoSignal & { _ts: number }>;
  focalLastPurge: number;
};
if (!G.focalSignals) G.focalSignals = [];
if (!G.focalLastPurge) G.focalLastPurge = 0;

function binCoord(v: number): number {
  return Math.floor(v);
}

function cellKey(lat: number, lng: number): string {
  return `${binCoord(lat)}:${binCoord(lng)}`;
}

function purgeStale(): void {
  const cutoff = Date.now() - WINDOW_MS;
  if (Date.now() - G.focalLastPurge < 5 * 60 * 1000) return; // only purge every 5 min
  G.focalSignals = G.focalSignals.filter(s => s._ts >= cutoff);
  G.focalLastPurge = Date.now();
}

/**
 * Ingest a batch of geo signals. Deduplicated by (type, cellKey, ~1h bucket).
 */
export function ingestSignals(signals: GeoSignal[]): void {
  purgeStale();
  const now = Date.now();

  for (const s of signals) {
    if (s.lat == null || s.lng == null || isNaN(s.lat) || isNaN(s.lng)) continue;
    const ts = s.timestamp ?? now;
    const hourBucket = Math.floor(ts / (60 * 60 * 1000));
    const key = `${s.type}:${cellKey(s.lat, s.lng)}:${hourBucket}`;

    const exists = G.focalSignals.some(
      x => `${x.type}:${cellKey(x.lat, x.lng)}:${Math.floor(x._ts / (60 * 60 * 1000))}` === key
    );
    if (!exists) {
      G.focalSignals.push({ ...s, _ts: ts });
    }
  }
}

/**
 * Compute convergence alerts from all currently-stored signals.
 * Returns alerts sorted by convergenceScore desc.
 */
export function computeConvergenceAlerts(): ConvergenceAlert[] {
  purgeStale();
  const cutoff = Date.now() - WINDOW_MS;
  const active = G.focalSignals.filter(s => s._ts >= cutoff);

  // Group by cell
  const cells = new Map<string, Array<GeoSignal & { _ts: number }>>();
  for (const s of active) {
    const key = cellKey(s.lat, s.lng);
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key)!.push(s);
  }

  const alerts: ConvergenceAlert[] = [];

  for (const [key, signals] of cells.entries()) {
    const typeSet = new Set(signals.map(s => s.type));
    if (typeSet.size < CONVERGENCE_THRESHOLD) continue;

    const types = [...typeSet] as SignalType[];

    // Average severity (default 5 if not provided)
    const avgSeverity = signals.reduce((sum, s) => sum + (s.severity ?? 5), 0) / signals.length;

    // Recency factor: fraction of signals in last 6 h
    const recent6h = signals.filter(s => s._ts >= Date.now() - 6 * 60 * 60 * 1000).length;
    const recencyFactor = 0.5 + 0.5 * (recent6h / signals.length);

    const convergenceScore = Math.round(types.length * avgSeverity * recencyFactor * 10) / 10;

    const [latStr, lngStr] = key.split(':');
    const lat = parseInt(latStr!, 10) + 0.5;
    const lng = parseInt(lngStr!, 10) + 0.5;

    const severity: 'high' | 'critical' = types.length >= 4 || convergenceScore >= 25 ? 'critical' : 'high';

    const typeLabels: Record<SignalType, string> = {
      news: 'intelligence',
      fire: 'wildfire',
      earthquake: 'seismic',
      vessel: 'maritime',
      flight: 'aviation',
      cyber: 'cyber',
      conflict: 'conflict',
    };
    const typeList = types.map(t => typeLabels[t] ?? t).join(', ');
    const summary = `Convergence alert: ${types.length} signal types (${typeList}) within 1°×1° cell — ${signals.length} total events in 24h`;

    alerts.push({ cellKey: key, lat, lng, signalTypes: types, signalCount: signals.length, convergenceScore, severity, summary });
  }

  return alerts.sort((a, b) => b.convergenceScore - a.convergenceScore);
}

/** Clear all signals (for testing / reset) */
export function clearSignals(): void {
  G.focalSignals = [];
  G.focalLastPurge = 0;
}
