
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * OSIRIS — Global Conflict Frontlines
 *
 * Ukraine:       DeepStateMap live GeoJSON (open, no key)
 * Other conflicts: ACLED API (free researcher key → ACLED_KEY + ACLED_EMAIL)
 *                  Covers: Sudan, Myanmar, Gaza, Yemen, Haiti, DRC...
 *
 * Without ACLED creds, only Ukraine data is returned.
 */

// ACLED conflict zones to monitor (country names as ACLED accepts them)
const ACLED_COUNTRIES = [
  'Sudan', 'South Sudan', 'Myanmar', 'Gaza Strip', 'Yemen',
  'Mali', 'Burkina Faso', 'Haiti', 'Democratic Republic of Congo',
  'Somalia', 'Ethiopia', 'Syria',
];

// Color per conflict zone
const CONFLICT_COLORS: Record<string, string> = {
  'Sudan':                          '#FF6B35',
  'South Sudan':                    '#FF8C42',
  'Myanmar':                        '#E63946',
  'Gaza Strip':                     '#FF1744',
  'Yemen':                          '#FF9F1C',
  'Mali':                           '#F4A261',
  'Burkina Faso':                   '#E76F51',
  'Haiti':                          '#9D4EDD',
  'Democratic Republic of Congo':   '#2196F3',
  'Somalia':                        '#FF5722',
  'Ethiopia':                       '#FF7043',
  'Syria':                          '#B71C1C',
};

// ─── DeepStateMap — Ukraine ───────────────────────────────────────────────────
async function fetchDeepState(): Promise<any> {
  const res = await fetch('https://deepstatemap.live/api/history/last', {
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`DeepState HTTP ${res.status}`);
  return res.json();
}

// ─── ACLED — Multi-conflict incidents ────────────────────────────────────────
async function fetchAcled(key: string, email: string): Promise<any[]> {
  const country = ACLED_COUNTRIES.join('|');
  const url = new URL('https://api.acleddata.com/acled/read.php');
  url.searchParams.set('key',           key);
  url.searchParams.set('email',         email);
  url.searchParams.set('country',       country);
  url.searchParams.set('limit',         '500');
  url.searchParams.set('event_date',    getDateNDaysAgo(30));
  url.searchParams.set('event_date_where', 'BETWEEN');
  url.searchParams.set('event_date2',   getTodayDate());
  url.searchParams.set('fields',        'event_date|event_type|sub_event_type|latitude|longitude|location|country|fatalities|notes|source');
  url.searchParams.set('format',        'json');

  const res = await fetch(url.toString(), {
    signal: AbortSignal.timeout(15000),
    headers: { 'Accept': 'application/json' },
  });
  if (!res.ok) throw new Error(`ACLED HTTP ${res.status}`);
  const data = await res.json();
  return data.data || data.results || [];
}

function getDateNDaysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10).replace(/-/g, '/');
}

function getTodayDate(): string {
  return new Date().toISOString().slice(0, 10).replace(/-/g, '/');
}

function acledToGeoJSON(incidents: any[]): any {
  const features = incidents
    .filter(inc => inc.latitude && inc.longitude)
    .map(inc => {
      const country = inc.country || 'Unknown';
      return {
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: [parseFloat(inc.longitude), parseFloat(inc.latitude)],
        },
        properties: {
          source:     'ACLED',
          country,
          location:   inc.location || '',
          event_type: inc.event_type || '',
          sub_event:  inc.sub_event_type || '',
          date:       inc.event_date || '',
          fatalities: parseInt(inc.fatalities ?? '0', 10),
          notes:      (inc.notes || '').substring(0, 300),
          sourceName: inc.source || '',
          color:      CONFLICT_COLORS[country] || '#FF9500',
        },
      };
    });

  return {
    type: 'FeatureCollection',
    features,
  };
}

export async function GET() {
  const acledKey   = process.env.ACLED_KEY;
  const acledEmail = process.env.ACLED_EMAIL;

  const [deepStateResult, acledResult] = await Promise.allSettled([
    fetchDeepState(),
    acledKey && acledEmail
      ? fetchAcled(acledKey, acledEmail)
      : Promise.reject(new Error('ACLED_KEY or ACLED_EMAIL not set')),
  ]);

  const response: Record<string, any> = {
    timestamp: new Date().toISOString(),
    sources:   [],
  };

  // Ukraine frontline (GeoJSON polygon)
  if (deepStateResult.status === 'fulfilled') {
    response.frontlines = deepStateResult.value;
    response.sources.push('DeepStateMap (Ukraine)');
  } else {
    console.error('[OSIRIS/Frontlines] DeepState error:', deepStateResult.reason);
    response.frontlines = null;
    response.frontlines_error = 'DeepStateMap unavailable';
  }

  // ACLED multi-conflict incidents
  if (acledResult.status === 'fulfilled') {
    const incidents = acledResult.value;
    response.acled_incidents   = acledToGeoJSON(incidents);
    response.acled_total       = incidents.length;
    response.acled_countries   = ACLED_COUNTRIES;
    response.sources.push(`ACLED (${incidents.length} incidents, ${ACLED_COUNTRIES.length} zones)`);
  } else {
    response.acled_incidents   = null;
    response.acled_total       = 0;
    if (acledKey && acledEmail) {
      console.error('[OSIRIS/Frontlines] ACLED error:', acledResult.reason);
      response.acled_error = 'ACLED API unavailable';
    } else {
      response.acled_note = 'Set ACLED_KEY + ACLED_EMAIL for multi-conflict coverage (free at acleddata.com)';
    }
  }

  return NextResponse.json(response, {
    headers: {
      'Cache-Control': 'public, s-maxage=1800, stale-while-revalidate=3600',
    },
  });
}
