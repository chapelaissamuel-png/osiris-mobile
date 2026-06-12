
import { NextResponse } from 'next/server';
import { stealthFetch } from '@/lib/stealthFetch';

/**
 * OSIRIS — Flight Data API
 *
 * Sources:
 *   1. adsb.lol — 6 regional queries, detailed data (type, registration, NACp)
 *   2. OpenSky Network (OPENSKY_USER + OPENSKY_PASS) — single global query,
 *      fills gaps in regions with sparse ADS-B coverage (Russia, Central Asia, Africa)
 *
 * Merge strategy: deduplicate by ICAO24 hex, adsb.lol data takes priority
 * (richer fields). OpenSky adds aircraft not visible in adsb.lol.
 */

const REGIONS = [
  { lat: 39.8, lon: -98.5, dist: 2000 },   // North America
  { lat: 50.0, lon: 15.0,  dist: 2000 },   // Europe
  { lat: 35.0, lon: 105.0, dist: 2000 },   // Asia
  { lat: -25.0, lon: 133.0, dist: 2000 },  // Australia
  { lat: 0.0,  lon: 20.0,  dist: 2500 },   // Africa
  { lat: -15.0, lon: -60.0, dist: 2000 },  // South America
];

// ─── Aircraft classification sets ─────────────────────────────────────────────
const HELI_TYPES = new Set([
  'R22','R44','R66','B06','B06T','B204','B205','B206','B212','B222','B230',
  'B407','B412','B427','B429','B430','B505','B525',
  'AS32','AS35','AS50','AS55','AS65',
  'EC20','EC25','EC30','EC35','EC45','EC55','EC75',
  'H125','H130','H135','H145','H155','H160','H175','H215','H225',
  'S55','S58','S61','S64','S70','S76','S92',
  'A109','A119','A139','A169','A189','AW09',
  'MD52','MD60','MDHI','MD90','NOTR',
  'B47G','HUEY','GAMA','CABR','EXE',
]);

const PRIVATE_JET_TYPES = new Set([
  'G150','G200','G280','GLEX','G500','G550','G600','G650','G700',
  'GLF2','GLF3','GLF4','GLF5','GLF6','GL5T','GL7T','GV','GIV',
  'CL30','CL35','CL60','BD70','BD10',
  'C25A','C25B','C25C','C500','C510','C525','C550','C560','C56X','C680','C700','C750',
  'E35L','E50P','E55P','E545','E550',
  'FA50','FA7X','FA8X','F900','F2TH',
  'LJ35','LJ40','LJ45','LJ60','LJ70','LJ75',
  'PC12','PC24','TBM7','TBM8','TBM9',
  'PRM1','SF50','EA50','VLJ',
]);

const MILITARY_INDICATORS = new Set([
  'C17','C5M','C130','C30J','KC10','KC46','KC35','E3CF','E3TF','E8A',
  'B1B','B2','B52','F16','F15','F18','F22','F35','A10','F117',
  'RC135','E6B','P8A','P3','MQ9','RQ4','U2','EP3','RC12',
  'V22','CH47','UH60','AH64','AH1Z','MV22',
  'EUFI','RFAL','TORD','TYP','GR4',
]);

const COMMERCIAL_TYPES = new Set([
  'A319','A320','A321','A332','A333','A339','A343','A359','A388',
  'B737','B738','B739','B38M','B39M','B752','B753','B763','B764','B772','B77L','B77W','B788','B789','B78X',
  'E170','E175','E190','E195','CRJ7','CRJ9','AT43','AT72','DH8D',
]);

const AIRLINE_CODE_RE = /^([A-Z]{3})\d/;

// ─── adsb.lol fetcher ─────────────────────────────────────────────────────────
async function fetchRegion(region: typeof REGIONS[0]): Promise<any[]> {
  try {
    const url = `https://api.adsb.lol/v2/lat/${region.lat}/lon/${region.lon}/dist/${region.dist}`;
    const res = await stealthFetch(url, { signal: AbortSignal.timeout(12000) });
    if (res.ok) return (await res.json()).ac || [];
  } catch (e) {
    console.warn(`[OSIRIS/Flights] adsb.lol region lat=${region.lat} failed:`, e);
  }
  return [];
}

// ─── OpenSky Network: global all-aircraft snapshot ────────────────────────────
//     With credentials: refreshes every 5s, global coverage, 4 000 req/day.
//     Returns states[] — each state is a fixed-index array (see below).
async function fetchOpenSky(user: string, pass: string): Promise<any[]> {
  const auth = Buffer.from(`${user}:${pass}`).toString('base64');
  const res  = await fetch('https://opensky-network.org/api/states/all', {
    signal:  AbortSignal.timeout(20000),
    headers: { Authorization: `Basic ${auth}`, 'User-Agent': 'OSIRIS-Intelligence-Platform/4' },
  });
  if (res.status === 401) throw new Error('OpenSky 401 — bad credentials');
  if (res.status === 429) throw new Error('OpenSky 429 — rate limited');
  if (!res.ok)            throw new Error(`OpenSky HTTP ${res.status}`);
  const body = await res.json();
  return body.states || [];
}

