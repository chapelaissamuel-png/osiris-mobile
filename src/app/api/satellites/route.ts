
import { NextResponse } from 'next/server';
import { stealthFetch } from '@/lib/stealthFetch';

/**
 * OSIRIS — Satellite Tracking API
 *
 * Source hierarchy:
 *   1. N2YO (N2YO_API_KEY) — real SGP4 positions computed server-side, most accurate
 *   2. SatNOGS DB           — full TLE catalog, propagated locally (simplified SGP4)
 *   3. CelesTrak active.tle — supplemental TLEs, same local propagator
 *
 * N2YO strategy:
 *   - 4 global observer points at equator (90° apart, 90° radius) → full sphere coverage
 *   - Category 0 = all satellites tracked by N2YO
 *   - 2-hour in-memory cache to stay within the 1 000 tx/hr free-tier limit
 *   - N2YO positions override local SGP4 for the same NORAD ID (more accurate)
 */

// ─── Mission classification ───────────────────────────────────────────────────
const MISSION_CLASSIFY: Record<string, { mission: string; color: string }> = {
  'USA':        { mission: 'Military Recon',      color: '#FF3D3D' },
  'NROL':       { mission: 'NRO Classified',       color: '#FF3D3D' },
  'LACROSSE':   { mission: 'SAR Imaging',          color: '#00E5FF' },
  'MENTOR':     { mission: 'SIGINT',               color: '#FFFFFF' },
  'ORION':      { mission: 'SIGINT',               color: '#FFFFFF' },
  'TRUMPET':    { mission: 'SIGINT',               color: '#FFFFFF' },
  'GPS':        { mission: 'Navigation',           color: '#448AFF' },
  'NAVSTAR':    { mission: 'Navigation',           color: '#448AFF' },
  'GLONASS':    { mission: 'Navigation',           color: '#448AFF' },
  'GALILEO':    { mission: 'Navigation',           color: '#448AFF' },
  'BEIDOU':     { mission: 'Navigation',           color: '#448AFF' },
  'SBIRS':      { mission: 'Early Warning',        color: '#FF00FF' },
  'DSP':        { mission: 'Early Warning',        color: '#FF00FF' },
  'STARLINK':   { mission: 'Commercial Comms',     color: '#00E676' },
  'ONEWEB':     { mission: 'Commercial Comms',     color: '#00E676' },
  'PLANET':     { mission: 'Earth Imaging',        color: '#00E676' },
  'WORLDVIEW':  { mission: 'Commercial Imaging',   color: '#00E676' },
  'ISS':        { mission: 'Space Station',        color: '#FFD700' },
  'TIANGONG':   { mission: 'Space Station',        color: '#FFD700' },
  'COSMOS':     { mission: 'Russian Military',     color: '#FF6B6B' },
  'YAOGAN':     { mission: 'Chinese Recon',        color: '#FF6B6B' },
  'FENGYUN':    { mission: 'Weather',              color: '#87CEEB' },
  'GOES':       { mission: 'Weather',              color: '#87CEEB' },
  'NOAA':       { mission: 'Weather',              color: '#87CEEB' },
  'METEOSAT':   { mission: 'Weather',              color: '#87CEEB' },
  'LANDSAT':    { mission: 'Earth Observation',    color: '#90EE90' },
  'SENTINEL':   { mission: 'Earth Observation',    color: '#90EE90' },
  'TERRA':      { mission: 'Earth Science',        color: '#90EE90' },
  'AQUA':       { mission: 'Earth Science',        color: '#90EE90' },
  'HUBBLE':     { mission: 'Space Telescope',      color: '#FFD700' },
  'JAMES WEBB': { mission: 'Space Telescope',      color: '#FFD700' },
};

function classifySatellite(name: string): { mission: string; color: string } {
  const upper = name.toUpperCase();
  for (const [kw, info] of Object.entries(MISSION_CLASSIFY)) {
    if (upper.includes(kw)) return info;
  }
  return { mission: 'Unknown', color: '#00E5FF' };
}

// ─── Simplified SGP4 (local fallback) ────────────────────────────────────────
function gmst(jd: number): number {
  const t = (jd - 2451545.0) / 36525.0;
  const s = 67310.54841 + (876600 * 3600 + 8640184.812866) * t + 0.093104 * t * t - 6.2e-6 * t ** 3;
  return ((s % 86400) / 86400) * 2 * Math.PI;
}

