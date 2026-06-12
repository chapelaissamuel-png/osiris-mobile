import { NextResponse } from 'next/server';

/**
 * OSIRIS — Live News Feeds v4
 * embed_allowed: true  → can be iframed directly
 * embed_allowed: false → YouTube/broadcaster blocks embedding; open externally instead
 *
 * Health-check: validates each channel via its YouTube RSS feed.
 * Stale-while-revalidate so health-check runs in the background without blocking the UI.
 */

interface Feed {
  id: string;
  name: string;
  city: string;
  country: string;
  lat: number;
  lng: number;
  url: string;
  embed_allowed: boolean;
  category: string;
  language: string;
  channelId?: string;
  healthy?: boolean;
  healthError?: string;
}

const LIVE_FEEDS: Feed[] = [
  // ── North America (external only — open in YouTube) ──
  { id: 'nbcnews',   name: 'NBC News NOW',  city: 'New York',      country: 'US', lat: 40.759, lng: -73.980, url: 'https://www.youtube.com/channel/UCeY0bbntWzzVIaj2z3QigXg/live', embed_allowed: false, category: 'mainstream', language: 'en', channelId: 'UCeY0bbntWzzVIaj2z3QigXg' },
  { id: 'cbsnews',   name: 'CBS News 24/7', city: 'New York',      country: 'US', lat: 40.764, lng: -73.973, url: 'https://www.youtube.com/channel/UC8p1vwvWtl6T73JiExfWs1g/live', embed_allowed: false, category: 'mainstream', language: 'en', channelId: 'UC8p1vwvWtl6T73JiExfWs1g' },
  { id: 'abcnews',   name: 'ABC News Live', city: 'New York',      country: 'US', lat: 40.763, lng: -73.979, url: 'https://www.youtube.com/channel/UCBi2mrWuNuyYy4gbM6fU18Q/live', embed_allowed: false, category: 'mainstream', language: 'en', channelId: 'UCBi2mrWuNuyYy4gbM6fU18Q' },
  { id: 'bloomberg', name: 'Bloomberg TV',  city: 'New York',      country: 'US', lat: 40.756, lng: -73.988, url: 'https://www.youtube.com/channel/UC_vQ72b7v5n2938v9d5c80w/live', embed_allowed: false, category: 'finance',    language: 'en', channelId: 'UC_vQ72b7v5n2938v9d5c80w' },
  { id: 'cspan',     name: 'C-SPAN',        city: 'Washington DC', country: 'US', lat: 38.897, lng: -77.036, url: 'https://www.youtube.com/channel/UCb--64Gl51jIEVE-GLDAVTg/live',  embed_allowed: false, category: 'government', language: 'en', channelId: 'UCb--64Gl51jIEVE-GLDAVTg' },
  { id: 'cbc',       name: 'CBC News',      city: 'Toronto',       country: 'CA', lat: 43.644, lng: -79.387, url: 'https://www.youtube.com/channel/UCKy1dAqELon0zgzZPOz9SVw/live',  embed_allowed: false, category: 'mainstream', language: 'en', channelId: 'UCKy1dAqELon0zgzZPOz9SVw' },

  // ── Europe (verified embeddable) ──
  { id: 'skynews',    name: 'Sky News',      city: 'London', country: 'GB', lat: 51.500, lng:  -0.118, url: 'https://www.youtube.com/embed/live_stream?channel=UCoMdktPbSTixAyNGwb-UYkQ&autoplay=1&mute=1', embed_allowed: true, category: 'mainstream', language: 'en', channelId: 'UCoMdktPbSTixAyNGwb-UYkQ' },
  { id: 'france24en', name: 'France 24 EN',  city: 'Paris',  country: 'FR', lat: 48.830, lng:   2.280, url: 'https://www.youtube.com/embed/live_stream?channel=UCQfwfsi5VrQ8yKZ-UWmAEFg&autoplay=1&mute=1', embed_allowed: true, category: 'mainstream', language: 'en', channelId: 'UCQfwfsi5VrQ8yKZ-UWmAEFg' },
  { id: 'dwnews',     name: 'DW News',       city: 'Berlin', country: 'DE', lat: 52.508, lng:  13.376, url: 'https://www.youtube.com/embed/live_stream?channel=UCknLrEdhRCp1aegoMqRaCZg&autoplay=1&mute=1', embed_allowed: true, category: 'mainstream', language: 'en', channelId: 'UCknLrEdhRCp1aegoMqRaCZg' },

  // ── Middle East ──
  { id: 'aljazeera',  name: 'Al Jazeera EN', city: 'Doha', country: 'QA', lat: 25.286, lng: 51.534, url: 'https://www.youtube.com/embed/live_stream?channel=UCNye-wNBqNL5ZzHSJj3l8Bg&autoplay=1&mute=1', embed_allowed: true, category: 'mainstream', language: 'en', channelId: 'UCNye-wNBqNL5ZzHSJj3l8Bg' },

  // ── Asia Pacific (verified embeddable) ──
  { id: 'nhkworld', name: 'NHK World',  city: 'Tokyo',     country: 'JP', lat: 35.690, lng: 139.692, url: 'https://www.youtube.com/embed/live_stream?channel=UCSPEjw8F2nQDtmUKPFNF7_A&autoplay=1&mute=1', embed_allowed: true, category: 'mainstream', language: 'en', channelId: 'UCSPEjw8F2nQDtmUKPFNF7_A' },
  { id: 'cna',      name: 'CNA 24/7',  city: 'Singapore', country: 'SG', lat:  1.290, lng: 103.852, url: 'https://www.youtube.com/embed/live_stream?channel=UC83jt4dlz1Gjl58fzQrrKZg&autoplay=1&mute=1', embed_allowed: true, category: 'mainstream', language: 'en', channelId: 'UC83jt4dlz1Gjl58fzQrrKZg' },
  { id: 'wion',     name: 'WION',      city: 'New Delhi', country: 'IN', lat: 28.614, lng:  77.209, url: 'https://www.youtube.com/embed/live_stream?channel=UC_gUM8rL-Lrg6O3adPW9K1g&autoplay=1&mute=1', embed_allowed: true, category: 'mainstream', language: 'en', channelId: 'UC_gUM8rL-Lrg6O3adPW9K1g' },
  { id: 'cgtn',     name: 'CGTN',      city: 'Beijing',   country: 'CN', lat: 39.904, lng: 116.407, url: 'https://www.youtube.com/channel/UCgrNz-aDmcr2uuto8_DL2jg/live',                                embed_allowed: false, category: 'state',      language: 'en', channelId: 'UCgrNz-aDmcr2uuto8_DL2jg' },

  // ── State media (external only) ──
  { id: 'rt', name: 'RT News', city: 'Moscow', country: 'RU', lat: 55.755, lng: 37.617, url: 'https://rumble.com/c/RTNewsEN', embed_allowed: false, category: 'state', language: 'en' },
];

