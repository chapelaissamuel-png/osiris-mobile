import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * OSIRIS — Global Radiation Monitoring
 * Source: Safecast API (open, completely free, no key required)
 *   https://api.safecast.org/measurements.json
 *
 * Safecast is a citizen-science network of Geiger counters.
 * Data is measured in µSv/h (microsieverts per hour).
 * Normal background: 0.05–0.20 µSv/h
 * Elevated: 0.30–1.00 µSv/h
 * High: 1.00–10 µSv/h
 * Danger: > 10 µSv/h
 */

interface RadiationStation {
  id: string;
  name: string;
  city: string;
  country: string;
  lat: number;
  lng: number;
  reading: number;
  unit: string;
  level: string;
  color: string;
  network: string;
  capturedAt: string;
  deviceId?: number;
}

function classifyReading(usvh: number): { level: string; color: string } {
  if (usvh > 10.0)  return { level: 'DANGER',    color: '#FF0000' };
  if (usvh > 1.00)  return { level: 'HIGH',       color: '#FF3D3D' };
  if (usvh > 0.30)  return { level: 'ELEVATED',   color: '#FF9500' };
  if (usvh > 0.20)  return { level: 'MODERATE',   color: '#FFD700' };
  return              { level: 'NORMAL',    color: '#00E676' };
}

/**
 * Convert Safecast native unit (cpm) to µSv/h.
 * Safecast uses LND-7317 tubes: 334 CPM ≈ 1 µSv/h (standard conversion).
 */
function toUsvh(value: number, unit: string): number {
  const u = (unit || '').toLowerCase();
  if (u.includes('usv') || u.includes('µsv') || u.includes('microsv')) {
    return value;
  }
  if (u === 'cpm' || u === 'counts per minute') {
    return value / 334;
  }
  // Unknown unit — attempt CPM conversion as best guess
  return value / 334;
}

async function fetchSafecast(page: number): Promise<any[]> {
  const url =
    `https://api.safecast.org/measurements.json` +
    `?format=json&limit=200&page=${page}&order%5Bcaptured_at%5D=desc`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(12000),
    cache:  'no-store',
    headers: {
      'User-Agent': 'OSIRIS-Intelligence-Platform/4.0',
      'Accept':     'application/json',
    },
  });
  if (!res.ok) throw new Error(`Safecast HTTP ${res.status}`);
  return res.json();
}

export async function GET() {
  try {
    // Fetch 2 pages = up to 400 measurements, most recent first
    const [page1, page2] = await Promise.allSettled([
      fetchSafecast(1),
      fetchSafecast(2),
    ]);

    const raw: any[] = [];
    if (page1.status === 'fulfilled') raw.push(...page1.value);
    if (page2.status === 'fulfilled') raw.push(...page2.value);

    if (raw.length === 0) {
      return NextResponse.json(
        {
          stations: [],
          total: 0,
          source: 'Safecast',
          timestamp: new Date().toISOString(),
          error: 'Safecast API returned no data',
        },
        { status: 200, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    // Deduplicate by ~0.1° grid cell (keep highest reading per cell)
    const grid = new Map<string, RadiationStation>();

    for (const m of raw) {
      const lat = parseFloat(m.latitude);
      const lng = parseFloat(m.longitude);
      if (isNaN(lat) || isNaN(lng)) continue;
      if (!m.value || !m.unit) continue;

      const rawReading = parseFloat(m.value);
      if (isNaN(rawReading) || rawReading < 0) continue;

      const usvh = Math.round(toUsvh(rawReading, m.unit) * 10000) / 10000;
      if (usvh <= 0 || usvh > 10000) continue; // sanity bounds

      const { level, color } = classifyReading(usvh);

      const station: RadiationStation = {
        id:          `safecast-${m.id}`,
        name:        m.location_name || `Station #${m.id}`,
        city:        m.location_name || '',
        country:     m.country_code  || '',
        lat:         Math.round(lat * 100000) / 100000,
        lng:         Math.round(lng * 100000) / 100000,
        reading:     usvh,
        unit:        'µSv/h',
        level,
        color,
        network:     'Safecast',
        capturedAt:  m.captured_at || '',
        deviceId:    m.device_id,
      };

      // Grid deduplication — keep highest reading per cell
      const key = `${Math.round(lat * 10)},${Math.round(lng * 10)}`;
      const existing = grid.get(key);
      if (!existing || station.reading > existing.reading) {
        grid.set(key, station);
      }
    }

    const stations = Array.from(grid.values())
      .sort((a, b) => b.reading - a.reading); // highest radiation first

    return NextResponse.json(
      {
        stations,
        total:     stations.length,
        source:    'Safecast',
        timestamp: new Date().toISOString(),
      },
      {
        headers: {
          'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600',
        },
      }
    );
  } catch (error) {
    console.error('[OSIRIS/Radiation] Safecast fetch error:', error);
    return NextResponse.json(
      { stations: [], total: 0, error: 'Safecast unavailable', source: 'Safecast' },
      { status: 500 }
    );
  }
}
