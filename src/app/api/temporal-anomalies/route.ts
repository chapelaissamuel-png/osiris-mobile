import { NextResponse } from 'next/server';
import { detectAnomalies, invalidateSnapshot } from '@/lib/temporal-anomalies';

/**
 * OSIRIS — Temporal Anomaly Detection (Welford Online Algorithm)
 *
 * Collects current counts from sibling routes and computes Z-scores
 * vs the rolling 90-day Welford baseline per (type × weekday × month).
 *
 * Adapted from World Monitor (github.com/koala73/worldmonitor), MIT License.
 * Original: server/worldmonitor/infrastructure/v1/list-temporal-anomalies.ts
 *
 * Z-score thresholds: 1.5 → medium, 2.0 → high, 3.0 → critical
 */

const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

async function fetchCount(path: string): Promise<number | null> {
  try {
    const url = `http://localhost:${process.env.PORT ?? 3000}${BASE}${path}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000), cache: 'no-store' });
    if (!res.ok) return null;
    const data = await res.json();
    return (
      data.total ??
      data.count ??
      data.fires?.length ??
      data.news?.length ??
      data.earthquakes?.length ??
      data.threats?.length ??
      null
    );
  } catch {
    return null;
  }
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    if (searchParams.get('invalidate') === '1') {
      invalidateSnapshot();
    }

    // Gather current counts from live endpoints in parallel
    const [newsCount, firesCount, eqCount, cyberCount] = await Promise.all([
      fetchCount('/api/news'),
      fetchCount('/api/fires'),
      fetchCount('/api/earthquakes'),
      fetchCount('/api/cyber-threats'),
    ]);

    const counts: Record<string, number> = {};
    if (newsCount  != null) counts.news       = newsCount;
    if (firesCount != null) counts.fires      = firesCount;
    if (eqCount    != null) counts.earthquakes = eqCount;
    if (cyberCount != null) counts.cyber      = cyberCount;

    const snapshot = detectAnomalies(counts);

    return NextResponse.json(
      {
        ...snapshot,
        counts,
        algorithm: 'Welford online (90-day baseline, z-score thresholds 1.5/2.0/3.0)',
        timestamp: new Date().toISOString(),
      },
      { headers: { 'Cache-Control': 'no-store, max-age=0' } }
    );

  } catch {
    return NextResponse.json(
      { anomalies: [], error: 'Anomaly detection failed', timestamp: new Date().toISOString() },
      { status: 500 }
    );
  }
}