function propagateSGP4Simple(line1: string, line2: string): { lat: number; lng: number; alt: number } | null {
  try {
    const incDeg      = parseFloat(line2.substring(8, 16));
    const raanDeg     = parseFloat(line2.substring(17, 25));
    const ecc         = parseFloat('0.' + line2.substring(26, 33).trim());
    const argPerDeg   = parseFloat(line2.substring(34, 42));
    const meanAnomDeg = parseFloat(line2.substring(43, 51));
    const meanMotion  = parseFloat(line2.substring(52, 63));
    if (isNaN(meanMotion) || meanMotion === 0) return null;

    const epochYear  = parseInt(line1.substring(18, 20));
    const epochDay   = parseFloat(line1.substring(20, 32));
    const fullYear   = epochYear > 56 ? 1900 + epochYear : 2000 + epochYear;
    const epochDate  = new Date(fullYear, 0, 1);
    epochDate.setDate(epochDate.getDate() + epochDay - 1);
    const elapsedMin = (Date.now() - epochDate.getTime()) / 60000;
    if (Math.abs(elapsedMin) > 43200 && !line1.includes('27885-3')) return null;

    const n  = meanMotion * 2 * Math.PI / 1440;
    let   M  = ((meanAnomDeg * Math.PI / 180) + n * elapsedMin) % (2 * Math.PI);
    let   E  = M;
    for (let j = 0; j < 10; j++) E = M + ecc * Math.sin(E);

    const sinV = Math.sqrt(1 - ecc * ecc) * Math.sin(E) / (1 - ecc * Math.cos(E));
    const cosV = (Math.cos(E) - ecc) / (1 - ecc * Math.cos(E));
    const v    = Math.atan2(sinV, cosV);
    const a    = (398600.4418 / (meanMotion * 2 * Math.PI / 86400) ** 2) ** (1 / 3);
    const r    = a * (1 - ecc * Math.cos(E));
    const inc  = incDeg * Math.PI / 180;
    const raan = raanDeg * Math.PI / 180;
    const u    = v + argPerDeg * Math.PI / 180;

    const x = r * (Math.cos(raan) * Math.cos(u) - Math.sin(raan) * Math.sin(u) * Math.cos(inc));
    const y = r * (Math.sin(raan) * Math.cos(u) + Math.cos(raan) * Math.sin(u) * Math.cos(inc));
    const z = r * Math.sin(u) * Math.sin(inc);

    const theta = gmst(2440587.5 + Date.now() / 86400000);
    const xR = x * Math.cos(theta) + y * Math.sin(theta);
    const yR = -x * Math.sin(theta) + y * Math.cos(theta);

    const lat = Math.atan2(z, Math.sqrt(xR * xR + yR * yR)) * 180 / Math.PI;
    const lng = Math.atan2(yR, xR) * 180 / Math.PI;
    const alt = r - 6371;
    if (isNaN(lat) || Math.abs(lat) > 90 || alt < 100 || alt > 50000) return null;
    return {
      lat: Math.round(lat * 10000) / 10000,
      lng: Math.round(((lng + 540) % 360 - 180) * 10000) / 10000,
      alt: Math.round(alt),
    };
  } catch { return null; }
}

// ─── TLE text parser (CelesTrak) ─────────────────────────────────────────────
function parseTleText(text: string): Array<{ name: string; line1: string; line2: string }> {
  const sats: Array<{ name: string; line1: string; line2: string }> = [];
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  for (let i = 0; i < lines.length - 2; i++) {
    if (!lines[i + 1].startsWith('1 ') || !lines[i + 2].startsWith('2 ')) continue;
    sats.push({ name: lines[i].replace(/^0\s+/, ''), line1: lines[i + 1], line2: lines[i + 2] });
    i += 2;
  }
  return sats;
}

// ─── N2YO: real-SGP4 positions computed server-side ──────────────────────────
//
// 4 observer points at equator, 90° apart, 90° radius → covers the full sphere.
// Category 0 = all satellites tracked by N2YO.
// Each satellite returned costs 1 transaction (free tier: 1 000 tx/hr).
// The 2-hour cache keeps us well within budget.
//
const N2YO_OBSERVERS = [
  { lat: 0, lng: 0   },
  { lat: 0, lng: 90  },
  { lat: 0, lng: 180 },
  { lat: 0, lng: -90 },
];
const N2YO_RADIUS   = 90; // degrees — full hemisphere per observer
const N2YO_CATEGORY = 0;  // all N2YO-tracked satellites
const N2YO_CACHE_MS = 2 * 60 * 60 * 1000; // 2-hour cache

