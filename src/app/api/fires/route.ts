
import { NextResponse } from 'next/server';
import { ingestSignals } from '@/lib/focal-points';
import { updateBaseline } from '@/lib/temporal-anomalies';

export const dynamic = 'force-dynamic';

/**
 * OSIRIS — Active Fire & Wildfire Tracking
 *
 * Source hierarchy:
 *   1. NASA FIRMS NRT  (FIRMS_MAP_KEY)  — VIIRS Near-Real-Time, ~3 h delay, 30-min updates
 *   2. NASA FIRMS open CSV             — VIIRS Suomi-NPP C2, no key, ~24 h delay
 *   3. NASA FIRMS MODIS open CSV       — MODIS C6.1, no key, ~24 h delay
 *   4. NASA EONET                      — active volcanoes + mega-fire events (always appended)
 *
 * Key envvar: FIRMS_MAP_KEY  (or FIRMS_API_KEY as alias)
 * NRT endpoint: /api/area/csv/{key}/VIIRS_SNPP_NRT/world/1
 */

// ─── CSV parser ────────────────────────────────────────────────────────────────
function parseFireCSV(text: string): any[] {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return [];
  const headers = lines[0].toLowerCase().split(',').map(h => h.trim().replace(/"/g, ''));
  const latIdx        = headers.indexOf('latitude');
  const lngIdx        = headers.indexOf('longitude');
  if (latIdx === -1 || lngIdx === -1) return [];

  const brightnessIdx = headers.findIndex(h => h.includes('bright'));
  const confIdx       = headers.indexOf('confidence');
  const frpIdx        = headers.indexOf('frp');
  const dateIdx       = headers.indexOf('acq_date');
  const timeIdx       = headers.indexOf('acq_time');
  const daynightIdx   = headers.indexOf('daynight');
  const satIdx        = headers.indexOf('satellite');

  const fires: any[] = [];
  for (let i = 1; i < Math.min(lines.length, 3001); i++) {
    const cols = lines[i].split(',');
    const lat  = parseFloat(cols[latIdx]);
    const lng  = parseFloat(cols[lngIdx]);
    if (isNaN(lat) || isNaN(lng)) continue;
    fires.push({
      lat,
      lng,
      brightness: brightnessIdx >= 0 ? (parseFloat(cols[brightnessIdx]) || 0) : 0,
      confidence: confIdx     >= 0 ? (cols[confIdx]  || '').replace(/"/g, '').trim() : '',
      frp:        frpIdx      >= 0 ? (parseFloat(cols[frpIdx]) || 0) : 0,
      date:       dateIdx     >= 0 ? (cols[dateIdx]  || '').replace(/"/g, '') : '',
      time:       timeIdx     >= 0 ? (cols[timeIdx]  || '').replace(/"/g, '') : '',
      daynight:   daynightIdx >= 0 ? (cols[daynightIdx] || '').replace(/"/g, '').trim() : '',
      satellite:  satIdx      >= 0 ? (cols[satIdx]   || '').replace(/"/g, '').trim() : '',
    });
  }
  return fires;
}

// ─── FIRMS NRT (requires MAP_KEY) ─────────────────────────────────────────────
async function fetchFIRMS_NRT(mapKey: string): Promise<{ fires: any[]; source: string }> {
  // FIRMS key is placed in the URL path — not a query param
  const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${encodeURIComponent(mapKey)}/VIIRS_SNPP_NRT/world/1`;
  const res = await fetch(url, {
    signal:  AbortSignal.timeout(25000),
    headers: { 'User-Agent': 'OSIRIS-Intelligence-Platform/4' },
  });
  if (!res.ok) throw new Error(`FIRMS NRT HTTP ${res.status}`);
  const text = await res.text();
  // Error responses look like JSON or "No data" text
  if (!text.includes('latitude')) throw new Error(`FIRMS NRT invalid response (${text.substring(0, 80)})`);
  const fires = parseFireCSV(text);
  if (fires.length === 0) throw new Error('FIRMS NRT: parsed 0 fires');
  return { fires, source: `NASA FIRMS NRT — VIIRS Suomi-NPP (${fires.length} detections, ~3 h delay)` };
}

// ─── FIRMS open CSV (24h static, no key) ──────────────────────────────────────
async function fetchFIRMS_Open(): Promise<{ fires: any[]; source: string }> {
  const sources = [
    {
      url:  'https://firms.modaps.eosdis.nasa.gov/data/active_fire/suomi-npp-viirs-c2/csv/SUOMI_VIIRS_C2_Global_24h.csv',
      name: 'NASA FIRMS 24h — VIIRS C2 (open)',
    },
    {
      url:  'https://firms.modaps.eosdis.nasa.gov/data/active_fire/modis-c6.1/csv/MODIS_C6_1_Global_24h.csv',
      name: 'NASA FIRMS 24h — MODIS C6.1 (open)',
    },
  ];
  for (const { url, name } of sources) {
    try {
      const res = await fetch(url, {
        signal:  AbortSignal.timeout(20000),
        headers: { 'User-Agent': 'OSIRIS-Intelligence-Platform/4' },
      });
      if (!res.ok) continue;
      const text = await res.text();
      if (!text.includes('latitude') || text.length < 200) continue;
      const fires = parseFireCSV(text);
      if (fires.length > 0) return { fires, source: name };
    } catch { continue; }
  }
  throw new Error('All open FIRMS sources failed');
}

// ─── EONET volcanoes + mega-fires (always appended) ───────────────────────────
async function fetchEONET(): Promise<any[]> {
  const res = await fetch(
    'https://eonet.gsfc.nasa.gov/api/v3/events?status=open&category=volcanoes,wildfires&limit=60',
    { signal: AbortSignal.timeout(10000) }
  );
  if (!res.ok) return [];
  const data = await res.json();
  return (data.events || []).map((e: any) => {
    const geo = e.geometry?.[e.geometry.length - 1];
    if (!geo?.coordinates) return null;
    const isVolcano = e.categories?.some((c: any) => c.id === 'volcanoes');
    return {
      lat:        geo.coordinates[1],
      lng:        geo.coordinates[0],
      brightness: isVolcano ? 500 : 400,
      confidence: 'high',
      frp:        isVolcano ? 100 : 50,
      date:       (geo.date || '').split('T')[0],
      time:       '',
      daynight:   '',
      satellite:  'EONET',
      title:      `[${isVolcano ? 'VOLCANO' : 'MAJOR FIRE'}] ${e.title}`,
      type:       isVolcano ? 'volcano' : 'wildfire',
    };
  }).filter(Boolean);
}

// ─── In-memory cache (per-isolate) ────────────────────────────────────────────
interface FireCache { fires: any[]; source: string; at: number; }
const G = globalThis as unknown as { _osirisFireCache: FireCache | null };
if (!G._osirisFireCache) G._osirisFireCache = null;

const NRT_TTL  = 30 * 60 * 1000;   // 30 min — FIRMS NRT refreshes every ~30 min
const OPEN_TTL = 60 * 60 * 1000;   // 60 min — open CSV is 24 h static

export async function GET() {
  try {
    const firmsKey = process.env.FIRMS_MAP_KEY ?? process.env.FIRMS_API_KEY;
    const ttl      = firmsKey ? NRT_TTL : OPEN_TTL;
    const now      = Date.now();

    if (G._osirisFireCache && G._osirisFireCache.fires.length > 0 && now - G._osirisFireCache.at < ttl) {
      const c = G._osirisFireCache;
      return NextResponse.json({
        fires: c.fires, total: c.fires.length, source: c.source + ' (cached)', timestamp: new Date().toISOString(),
      }, { headers: { 'Cache-Control': 'public, s-maxage=600, stale-while-revalidate=1200' } });
    }

    let fires:  any[]  = [];
    let source: string = '';

    // 1. FIRMS NRT (if key available)
    if (firmsKey) {
      try {
        const r = await fetchFIRMS_NRT(firmsKey);
        fires  = r.fires;
        source = r.source;
      } catch (e: any) {
        console.warn('[OSIRIS/Fires] FIRMS NRT failed, trying open CSV:', e.message);
      }
    }

    // 2. Open CSV fallback
    if (fires.length === 0) {
      try {
        const r = await fetchFIRMS_Open();
        fires  = r.fires;
        source = r.source;
      } catch (e: any) {
        console.warn('[OSIRIS/Fires] Open CSV failed:', e.message);
      }
    }

    // 3. EONET always appended
    try {
      const volc = await fetchEONET();
      if (volc.length > 0) {
        fires  = [...fires, ...volc];
        source = (source ? source + ' + ' : '') + `EONET (${volc.length} events)`;
      }
    } catch { /* non-fatal */ }

    if (fires.length > 0) {
      G._osirisFireCache = { fires: fires.slice(0, 3000), source, at: now };
    }

    // Feed focal-point & anomaly engines (fire-and-forget)
    try {
      const signals = fires.slice(0, 3000)
        .filter((f: any) => f.lat != null && f.lng != null)
        .map((f: any) => ({
          lat:       f.lat,
          lng:       f.lng,
          type:      'fire' as const,
          severity:  Math.min(10, Math.round((f.frp ?? 50) / 50)),
          timestamp: Date.now(),
        }));
      ingestSignals(signals);
      updateBaseline('fires', 'global', fires.length);
    } catch { /* non-critical */ }

    return NextResponse.json({
      fires:     fires.slice(0, 3000),
      total:     fires.length,
      source:    source || 'no data',
      nrt:       !!firmsKey,
      timestamp: new Date().toISOString(),
    }, { headers: { 'Cache-Control': 'public, s-maxage=600, stale-while-revalidate=1200' } });

  } catch (error) {
    console.error('[OSIRIS/Fires] Fatal:', error);
    return NextResponse.json({ fires: [], error: 'Failed to fetch fire data' }, { status: 500 });
  }
}
