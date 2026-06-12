/**
 * OSIRIS — Temporal Anomaly Detection (Welford Online Algorithm)
 *
 * Adapted from World Monitor (github.com/koala73/worldmonitor), MIT License.
 * Original: server/worldmonitor/infrastructure/v1/list-temporal-anomalies.ts
 *           + server/worldmonitor/infrastructure/v1/_shared.ts
 *
 * Uses Welford's online algorithm to maintain mean + variance per
 * (type × region × weekday × month) without storing raw samples.
 * Baseline window: 90 days. Z-score thresholds: 1.5 / 2.0 / 3.0
 */

export interface BaselineEntry {
  mean: number;
  m2: number;
  sampleCount: number;
  lastUpdated: string;
}

export interface TemporalAnomaly {
  type: string;
  region: string;
  currentCount: number;
  expectedCount: number;
  zScore: number;
  severity: 'medium' | 'high' | 'critical';
  multiplier: number;
  message: string;
}

export interface AnomalySnapshot {
  anomalies: TemporalAnomaly[];
  trackedTypes: string[];
  computedAt: string;
}

// ─── Constants (verbatim from WM _shared.ts) ──────────────────────────────────
export const BASELINE_TTL_MS  = 90 * 24 * 60 * 60 * 1000;  // 90 days
export const MIN_SAMPLES       = 10;
export const Z_THRESHOLD_LOW   = 1.5;
export const Z_THRESHOLD_MED   = 2.0;
export const Z_THRESHOLD_HIGH  = 3.0;
export const SNAPSHOT_TTL_MS   = 15 * 60 * 1000;            // 15 min

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES   = ['', 'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

// ─── In-memory stores ────────────────────────────────────────────────────────
const G = globalThis as unknown as {
  temporalBaselines: Map<string, BaselineEntry>;
  temporalSnapshot:  { data: AnomalySnapshot; cachedAt: number } | null;
};
if (!G.temporalBaselines) G.temporalBaselines = new Map();
if (!G.temporalSnapshot) G.temporalSnapshot = null;

function makeBaselineKey(type: string, region: string, weekday: number, month: number): string {
  return `baseline:v1:${type}:${region}:${weekday}:${month}`;
}

function getSeverity(z: number): 'medium' | 'high' | 'critical' {
  if (z >= Z_THRESHOLD_HIGH) return 'critical';
  if (z >= Z_THRESHOLD_MED)  return 'high';
  return 'medium';
}

function formatMessage(type: string, count: number, mean: number, multiplier: number, weekday: number, month: number): string {
  const TYPE_LABELS: Record<string, string> = {
    news: 'News velocity',
    fires: 'Active fire detections',
    earthquakes: 'Seismic events',
    cyber: 'Cyber threat indicators',
    flights: 'Military flight activity',
    vessels: 'AIS vessel traffic',
  };
  const label = TYPE_LABELS[type] ?? type;
  const mult = multiplier < 10 ? `${multiplier.toFixed(1)}x` : `${Math.round(multiplier)}x`;
  return `${label} ${mult} normal for ${WEEKDAY_NAMES[weekday]} (${MONTH_NAMES[month]}) — ${count} vs baseline ${Math.round(mean)}`;
}

/**
 * Update the Welford baseline for a given type+region and the current count.
 * Returns an anomaly if the count deviates significantly from the baseline.
 */
export function updateBaseline(
  type: string,
  region: string,
  count: number,
  now: Date = new Date(),
): TemporalAnomaly | null {
  const weekday = now.getUTCDay();
  const month   = now.getUTCMonth() + 1;
  const key     = makeBaselineKey(type, region, weekday, month);

  const prev: BaselineEntry = G.temporalBaselines.get(key) ?? { mean: 0, m2: 0, sampleCount: 0, lastUpdated: '' };

  let anomaly: TemporalAnomaly | null = null;

  if (prev.sampleCount >= MIN_SAMPLES) {
    const variance = Math.max(0, prev.m2 / (prev.sampleCount - 1));
    const stdDev   = Math.sqrt(variance);
    const zScore   = stdDev > 0 ? Math.abs((count - prev.mean) / stdDev) : 0;

    if (zScore >= Z_THRESHOLD_LOW) {
      const multiplier = prev.mean > 0
        ? Math.round((count / prev.mean) * 100) / 100
        : count > 0 ? 999 : 1;

      anomaly = {
        type,
        region,
        currentCount: count,
        expectedCount: Math.round(prev.mean),
        zScore: Math.round(zScore * 100) / 100,
        severity: getSeverity(zScore),
        multiplier,
        message: formatMessage(type, count, prev.mean, multiplier, weekday, month),
      };
    }
  }

  // Welford online update
  const n      = prev.sampleCount + 1;
  const delta  = count - prev.mean;
  const newMean = prev.mean + delta / n;
  const delta2  = count - newMean;
  const newM2   = prev.m2 + delta * delta2;

  G.temporalBaselines.set(key, {
    mean: newMean,
    m2: newM2,
    sampleCount: n,
    lastUpdated: now.toISOString(),
  });

  return anomaly;
}

/**
 * Run anomaly detection over a snapshot of current counts.
 * counts = { news: 42, fires: 120, earthquakes: 5, ... }
 * Returns a cached snapshot for SNAPSHOT_TTL_MS to avoid redundant calls.
 */
export function detectAnomalies(
  counts: Record<string, number>,
  region = 'global',
): AnomalySnapshot {
  const now = new Date();

  if (G.temporalSnapshot && Date.now() - G.temporalSnapshot.cachedAt < SNAPSHOT_TTL_MS) {
    return G.temporalSnapshot.data;
  }

  const anomalies: TemporalAnomaly[] = [];

  for (const [type, count] of Object.entries(counts)) {
    const anomaly = updateBaseline(type, region, count, now);
    if (anomaly) anomalies.push(anomaly);
  }

  anomalies.sort((a, b) => b.zScore - a.zScore);

  const snapshot: AnomalySnapshot = {
    anomalies,
    trackedTypes: Object.keys(counts),
    computedAt: now.toISOString(),
  };

  G.temporalSnapshot = { data: snapshot, cachedAt: Date.now() };
  return snapshot;
}

/** Reset snapshot cache (forces recomputation on next call) */
export function invalidateSnapshot(): void {
  G.temporalSnapshot = null;
}