// Convert OpenSky state array → adsb.lol-compatible object
// State indices: 0=icao24, 1=callsign, 2=origin_country, 5=lon, 6=lat,
// 7=baro_alt_m, 8=on_ground, 9=velocity_ms, 10=true_track, 14=squawk
function openSkyToAdsbLol(state: any[]): any | null {
  const lat = state[6];
  const lon = state[5];
  if (lat == null || lon == null) return null;
  if (state[8] === true) return null; // on ground — skip

  const altMeters  = typeof state[7] === 'number' ? state[7] : 0;
  const altFeet    = altMeters / 0.3048;   // convert m → ft for classifyFlight
  const speedMs    = typeof state[9] === 'number' ? state[9] : null;
  const speedKnots = speedMs != null ? speedMs * 1.94384 : null;

  return {
    hex:      (state[0] || '').toLowerCase().trim(),
    flight:   (state[1] || '').trim(),
    lat,
    lon,
    alt_baro: altFeet,
    gs:       speedKnots,
    track:    state[10] ?? 0,
    squawk:   state[14] ?? '',
    t:        '',           // no aircraft type from OpenSky
    r:        'N/A',
    dbFlags:  0,
    nac_p:    null,
    _source:  'opensky',
    _country: state[2] || '',
  };
}

// ─── Flight classifier ─────────────────────────────────────────────────────────
function classifyFlight(f: any) {
  const modelUpper = (f.t || '').toUpperCase();
  const flightStr  = (f.flight || '').trim().toUpperCase();
  const dbFlags    = f.dbFlags || 0;

  if (modelUpper === 'TWR') return null;
  const lat = f.lat;
  const lon = f.lon;
  if (lat == null || lon == null) return null;

  const callsign   = flightStr || f.hex || 'UNKNOWN';
  const altRaw     = f.alt_baro;
  const altMeters  = typeof altRaw === 'number' ? altRaw * 0.3048 : 0;
  const speedKnots = typeof f.gs === 'number' ? Math.round(f.gs * 10) / 10 : null;
  const heading    = f.track || 0;
  const isHeli     = HELI_TYPES.has(modelUpper);
  const isGrounded = typeof altRaw === 'number' && altRaw < 100;

  const airlineMatch = AIRLINE_CODE_RE.exec(callsign);
  const airlineCode  = airlineMatch ? airlineMatch[1] : '';

  let category: 'commercial' | 'private' | 'jet' | 'military' = 'commercial';
  if (
    (dbFlags & 1) ||
    MILITARY_INDICATORS.has(modelUpper) ||
    /^(RCH|KING|DUKE|EVAC|JAKE|REACH|CONVOY)\d/i.test(f.flight || '')
  ) {
    category = 'military';
  } else if (PRIVATE_JET_TYPES.has(modelUpper)) {
    category = 'jet';
  } else if (!airlineCode && modelUpper && !COMMERCIAL_TYPES.has(modelUpper)) {
    category = 'private';
  }

  return {
    callsign,
    lat:              Math.round(lat * 100000) / 100000,
    lng:              Math.round(lon * 100000) / 100000,
    alt:              Math.round(altMeters),
    heading:          Math.round(heading),
    speed_knots:      speedKnots,
    model:            f.t || 'Unknown',
    icao24:           f.hex || '',
    registration:     f.r || 'N/A',
    squawk:           f.squawk || '',
    airline_code:     airlineCode,
    aircraft_category: isHeli ? 'heli' : 'plane',
    category,
    grounded:         isGrounded,
    nac_p:            f.nac_p,
    source:           f._source || 'adsb',
    type:             'flight',
  };
}

// ─── In-memory cache ───────────────────────────────────────────────────────────
let cachedData:    any         = null;
let lastFetchTime: number      = 0;
const CACHE_TTL                = 45000;
let fetchPromise: Promise<any> | null = null;

const JAMMING_NACAP_THRESHOLD = 4;

