import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * OSIRIS — Weather Balloon / Radiosonde Tracking
 * Primary source: SondeHub v2 (open, no key required)
 *   https://api.v2.sondehub.org/balloons
 * Fallback: radiosondy.cz public API
 *   https://api.radiosondy.cz/api/v1/ballons (typo in their API name, intentional)
 *
 * SondeHub response shape:
 *   { "<serial>": { serial, lat, lon, alt, vel_v, vel_h, heading, temp, datetime, subtype, ... } }
 */

interface Balloon {
  id: string;
  serial: string;
  lat: number;
  lng: number;
  altitude: number;
  speed: number;
  verticalRate: number;
  heading: number;
  temperature: number | null;
  type: string;
  status: 'ascending' | 'descending' | 'burst' | 'unknown';
  datetime: string;
  color: string;
}

function classifyStatus(vel_v: number | undefined): Balloon['status'] {
  if (vel_v === undefined || vel_v === null) return 'unknown';
  if (vel_v > 1) return 'ascending';
  if (vel_v < -5) return 'burst';
  if (vel_v < -1) return 'descending';
  return 'ascending';
}

function statusColor(status: Balloon['status']): string {
  switch (status) {
    case 'ascending':  return '#00E676';
    case 'descending': return '#FFD700';
    case 'burst':      return '#FF3D3D';
    default:           return '#AAAAAA';
  }
}

async function fetchSondeHub(): Promise<Balloon[]> {
  // Try /balloons first (active sondes), fall back to /sondes/telemetry?duration=1h
  let res = await fetch('https://api.v2.sondehub.org/balloons', {
    signal: AbortSignal.timeout(15000),
    cache:  'no-store',
    headers: {
      'User-Agent': 'OSIRIS-Intelligence-Platform/4.0',
      'Accept':     'application/json',
      'Accept-Encoding': 'identity',
    },
  });
  if (!res.ok) {
    res = await fetch('https://api.v2.sondehub.org/sondes/telemetry?duration=1h&limit=500', {
      signal: AbortSignal.timeout(15000),
      cache:  'no-store',
      headers: { 'User-Agent': 'OSIRIS/4.0', 'Accept': 'application/json' },
    });
  }

  if (!res.ok) throw new Error(`SondeHub HTTP ${res.status}`);

  const data: Record<string, any> = await res.json();
  const balloons: Balloon[] = [];

  for (const [serial, entry] of Object.entries(data)) {
    const lat = entry.lat ?? entry.latitude;
    const lng = entry.lon ?? entry.longitude ?? entry.lng;
    if (lat == null || lng == null) continue;

    const vel_v   = typeof entry.vel_v === 'number'   ? entry.vel_v   : undefined;
    const vel_h   = typeof entry.vel_h === 'number'   ? entry.vel_h   : undefined;
    const heading = typeof entry.heading === 'number' ? entry.heading : 0;
    const alt     = typeof entry.alt === 'number'     ? entry.alt     : 0;
    const temp    = typeof entry.temp === 'number'    ? entry.temp    : null;
    const status  = classifyStatus(vel_v);

    balloons.push({
      id:           `sondehub-${serial}`,
      serial,
      lat:          Math.round(lat * 100000) / 100000,
      lng:          Math.round(lng * 100000) / 100000,
      altitude:     Math.round(alt),
      speed:        vel_h !== undefined ? Math.round(vel_h * 10) / 10 : 0,
      verticalRate: vel_v !== undefined ? Math.round(vel_v * 10) / 10 : 0,
      heading:      Math.round(heading),
      temperature:  temp,
      type:         entry.subtype || entry.type || 'Radiosonde',
      status,
      datetime:     entry.datetime || entry.time_received || new Date().toISOString(),
      color:        statusColor(status),
    });
  }

  return balloons;
}

async function fetchRadiosondy(): Promise<Balloon[]> {
  const res = await fetch('https://api.radiosondy.cz/api/v1/ballons', {
    signal: AbortSignal.timeout(10000),
    cache:  'no-store',
    headers: { 'User-Agent': 'OSIRIS/4.0', 'Accept': 'application/json' },
  });

  if (!res.ok) throw new Error(`radiosondy.cz HTTP ${res.status}`);

  const data: any[] = await res.json();
  const balloons: Balloon[] = [];

  for (const entry of data) {
    const lat = parseFloat(entry.lat ?? entry.latitude);
    const lng = parseFloat(entry.lon ?? entry.lng ?? entry.longitude);
    if (isNaN(lat) || isNaN(lng)) continue;

    const vel_v  = typeof entry.vs  === 'number' ? entry.vs  : undefined;
    const vel_h  = typeof entry.vel === 'number' ? entry.vel : undefined;
    const alt    = typeof entry.alt === 'number' ? entry.alt : 0;
    const status = classifyStatus(vel_v);
    const serial = entry.serial || entry.id || String(balloons.length);

    balloons.push({
      id:           `radiosondy-${serial}`,
      serial,
      lat:          Math.round(lat * 100000) / 100000,
      lng:          Math.round(lng * 100000) / 100000,
      altitude:     Math.round(alt),
      speed:        vel_h !== undefined ? Math.round(vel_h * 10) / 10 : 0,
      verticalRate: vel_v !== undefined ? Math.round(vel_v * 10) / 10 : 0,
      heading:      typeof entry.heading === 'number' ? Math.round(entry.heading) : 0,
      temperature:  typeof entry.temp === 'number' ? entry.temp : null,
      type:         entry.type || 'Radiosonde',
      status,
      datetime:     entry.datetime || entry.time || new Date().toISOString(),
      color:        statusColor(status),
    });
  }

  return balloons;
}

export async function GET() {
  let balloons: Balloon[] = [];
  let source = '';
  let error: string | undefined;

  // Try SondeHub first
  try {
    balloons = await fetchSondeHub();
    source   = 'SondeHub v2';
  } catch (e1) {
    console.warn('[OSIRIS/Balloons] SondeHub failed:', e1 instanceof Error ? e1.message : e1);

    // Fallback: radiosondy.cz
    try {
      balloons = await fetchRadiosondy();
      source   = 'radiosondy.cz';
    } catch (e2) {
      console.error('[OSIRIS/Balloons] Both sources failed:', e2 instanceof Error ? e2.message : e2);
      error  = 'Both SondeHub and radiosondy.cz unavailable';
      source = 'none';
    }
  }

  return NextResponse.json(
    {
      balloons,
      total:     balloons.length,
      source,
      timestamp: new Date().toISOString(),
      ...(error ? { error } : {}),
    },
    {
      headers: {
        'Cache-Control': balloons.length > 0
          ? 'public, s-maxage=120, stale-while-revalidate=240'
          : 'no-store',
      },
    }
  );
}
