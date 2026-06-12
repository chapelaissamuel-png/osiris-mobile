
import { NextResponse } from 'next/server';
import { ingestSignals } from '@/lib/focal-points';
import { updateBaseline } from '@/lib/temporal-anomalies';

/**
 * OSIRIS — Earthquake & Seismic Events
 *
 * Source hierarchy (all free, no API key):
 *   1. USGS   — primary global catalogue, M2.5+ last 24h
 *   2. GDACS  — UN/EU disaster overlay: Orange + Red alert earthquakes with impact data
 *   3. EMSC   — European Mediterranean Seismological Centre backup (M3.5+, Europe/MENA)
 *
 * GDACS adds "alert level" (Orange/Red) and population-impact estimates
 * that USGS omits — critical for distinguishing minor seismic events
 * from actual humanitarian disasters.
 */

interface EqEvent {
  id:           string;
  lat:          number;
  lng:          number;
  depth:        number;
  magnitude:    number;
  place:        string;
  time:         number;   // epoch ms
  url:          string;
  tsunami:      number;
  type:         string;
  felt:         number | null;
  alert:        string | null;
  gdacs_alert?: 'Orange' | 'Red';
  gdacs_impact?:string;
  source:       'usgs' | 'emsc' | 'gdacs';
}

// ─── USGS ─────────────────────────────────────────────────────────────────────
async function fetchUSGS(): Promise<EqEvent[]> {
  const res = await fetch(
    'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson',
    { signal: AbortSignal.timeout(12000), cache: 'no-store' }
  );
  if (!res.ok) throw new Error(`USGS HTTP ${res.status}`);
  const data = await res.json();
  return (data.features || []).map((f: any): EqEvent => {
    const c = f.geometry?.coordinates || [0, 0, 0];
    const p = f.properties || {};
    return {
      id: f.id, lat: c[1], lng: c[0], depth: c[2],
      magnitude: p.mag, place: p.place,
      time: p.time, url: p.url,
      tsunami: p.tsunami || 0, type: p.type || 'earthquake',
      felt: p.felt ?? null, alert: p.alert ?? null,
      source: 'usgs',
    };
  });
}

// ─── GDACS — UN/EU disaster alert overlay ─────────────────────────────────────
async function fetchGDACS(): Promise<EqEvent[]> {
  const url = 'https://www.gdacs.org/gdacsapi/api/events/geteventlist/EVENTS?eventtype=EQ&alertlevel=Orange,Red&limit=30';
  const res = await fetch(url, {
    signal: AbortSignal.timeout(10000),
    headers: { Accept: 'application/json', 'User-Agent': 'OSIRIS-Intelligence/4' },
  });
  if (!res.ok) return [];
  const data = await res.json();
  return ((data?.features ?? []) as any[]).map((f): EqEvent | null => {
    const p = f.properties ?? {};
    const geom = f.geometry;
    if (!geom?.coordinates) return null;
    // GDACS geometry can be a point or multi-point
    const coords = Array.isArray(geom.coordinates[0])
      ? geom.coordinates[0]
      : geom.coordinates;
    const [lng, lat] = coords;
    if (lat == null || lng == null) return null;
    return {
      id:           `gdacs-${p.eventid ?? Math.random()}`,
      lat:          parseFloat(lat),
      lng:          parseFloat(lng),
      depth:        parseFloat(p.depthkm ?? 0),
      magnitude:    parseFloat(p.severitydata?.severity ?? p.magnitude ?? 0),
      place:        p.eventname ?? p.country ?? 'Unknown',
      time:         new Date(p.fromdate ?? p.todate ?? Date.now()).getTime(),
      url:          p.url?.report ?? '',
      tsunami:      0, type: 'earthquake',
      felt:         null, alert: (p.alertlevel ?? '').toLowerCase(),
      gdacs_alert:  p.alertlevel as 'Orange' | 'Red',
      gdacs_impact: p.severitydata?.severitytext ?? p.population ?? '',
      source:       'gdacs',
    };
  }).filter(Boolean) as EqEvent[];
}