interface N2YOSat {
  satid:   number;
  satname: string;
  satlat:  number;
  satlng:  number;
  satalt:  number;
}

async function fetchN2YO(apiKey: string): Promise<{ sats: N2YOSat[]; transactions: number }> {
  const results = await Promise.allSettled(
    N2YO_OBSERVERS.map(obs =>
      fetch(
        `https://api.n2yo.com/rest/v1/satellite/above/${obs.lat}/${obs.lng}/0/${N2YO_RADIUS}/${N2YO_CATEGORY}&apiKey=${encodeURIComponent(apiKey)}`,
        { signal: AbortSignal.timeout(12000), cache: 'no-store' }
      ).then(r => {
        if (r.status === 429) throw new Error('N2YO rate-limited (429)');
        if (!r.ok)            throw new Error(`N2YO HTTP ${r.status}`);
        return r.json();
      })
    )
  );

  const seen = new Set<number>();
  const sats: N2YOSat[] = [];
  let   transactions     = 0;

  for (const r of results) {
    if (r.status !== 'fulfilled') {
      console.warn('[OSIRIS/N2YO] Observer failed:', (r as PromiseRejectedResult).reason?.message);
      continue;
    }
    const body = r.value;
    transactions += body.info?.transactionscount ?? 0;
    for (const s of body.above ?? []) {
      if (seen.has(s.satid)) continue;
      seen.add(s.satid);
      if (!s.satlat || !s.satlng) continue;
      sats.push({
        satid:   s.satid,
        satname: (s.satname || '').trim(),
        satlat:  Math.round(s.satlat * 10000) / 10000,
        satlng:  Math.round(s.satlng * 10000) / 10000,
        satalt:  Math.round(s.satalt ?? 0),
      });
    }
  }

  return { sats, transactions };
}

// ─── In-memory caches ─────────────────────────────────────────────────────────
const G = globalThis as unknown as {
  // N2YO
  n2yoSats:      N2YOSat[];
  n2yoCacheTime: number;
  n2yoTx:        number;
  // TLE bulk
  satCache:      any[];
  satCacheTime:  number;
  satSource:     string;
};
if (!G.n2yoSats)      { G.n2yoSats = []; G.n2yoCacheTime = 0; G.n2yoTx = 0; }
if (!G.satCache)      { G.satCache = [];  G.satCacheTime  = 0; G.satSource = ''; }

const SATNOGS_API      = 'https://db.satnogs.org/api/tle/?format=json';
const CELESTRAK_ACTIVE = 'https://celestrak.org/pub/TLE/active.tle';
const TLE_CACHE_MS     = 60 * 60 * 1000; // 1-hour TLE cache

