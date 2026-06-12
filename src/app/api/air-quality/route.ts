import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * OSIRIS — Air Quality Monitoring API
 * Primary:  OpenAQ v3 (requires free key from openaq.org → OPENAQ_API_KEY)
 * Fallback: OpenAQ v2 (deprecated but still functional, no key)
 * Data: PM2.5 measurements worldwide (WHO/EPA scale AQI)
 */

function classifyPm25(val: number): { level: string; color: string } {
  if (val > 150) return { level: 'Hazardous',             color: '#8B0000' };
  if (val > 100) return { level: 'Unhealthy',             color: '#FF1744' };
  if (val > 55)  return { level: 'Unhealthy (Sensitive)', color: '#FF9500' };
  if (val > 35)  return { level: 'Moderate',              color: '#FFD700' };
  return               { level: 'Good',                   color: '#00E676' };
}

async function fetchOpenAQv3(apiKey: string): Promise<any[]> {
  const res = await fetch(
    'https://api.openaq.org/v3/measurements?limit=1000&parameters_id=2&order_by=datetime&sort_order=desc',
    {
      signal: AbortSignal.timeout(12000),
      headers: {
        'Accept': 'application/json',
        'X-API-Key': apiKey,
      },
    }
  );
  if (!res.ok) throw new Error(`OpenAQ v3 HTTP ${res.status}`);
  const data = await res.json();
  const stations: any[] = [];
  const seen = new Set<string>();

  for (const m of data.results || []) {
    const lat = m.coordinates?.latitude;
    const lng = m.coordinates?.longitude;
    if (!lat || !lng || isNaN(lat) || isNaN(lng)) continue;
    const val = m.value;
    if (typeof val !== 'number' || val < 0 || val > 2000) continue;

    const key = `${Math.round(lat * 10)},${Math.round(lng * 10)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const { level, color } = classifyPm25(val);
    stations.push({
      id:          `aqv3-${m.sensors_id || m.id}`,
      name:        m.locationName || `Station #${m.sensors_id}`,
      city:        m.locationName || '',
      country:     m.country || '',
      lat,
      lng,
      pm25:        Math.round(val * 10) / 10,
      unit:        'µg/m³',
      level,
      color,
      lastUpdated: m.datetime?.utc || '',
      source:      'OpenAQ v3',
    });
  }
  return stations;
}

async function fetchOpenAQv2(): Promise<any[]> {
  const res = await fetch(
    'https://api.openaq.org/v2/latest?limit=500&parameter=pm25&order_by=lastUpdated&sort=desc',
    {
      signal: AbortSignal.timeout(12000),
      headers: { 'Accept': 'application/json' },
    }
  );
  if (!res.ok) throw new Error(`OpenAQ v2 HTTP ${res.status}`);
  const data = await res.json();
  const stations: any[] = [];

  for (const loc of data.results || []) {
    const lat = loc.coordinates?.latitude;
    const lng = loc.coordinates?.longitude;
    if (!lat || !lng) continue;
    const pm25 = loc.measurements?.find((m: any) => m.parameter === 'pm25');
    if (!pm25 || typeof pm25.value !== 'number') continue;

    const { level, color } = classifyPm25(pm25.value);
    stations.push({
      id:          `aqv2-${loc.location}`,
      name:        loc.location,
      city:        loc.city || 'Unknown',
      country:     loc.country,
      lat,
      lng,
      pm25:        Math.round(pm25.value * 10) / 10,
      unit:        pm25.unit || 'µg/m³',
      level,
      color,
      lastUpdated: pm25.lastUpdated,
      source:      'OpenAQ v2',
    });
  }
  return stations;
}

export async function GET() {
  const apiKey = process.env.OPENAQ_API_KEY;
  let stations: any[] = [];
  let source = '';

  if (apiKey) {
    try {
      stations = await fetchOpenAQv3(apiKey);
      source = 'OpenAQ v3';
    } catch (err) {
      console.error('[OSIRIS/AQ] OpenAQ v3 failed, falling back to v2:', err);
    }
  }

  if (stations.length === 0) {
    try {
      stations = await fetchOpenAQv2();
      source = 'OpenAQ v2 (deprecated — set OPENAQ_API_KEY for v3)';
    } catch (err) {
      console.error('[OSIRIS/AQ] OpenAQ v2 also failed:', err);
    }
  }

  return NextResponse.json(
    {
      stations,
      total:     stations.length,
      source:    source || 'unavailable',
      timestamp: new Date().toISOString(),
      ...(stations.length === 0 ? { error: 'Both OpenAQ v3 and v2 unavailable' } : {}),
    },
    {
      headers: {
        'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600',
      },
    }
  );
}
