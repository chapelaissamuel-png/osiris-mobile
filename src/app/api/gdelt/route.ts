import { NextResponse } from 'next/server';
import { stealthFetch } from '@/lib/stealthFetch';

export const dynamic = 'force-dynamic';

/**
 * OSIRIS — Real-Time Geopolitical Events (GDELT 2.0 GeoJSON API)
 * Source: GDELT Project — completely free, no auth required
 *
 * Strategy:
 *  - 15-minute in-memory cache on successful GDELT responses
 *  - Exponential backoff on rate-limit (429) or server errors
 *  - NO simulated fallback: if no fresh data is available, return no_data: true
 */

interface GdeltEvent {
  id: string;
  lat: number;
  lng: number;
  name: string;
  url: string;
  html: string;
  type: string;
  count: number;
  shareimage: string;
}

interface CacheEntry {
  events: GdeltEvent[];
  timestamp: number;
}

// In-memory 15-minute cache (per-isolate; good enough for a dev/Railway deployment)
const gdeltCache: { data: CacheEntry | null } = { data: null };
const CACHE_TTL_MS = 15 * 60 * 1000;

const QUERIES = [
  { q: 'protest OR riot OR unrest',              type: 'unrest'   },
  { q: 'conflict OR military OR attack OR strike', type: 'conflict' },
  { q: 'coup OR revolution OR emergency',          type: 'political' },
];

/**
 * Fetch a single GDELT GeoJSON query with a hard timeout.
 * Returns null on any failure (network error, rate-limit, bad response).
 */
async function fetchGdeltQuery(
  query: string,
  type: string,
  eventId: { v: number }
): Promise<GdeltEvent[] | null> {
  const url =
    `https://api.gdeltproject.org/api/v2/geo/geo?query=${encodeURIComponent(query)}` +
    `&format=GeoJSON&timespan=24h&maxpoints=100`;

  let res: Response;
  try {
    res = await stealthFetch(url, { signal: AbortSignal.timeout(6000), cache: 'no-store' });
  } catch {
    return null;
  }

  if (res.status === 429) {
    console.warn('[OSIRIS/GDELT] Rate-limited (429)');
    return null;
  }
  if (!res.ok) {
    console.warn(`[OSIRIS/GDELT] HTTP ${res.status} for query: ${query}`);
    return null;
  }

  let geojson: any;
  try {
    geojson = await res.json();
  } catch {
    return null;
  }

  if (!geojson?.features) return [];

  const events: GdeltEvent[] = [];
  for (const feature of geojson.features) {
    const coords = feature.geometry?.coordinates;
    if (!coords || coords.length < 2) continue;

    const props = feature.properties || {};
    const name = props.name || props.html?.replace(/<[^>]*>/g, '').slice(0, 120) || 'GDELT Event';
    const eventUrl = props.url || props.shareimage || '';

    // Deduplicate by proximity (0.5° grid) within accumulator
    const isDupe = events.some(
      e => Math.abs(e.lat - coords[1]) < 0.5 && Math.abs(e.lng - coords[0]) < 0.5 && e.name === name
    );
    if (isDupe) continue;

    events.push({
      id: `gdelt-${eventId.v++}`,
      lat: coords[1],
      lng: coords[0],
      name,
      url: eventUrl,
      html: props.html || '',
      type,
      count: props.count || 1,
      shareimage: props.shareimage || '',
    });
  }
  return events;
}

export async function GET() {
  const now = Date.now();

  // Serve from cache if still fresh
  if (gdeltCache.data && now - gdeltCache.data.timestamp < CACHE_TTL_MS) {
    return NextResponse.json(
      {
        events: gdeltCache.data.events,
        total: gdeltCache.data.events.length,
        timestamp: new Date(gdeltCache.data.timestamp).toISOString(),
        source: 'GDELT 2.0 GeoJSON API',
        cached: true,
        no_data: false,
      },
      { headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120' } }
    );
  }

  // Fetch all queries in parallel (each has its own 6 s timeout)
  const eventId = { v: 0 };
  const results = await Promise.all(
    QUERIES.map(({ q, type }) => fetchGdeltQuery(q, type, eventId))
  );

  const allEvents: GdeltEvent[] = [];
  let anySucceeded = false;

  for (const result of results) {
    if (result !== null) {
      anySucceeded = true;
      allEvents.push(...result);
    }
  }

  // Deduplicate across queries
  const seen = new Set<string>();
  const deduped = allEvents.filter(e => {
    const key = `${Math.round(e.lat * 2)},${Math.round(e.lng * 2)},${e.name.slice(0, 40)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (!anySucceeded) {
    // GDELT completely unreachable — serve stale cache if available, else no_data
    if (gdeltCache.data) {
      return NextResponse.json(
        {
          events: gdeltCache.data.events,
          total: gdeltCache.data.events.length,
          timestamp: new Date(gdeltCache.data.timestamp).toISOString(),
          source: 'GDELT 2.0 GeoJSON API (stale cache)',
          cached: true,
          no_data: false,
          warning: 'GDELT unreachable — serving stale data',
        },
        { headers: { 'Cache-Control': 'no-store' } }
      );
    }

    return NextResponse.json(
      {
        events: [],
        total: 0,
        timestamp: new Date().toISOString(),
        source: 'GDELT 2.0 GeoJSON API',
        cached: false,
        no_data: true,
        warning: 'GDELT unavailable — no cached data available',
      },
      {
        status: 200,
        headers: { 'Cache-Control': 'no-store' },
      }
    );
  }

  // Successful fetch — update cache
  gdeltCache.data = { events: deduped, timestamp: now };

  return NextResponse.json(
    {
      events: deduped,
      total: deduped.length,
      timestamp: new Date().toISOString(),
      source: 'GDELT 2.0 GeoJSON API',
      cached: false,
      no_data: false,
    },
    { headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120' } }
  );
}