export async function GET() {
  const now = Date.now();

  if (cachedData && now - lastFetchTime < CACHE_TTL) {
    return NextResponse.json(cachedData, {
      headers: { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60' },
    });
  }
  if (fetchPromise) {
    try {
      const data = await fetchPromise;
      return NextResponse.json(data, { headers: { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60' } });
    } catch {
      return NextResponse.json({ error: 'Failed to fetch flight data' }, { status: 500 });
    }
  }

  fetchPromise = (async () => {
    // Resolve OpenSky credentials (support two naming conventions)
    const osUser = process.env.OPENSKY_USER ?? process.env.OPENSKY_USERNAME ?? '';
    const osPass = process.env.OPENSKY_PASS ?? process.env.OPENSKY_PASSWORD ?? '';

    // Kick off adsb.lol regions + OpenSky simultaneously
    const [regionResults, openSkyResult] = await Promise.allSettled([
      Promise.allSettled(REGIONS.map(r => fetchRegion(r))),
      osUser && osPass ? fetchOpenSky(osUser, osPass) : Promise.reject(new Error('no credentials')),
    ]);

    const seenHex = new Set<string>();
    const allRaw:  any[] = [];

    // 1. adsb.lol (priority — richer data)
    if (regionResults.status === 'fulfilled') {
      for (const r of regionResults.value) {
        if (r.status !== 'fulfilled') continue;
        for (const ac of r.value) {
          const hex = (ac.hex || '').toLowerCase().trim();
          if (hex && !seenHex.has(hex)) { seenHex.add(hex); allRaw.push(ac); }
        }
      }
    }

    // 2. OpenSky (gap-filler for under-covered regions)
    let openSkyCount = 0;
    if (openSkyResult.status === 'fulfilled') {
      for (const state of openSkyResult.value) {
        const hex = (state[0] || '').toLowerCase().trim();
        if (!hex || seenHex.has(hex)) continue;    // already have this from adsb.lol
        const converted = openSkyToAdsbLol(state);
        if (!converted) continue;
        seenHex.add(hex);
        allRaw.push(converted);
        openSkyCount++;
      }
    } else if (osUser && osPass) {
      console.warn('[OSIRIS/Flights] OpenSky failed:', (openSkyResult as PromiseRejectedResult).reason?.message);
    }

    // Classify
    const commercial: any[] = [];
    const privateFl:  any[] = [];
    const jets:       any[] = [];
    const military:   any[] = [];
    const gpsJamming: any[] = [];

    for (const raw of allRaw) {
      const flight = classifyFlight(raw);
      if (!flight) continue;

      if (
        typeof flight.nac_p === 'number' &&
        flight.nac_p <= JAMMING_NACAP_THRESHOLD &&
        !flight.grounded
      ) {
        gpsJamming.push({ lat: flight.lat, lng: flight.lng, nac_p: flight.nac_p, callsign: flight.callsign });
      }

      switch (flight.category) {
        case 'military':  military.push(flight);  break;
        case 'jet':       jets.push(flight);      break;
        case 'private':   privateFl.push(flight); break;
        default:          commercial.push(flight);
      }
    }

    return {
      commercial_flights: commercial,
      private_flights:    privateFl,
      private_jets:       jets,
      military_flights:   military,
      gps_jamming:        aggregateJamming(gpsJamming),
      total:              allRaw.length,
      opensky_added:      openSkyCount,
      timestamp:          new Date().toISOString(),
    };
  })();

  try {
    const data    = await fetchPromise;
    cachedData    = data;
    lastFetchTime = Date.now();
    fetchPromise  = null;

    const cc = data.total < 100
      ? 'no-store, max-age=0'
      : 'public, s-maxage=30, stale-while-revalidate=60';

    return NextResponse.json(data, { headers: { 'Cache-Control': cc } });
  } catch (error) {
    console.error('[OSIRIS/Flights] Fatal:', error);
    fetchPromise = null;
    return NextResponse.json({ error: 'Failed to fetch flight data' }, { status: 500 });
  }
}

function aggregateJamming(points: any[]) {
  if (!points.length) return [];
  const grid = new Map<string, { lat: number; lng: number; count: number; total_nac_p: number }>();
  const GRID  = 2;
  for (const p of points) {
    const gLat = Math.floor(p.lat / GRID) * GRID;
    const gLng = Math.floor(p.lng / GRID) * GRID;
    const key  = `${gLat},${gLng}`;
    if (!grid.has(key)) grid.set(key, { lat: gLat + GRID / 2, lng: gLng + GRID / 2, count: 0, total_nac_p: 0 });
    const cell = grid.get(key)!;
    cell.count++;
    cell.total_nac_p += p.nac_p;
  }
  return Array.from(grid.values())
    .filter(z => z.count >= 3)
    .map(z => ({
      lat:      z.lat,
      lng:      z.lng,
      severity: Math.round((1 - (z.total_nac_p / z.count) / JAMMING_NACAP_THRESHOLD) * 100),
      count:    z.count,
    }));
}