// ─── EMSC — European Mediterranean Seismological Centre ───────────────────────
async function fetchEMSC(): Promise<EqEvent[]> {
  const url = 'https://www.seismicportal.eu/fdsnws/event/1/query?format=json&limit=80&minmagnitude=3.5&orderby=time';
  const res = await fetch(url, {
    signal: AbortSignal.timeout(12000),
    headers: { 'User-Agent': 'OSIRIS-Intelligence/4' },
    cache: 'no-store',
  });
  if (!res.ok) return [];
  const data = await res.json();
  return (data.features ?? []).map((f: any): EqEvent => {
    const p = f.properties ?? {};
    const c = f.geometry?.coordinates ?? [0, 0, 0];
    return {
      id:        `emsc-${p.unid ?? f.id}`,
      lat:       c[1], lng: c[0], depth: Math.abs(c[2] ?? 0),
      magnitude: parseFloat(p.mag ?? 0),
      place:     p.flynn_region ?? p.place ?? 'Unknown',
      time:      new Date(p.time ?? Date.now()).getTime(),
      url:       `https://www.seismicportal.eu/eventdetails.html?unid=${p.unid}`,
      tsunami:   0, type: 'earthquake',
      felt:      null, alert: null,
      source:    'emsc',
    };
  });
}

// ─── Deduplicate by proximity + time ─────────────────────────────────────────
function dedup(events: EqEvent[]): EqEvent[] {
  const out: EqEvent[] = [];
  outer: for (const ev of events) {
    for (const s of out) {
      const dlat  = Math.abs(ev.lat  - s.lat);
      const dlng  = Math.abs(ev.lng  - s.lng);
      const dtms  = Math.abs(ev.time - s.time);
      if (dlat < 0.5 && dlng < 0.5 && dtms < 5 * 60 * 1000) {
        // Merge GDACS alert data into the existing event
        if (ev.source === 'gdacs') {
          s.gdacs_alert  = ev.gdacs_alert;
          s.gdacs_impact = ev.gdacs_impact;
          if (!s.alert) s.alert = ev.alert;
        }
        continue outer;
      }
    }
    out.push({ ...ev });
  }
  return out;
}

export async function GET() {
  try {
    const [usgsRes, gdacsRes, emscRes] = await Promise.allSettled([
      fetchUSGS(),
      fetchGDACS(),
      fetchEMSC(),
    ]);

    const usgs  = usgsRes.status  === 'fulfilled' ? usgsRes.value  : [];
    const gdacs = gdacsRes.status === 'fulfilled' ? gdacsRes.value : [];
    const emsc  = emscRes.status  === 'fulfilled' ? emscRes.value  : [];

    if (usgsRes.status  === 'rejected') console.warn('[OSIRIS/EQ] USGS:',  (usgsRes.reason as Error)?.message);
    if (gdacsRes.status === 'rejected') console.warn('[OSIRIS/EQ] GDACS:', (gdacsRes.reason as Error)?.message);
    if (emscRes.status  === 'rejected') console.warn('[OSIRIS/EQ] EMSC:',  (emscRes.reason as Error)?.message);

    // USGS primary → GDACS enriches with alert levels → EMSC fills coverage gaps
    const merged = dedup([...usgs, ...gdacs, ...emsc]);
    merged.sort((a, b) => b.time - a.time);

    const sources = [
      usgs.length  > 0 ? `USGS (${usgs.length})`  : null,
      gdacs.length > 0 ? `GDACS (${gdacs.length} Orange/Red)` : null,
      emsc.length  > 0 ? `EMSC (${emsc.length})`  : null,
    ].filter(Boolean).join(' + ');

    // Feed focal-point & anomaly engines (fire-and-forget)
    try {
      const signals = merged
        .filter((e: any) => e.lat != null && e.lng != null)
        .map((e: any) => ({
          lat:       e.lat,
          lng:       e.lng,
          type:      'earthquake' as const,
          severity:  Math.min(10, Math.round(e.magnitude ?? 5)),
          timestamp: e.time ?? Date.now(),
        }));
      ingestSignals(signals);
      updateBaseline('earthquakes', 'global', merged.length);
    } catch { /* non-critical */ }

    return NextResponse.json(
      { earthquakes: merged, total: merged.length, breakdown: { usgs: usgs.length, gdacs: gdacs.length, emsc: emsc.length }, sources, timestamp: new Date().toISOString() },
      { headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120' } }
    );
  } catch (error) {
    console.error('[OSIRIS/EQ] Fatal:', error);
    return NextResponse.json({ earthquakes: [], error: 'Failed to fetch earthquake data' }, { status: 500 });
  }
}