export async function GET() {
  try {
    const nowMs    = Date.now();
    const n2yoKey  = process.env.N2YO_API_KEY;

    // ── 1. N2YO real-SGP4 positions ──────────────────────────────────────────
    let n2yoSats: N2YOSat[] = G.n2yoSats;
    let n2yoSource = '';

    if (n2yoKey) {
      if (n2yoSats.length === 0 || nowMs - G.n2yoCacheTime > N2YO_CACHE_MS) {
        try {
          const { sats, transactions } = await fetchN2YO(n2yoKey);
          if (sats.length > 0) {
            G.n2yoSats      = sats;
            G.n2yoCacheTime = nowMs;
            G.n2yoTx        = transactions;
            n2yoSats        = sats;
          }
          n2yoSource = `N2YO (${sats.length} sats, ${transactions} tx)`;
        } catch (err: any) {
          console.error('[OSIRIS/N2YO] Fetch error:', err?.message ?? err);
          n2yoSource = 'N2YO error — using cached positions';
        }
      } else {
        n2yoSource = `N2YO (cached, ${n2yoSats.length} sats)`;
      }
    } else {
      n2yoSource = 'N2YO disabled (set N2YO_API_KEY)';
    }

    // Build a fast NORAD-ID → N2YO position lookup
    const n2yoMap = new Map<number, N2YOSat>();
    for (const s of n2yoSats) n2yoMap.set(s.satid, s);

    // ── 2. TLE bulk (SatNOGS + CelesTrak) ────────────────────────────────────
    let tleSats: any[]  = G.satCache;
    let tleSource       = G.satSource || '';

    if (tleSats.length === 0 || nowMs - G.satCacheTime > TLE_CACHE_MS) {
      const [satnogsR, celestrakR] = await Promise.allSettled([
        stealthFetch(SATNOGS_API, {
          signal: AbortSignal.timeout(15000),
          headers: { 'Accept': 'application/json' },
        }).then(r => r.json() as Promise<any[]>),
        fetch(CELESTRAK_ACTIVE, {
          signal: AbortSignal.timeout(15000),
          headers: { 'User-Agent': 'OSIRIS/4' },
        }).then(r => r.text()),
      ]);

      const fetched: any[] = [];
      const seen = new Set<string>();
      const srcs: string[] = [];

      if (satnogsR.status === 'fulfilled') {
        for (const item of satnogsR.value) {
          const name = (item.tle0 || '').trim().replace(/^0\s+/, '');
          if (name && item.tle1 && item.tle2 && !seen.has(name)) {
            seen.add(name);
            fetched.push({ name, line1: item.tle1.trim(), line2: item.tle2.trim() });
          }
        }
        if (fetched.length) srcs.push('SatNOGS');
      } else {
        console.error('[OSIRIS/Satellites] SatNOGS:', satnogsR.reason);
      }

      if (celestrakR.status === 'fulfilled') {
        let ct = 0;
        for (const s of parseTleText(celestrakR.value)) {
          if (s.name && !seen.has(s.name)) { seen.add(s.name); fetched.push(s); ct++; }
        }
        if (ct) srcs.push(`CelesTrak (+${ct})`);
      }

      if (fetched.length > 0) {
        G.satCache     = fetched;
        G.satCacheTime = nowMs;
        G.satSource    = srcs.join(' + ');
        tleSats        = fetched;
        tleSource      = G.satSource;
      }
    }

    // Emergency fallback
    if (tleSats.length === 0) {
      const issFb = '1 25544U 98067A   24146.40251785  .00015505  00000-0  27885-3 0  9997\n2 25544  51.6402 189.7042 0004381 334.8091 106.8778 15.50091157455243';
      tleSats   = [{ name: 'ISS (FALLBACK)', line1: issFb.split('\n')[0], line2: issFb.split('\n')[1] }];
      tleSource = 'emergency-fallback';
    }

    // Sample for performance (max 2 000 from TLE bulk)
    const sampled = tleSats.length > 2000
      ? tleSats.filter((_: any, i: number) => i % Math.ceil(tleSats.length / 2000) === 0)
      : tleSats;

    // ── 3. Merge: N2YO positions take priority over local SGP4 ───────────────
    const satellites: any[] = [];

    // First: all N2YO-sourced satellites (accurate real-SGP4 positions)
    for (const s of n2yoSats) {
      const c = classifySatellite(s.satname);
      satellites.push({
        name:     s.satname,
        lat:      s.satlat,
        lng:      s.satlng,
        alt:      s.satalt,
        mission:  c.mission,
        color:    c.color,
        noradId:  String(s.satid),
        source:   'N2YO',
      });
    }

    // Then: TLE-derived positions for sats NOT already covered by N2YO
    for (const sat of sampled) {
      // Extract NORAD ID from TLE line1 (columns 3-7)
      const noradId = parseInt(sat.line1?.substring(2, 7)?.trim() ?? '', 10);
      if (!isNaN(noradId) && n2yoMap.has(noradId)) continue; // already added from N2YO

      const pos = propagateSGP4Simple(sat.line1, sat.line2);
      if (!pos) continue;
      const c = classifySatellite(sat.name);
      satellites.push({
        name:     sat.name,
        lat:      pos.lat,
        lng:      pos.lng,
        alt:      pos.alt,
        mission:  c.mission,
        color:    c.color,
        noradId:  isNaN(noradId) ? undefined : String(noradId),
        source:   'TLE',
      });
    }

    const cacheControl = satellites.length < 10
      ? 'no-store'
      : 'public, s-maxage=120, stale-while-revalidate=300';

    return NextResponse.json({
      satellites,
      total:      satellites.length,
      n2yo_count: n2yoSats.length,
      tle_count:  satellites.length - n2yoSats.length,
      n2yo_source: n2yoSource,
      tle_source:  tleSource,
      timestamp:  new Date().toISOString(),
    }, { headers: { 'Cache-Control': cacheControl } });

  } catch (error) {
    console.error('[OSIRIS/Satellites] Fatal:', error);
    return NextResponse.json({ satellites: [], error: 'Failed to fetch satellite data' }, { status: 500 });
  }
}
