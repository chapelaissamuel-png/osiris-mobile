import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * OSIRIS — Global Radiation Monitoring
 * Source 1: Safecast API (open, no key) — citizen-science Geiger network
 * Source 2: uradmonitor (open, no key) — professional IoT radiation sensors
 *
 * Normal background: 0.05–0.20 µSv/h
 * Elevated: 0.30–1.00 µSv/h | High: 1.00–10 µSv/h | Danger: > 10 µSv/h
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
  deviceId?: string | number;
}

function classifyReading(usvh: number): { level: string; color: string } {
  if (usvh > 10.0)  return { level: 'DANGER',    color: '#FF0000' };
  if (usvh > 1.00)  return { level: 'HIGH',       color: '#FF3D3D' };
  if (usvh > 0.30)  return { level: 'ELEVATED',   color: '#FF9500' };
  if (usvh > 0.20)  return { level: 'MODERATE',   color: '#FFD700' };
  return               { level: 'NORMAL',    color: '#00E676' };
}

function cpmToUsvh(cpm: number): number {
  return cpm / 334; // LND-7317 conversion factor
}

function toUsvh(value: number, unit: string): number {
  const u = (unit || '').toLowerCase();
  if (u.includes('usv') || u.includes('µsv') || u.includes('microsv')) return value;
  return cpmToUsvh(value); // default: CPM
}

// ─── Source 1: Safecast ───────────────────────────────────────────────────────
async function fetchSafecast(): Promise<RadiationStation[]> {
  const stations: RadiationStation[] = [];

  const pages = await Promise.allSettled([
    fetch(
      'https://api.safecast.org/measurements.json?format=json&limit=200&page=1&order%5Bcaptured_at%5D=desc',
      { signal: AbortSignal.timeout(12000), cache: 'no-store', headers: { 'User-Agent': 'OSIRIS/4' } }
    ).then(r => r.json()),
    fetch(
      'https://api.safecast.org/measurements.json?format=json&limit=200&page=2&order%5Bcaptured_at%5D=desc',
      { signal: AbortSignal.timeout(12000), cache: 'no-store', headers: { 'User-Agent': 'OSIRIS/4' } }
    ).then(r => r.json()),
  ]);

  const raw: any[] = [];
  for (const p of pages) if (p.status === 'fulfilled') raw.push(...p.value);

  for (const m of raw) {
    const lat = parseFloat(m.latitude);
    const lng = parseFloat(m.longitude);
    if (isNaN(lat) || isNaN(lng)) continue;
    if (!m.value || !m.unit) continue;

    const rawReading = parseFloat(m.value);
    if (isNaN(rawReading) || rawReading < 0) continue;

    const usvh = Math.round(toUsvh(rawReading, m.unit) * 10000) / 10000;
    if (usvh <= 0 || usvh > 10000) continue;

    const { level, color } = classifyReading(usvh);
    stations.push({
      id:         `safecast-${m.id}`,
      name:       m.location_name || `Station #${m.id}`,
      city:       m.location_name || '',
      country:    m.country_code || '',
      lat:        Math.round(lat * 100000) / 100000,
      lng:        Math.round(lng * 100000) / 100000,
      reading:    usvh,
      unit:       'µSv/h',
      level,
      color,
      network:    'Safecast',
      capturedAt: m.captured_at || '',
      deviceId:   m.device_id,
    });
  }
  return stations;
}

// ─── Source 2: uradmonitor ────────────────────────────────────────────────────
async function fetchUradMonitor(): Promise<RadiationStation[]> {
  const res = await fetch('https://data.uradmonitor.com/api/v1/devices/all', {
    signal: AbortSignal.timeout(12000),
    cache: 'no-store',
    headers: {
      'User-Agent': 'OSIRIS/4',
      'Accept': 'application/json',
    },
  });
  if (!res.ok) throw new Error(`uradmonitor HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error('Unexpected uradmonitor response shape');

  const stations: RadiationStation[] = [];
  for (const d of data) {
    const lat = parseFloat(d.latitude);
    const lng = parseFloat(d.longitude);
    if (isNaN(lat) || isNaN(lng)) continue;
    if (lat === 0 && lng === 0) continue;

    const rawCpm = parseFloat(d.value ?? d.cpm ?? d.data ?? '0');
    if (isNaN(rawCpm) || rawCpm <= 0) continue;

    const usvh = Math.round(cpmToUsvh(rawCpm) * 10000) / 10000;
    if (usvh <= 0 || usvh > 10000) continue;

    const { level, color } = classifyReading(usvh);
    stations.push({
      id:         `uradm-${d.id}`,
      name:       d.note || `Device ${d.id}`,
      city:       d.city || '',
      country:    d.country || '',
      lat:        Math.round(lat * 100000) / 100000,
      lng:        Math.round(lng * 100000) / 100000,
      reading:    usvh,
      unit:       'µSv/h',
      level,
      color,
      network:    'uradmonitor',
      capturedAt: d.time ? new Date(d.time * 1000).toISOString() : '',
      deviceId:   d.id,
    });
  }
  return stations;
}

// ─── Deduplicate on 0.1° grid, keep highest reading per cell ─────────────────
function dedup(stations: RadiationStation[]): RadiationStation[] {
  const grid = new Map<string, RadiationStation>();
  for (const s of stations) {
    const key = `${Math.round(s.lat * 10)},${Math.round(s.lng * 10)}`;
    const existing = grid.get(key);
    if (!existing || s.reading > existing.reading) grid.set(key, s);
  }
  return Array.from(grid.values()).sort((a, b) => b.reading - a.reading);
}

export async function GET() {
  const [safecastResult, uradResult] = await Promise.allSettled([
    fetchSafecast(),
    fetchUradMonitor(),
  ]);

  const all: RadiationStation[] = [];
  const sources: string[] = [];

  if (safecastResult.status === 'fulfilled' && safecastResult.value.length > 0) {
    all.push(...safecastResult.value);
    sources.push('Safecast');
  } else {
    console.error('[OSIRIS/Radiation] Safecast error:', (safecastResult as any).reason ?? 'no data');
  }

  if (uradResult.status === 'fulfilled' && uradResult.value.length > 0) {
    all.push(...uradResult.value);
    sources.push('uradmonitor');
  } else {
    console.error('[OSIRIS/Radiation] uradmonitor error:', (uradResult as any).reason ?? 'no data');
  }

  const stations = dedup(all);

  return NextResponse.json(
    {
      stations,
      total:     stations.length,
      source:    sources.join(' + ') || 'unavailable',
      timestamp: new Date().toISOString(),
      ...(stations.length === 0 ? { error: 'All radiation sources unavailable' } : {}),
    },
    {
      headers: {
        'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600',
      },
    }
  );
}
