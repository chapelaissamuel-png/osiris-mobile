import { NextResponse } from 'next/server';
import { computeConvergenceAlerts } from '@/lib/focal-points';

/**
 * OSIRIS — Focal Point Convergence Detection
 *
 * Returns active convergence alerts: geo cells where 3+ distinct signal
 * types (news/fire/earthquake/vessel/flight/cyber) have co-located
 * within the last 24 h. Signals are ingested by other routes as they run.
 *
 * Adapted from World Monitor convergence concept (MIT License).
 */
export async function GET() {
  try {
    const alerts = computeConvergenceAlerts();

    return NextResponse.json(
      {
        alerts,
        total: alerts.length,
        threshold: '3+ signal types in 1°×1° cell within 24h',
        timestamp: new Date().toISOString(),
      },
      { headers: { 'Cache-Control': 'no-store, max-age=0' } }
    );
  } catch {
    return NextResponse.json(
      { alerts: [], error: 'Failed to compute focal points', timestamp: new Date().toISOString() },
      { status: 500 }
    );
  }
}