/**
 * Health-check a single YouTube channel via its public RSS feed.
 * 200 → channel exists (healthy). 404 → channel deleted/invalid.
 * Rumble or non-YouTube links are skipped (assumed healthy).
 */
async function checkChannel(feed: Feed): Promise<{ healthy: boolean; healthError?: string }> {
  if (!feed.channelId) {
    return { healthy: true }; // Non-YouTube: assume up
  }
  try {
    const rssUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${feed.channelId}`;
    const res = await fetch(rssUrl, {
      signal: AbortSignal.timeout(5000),
      cache:  'no-store',
      headers: { 'User-Agent': 'OSIRIS/4.0' },
    });
    if (res.ok) {
      return { healthy: true };
    }
    if (res.status === 404) {
      const msg = `Channel ${feed.channelId} not found (404) — URL may be stale`;
      console.warn(`[OSIRIS/LiveNews] ${feed.name}: ${msg}`);
      return { healthy: false, healthError: msg };
    }
    // 429, 5xx, etc. — don't mark as unhealthy, just uncertain
    console.warn(`[OSIRIS/LiveNews] ${feed.name}: RSS check returned ${res.status} — treating as unknown`);
    return { healthy: true, healthError: `RSS check returned ${res.status}` };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[OSIRIS/LiveNews] ${feed.name}: health-check failed — ${msg}`);
    // Network timeout → don't penalise; treat as unknown
    return { healthy: true, healthError: `Health-check timed out: ${msg}` };
  }
}

export async function GET() {
  // Run all health-checks in parallel (each has its own 5 s timeout)
  const healthResults = await Promise.all(LIVE_FEEDS.map(f => checkChannel(f)));

  const feeds = LIVE_FEEDS.map((feed, i) => ({
    ...feed,
    healthy:     healthResults[i].healthy,
    ...(healthResults[i].healthError
      ? { healthError: healthResults[i].healthError }
      : {}),
  }));

  const unhealthy = feeds.filter(f => !f.healthy);
  if (unhealthy.length > 0) {
    console.error(
      `[OSIRIS/LiveNews] ${unhealthy.length} channel(s) appear offline: ${unhealthy.map(f => `${f.name} (${f.channelId})`).join(', ')}`
    );
  }

  return NextResponse.json(
    {
      feeds,
      total:     feeds.length,
      healthy:   feeds.filter(f => f.healthy).length,
      unhealthy: unhealthy.length,
      categories: ['mainstream', 'government', 'finance', 'conflict', 'state'],
      timestamp: new Date().toISOString(),
    },
    {
      headers: {
        // Revalidate health-check every 15 minutes in the background
        'Cache-Control': 'public, s-maxage=900, stale-while-revalidate=1800',
      },
    }
  );
}
