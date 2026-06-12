import { NextResponse } from 'next/server';
import crypto from 'crypto';

/**
 * OSIRIS — Intelligence Feed
 *
 * Strategy:
 *  1. Scrape Telegram public preview pages (t.me/s/<channel>) — no API key needed.
 *  2. If Telegram returns nothing, fall back to RSS feeds.
 *  3. All internal fetch() calls use cache:'no-store'.
 *  4. Response header is no-store so CDN/shared caches never serve stale intel.
 *
 * Timestamp fix (v3):
 *  The previous parser used two broken regexes:
 *  - Primary required class= before href= in <a> tag → Telegram puts href first → 0 matches
 *  - Fallback searched <time> THEN <a href="t.me"> forward → in real HTML <a> wraps <time>,
 *    so it matched <time datetime="recent"> + the next old post link in message text → "1205d ago"
 *  Fix: single attribute-order-independent regex anchored on t.me/CHANNEL/NNN (message URLs only).
 */

const TELEGRAM_CHANNELS = [
  'OSINTtechnical', // OSINT technical analysis
  'Faytuks',        // Breaking geopolitical events
  'Liveuamap',      // Live conflict maps
  'CyberKnow',      // Cyber intelligence
  'Intel_Slava_Z',  // Ukraine/Russia front + battlefield OSINT
  'warmonitor',     // Global conflict monitor
  'MiddleEastEye',  // Middle East + North Africa coverage
];

const FALLBACK_FEEDS: Record<string, string> = {
  Reuters:       'https://feeds.reuters.com/reuters/worldNews',
  'Al Jazeera':  'https://www.aljazeera.com/xml/rss/all.xml',
  BBC:           'https://feeds.bbci.co.uk/news/world/rss.xml',
  GDACS:         'https://www.gdacs.org/xml/rss.xml',
  // Health / outbreak intelligence
  'WHO Outbreaks': 'https://www.who.int/feeds/entity/csr/don/en/rss.xml',
  // Military & security
  'Defense.gov':   'https://www.defense.gov/DesktopModules/ArticleCS/RSS.ashx?ContentType=1&Site=945&max=10',
  'NATO':          'https://www.nato.int/cps/en/natohq/news.rss',
  // Humanitarian / crises
  'ReliefWeb':     'https://reliefweb.int/headlines/rss.xml',
};

const RISK_KEYWORDS = [
  'war','missile','strike','attack','crisis','tension','military','conflict',
  'defense','clash','nuclear','invasion','bomb','drone','weapon','sanctions',
  'ceasefire','escalation','killed','destroyed','operation','casualty',
  'frontline','threat','explosion','coup','siege','hostage','offensive',
];

const KEYWORD_COORDS: Record<string, [number, number]> = {
  'ukraine':       [49.487, 31.272], 'kyiv':        [50.450, 30.523],
  'russia':        [61.524,105.318], 'moscow':       [55.755, 37.617],
  'israel':        [31.046, 34.851], 'gaza':         [31.416, 34.333],
  'iran':          [32.427, 53.688], 'lebanon':      [33.854, 35.862],
  'syria':         [34.802, 38.996], 'yemen':        [15.552, 48.516],
  'china':         [35.861,104.195], 'taiwan':       [23.697,120.960],
  'united states': [38.907,-77.036], 'europe':       [48.800,  2.300],
  'middle east':   [31.500, 34.800], 'sudan':        [15.558, 32.532],
  'myanmar':       [17.133, 95.932], 'haiti':        [18.971,-72.285],
  'afghanistan':   [33.939, 67.710], 'north korea':  [40.339,127.510],
  'pakistan':      [30.375, 69.345], 'sahel':        [15.000,  2.000],
};

function scoreRisk(text: string): number {
  const lower = text.toLowerCase();
  let score = 1;
  for (const kw of RISK_KEYWORDS) if (lower.includes(kw)) score += 2;
  return Math.min(10, score);
}

function findCoords(text: string): [number, number] | null {
  const lower = text.toLowerCase();
  for (const [kw, coords] of Object.entries(KEYWORD_COORDS)) if (lower.includes(kw)) return coords;
  return null;
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').trim();
}

/**
 * Telegram HTML parser — v3
 *
 * Key: use ONE regex that matches href regardless of attribute order inside the <a> tag.
 *
 *   /<a\b[^>]*\bhref="(https:\/\/t\.me\/[\w.]+\/\d+)"[^>]*>[\s\S]{0,300}?<time\b[^>]*\bdatetime="([^"]+)"/gi
 *
 * Why this works:
 *   - [^>]* before \bhref= matches any other attributes (like class=) before href=
 *   - href= must point to t.me/CHANNEL/NNN where NNN is a number (message-specific URL)
 *     This is critical — it rules out channel links (t.me/CyberKnow) that appear in message text
 *   - [^>]* after href= captures trailing attributes then the closing >
 *   - [\s\S]{0,300}? then reaches the <time datetime> tag inside the same anchor
 *
 * Safety:
 *   - 30-day freshness filter: discard any item older than 30 days.
 *     Even if the parser makes a mistake it can't show 4-year-old items.
 */
function parseTelegramHTML(html: string, channel: string): any[] {
  if (!html || html.length < 500) return [];

  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - THIRTY_DAYS_MS;

  // Single attribute-order-independent regex: <a href="t.me/Chan/NNN" ...> ... <time datetime="...">
  // The /\d+ suffix on the URL ensures we only match message links, not channel root links.
  const dateAnchorRe = /<a\b[^>]*\bhref="(https:\/\/t\.me\/[\w.]+\/\d+)"[^>]*>[\s\S]{0,300}?<time\b[^>]*\bdatetime="([^"]+)"/gi;
  const matches = [...html.matchAll(dateAnchorRe)];

  const items: any[] = [];

  for (const m of matches) {
    const link    = m[1];
    const rawDate = m[2];

    // Validate and filter stale dates
    const parsed = new Date(rawDate);
    if (isNaN(parsed.getTime())) continue;
    if (parsed.getTime() < cutoff) continue;          // discard items > 30 days old

    const pos = m.index ?? 0;

    // Search backwards from the match for the nearest .tgme_widget_message_text div
    const chunkStart = Math.max(0, pos - 4000);
    const chunk      = html.substring(chunkStart, pos + 100);

    const textRe = /<div[^>]+class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
    let lastText: string | null = null;
    for (const tm of chunk.matchAll(textRe)) {
      const candidate = stripHtml(tm[1]);
      if (candidate.length >= 10) lastText = candidate;
    }

    if (!lastText) continue;

    items.push({
      title:       lastText.split('\n')[0].substring(0, 120),
      description: lastText,
      link,
      pubDate:     parsed.toISOString(),
      source:      `t.me/${channel}`,
    });
  }

  // De-duplicate by link, return most recent first
  const seen = new Set<string>();
  return items
    .filter(i => { if (seen.has(i.link)) return false; seen.add(i.link); return true; })
    .sort((a, b) => new Date(b.pubDate).getTime() - new Date(a.pubDate).getTime());
}

function parseRSSItems(xml: string, sourceName: string): any[] {
  const items: any[] = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const itemXml = m[1];
    const getTag = (tag: string) => {
      const tm = itemXml.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>|<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
      return (tm?.[1] || tm?.[2] || '').trim();
    };
    const title = stripHtml(getTag('title'));
    const desc  = stripHtml(getTag('description') || getTag('summary'));
    const raw   = getTag('pubDate') || getTag('published') || getTag('dc:date') || '';
    const parsedDate = raw ? new Date(raw) : null;
    // If RSS date is invalid or missing, default to now — never show "53y ago"
    const pubDate = parsedDate && !isNaN(parsedDate.getTime())
      ? parsedDate.toISOString()
      : new Date().toISOString();

    if (!title) continue;
    items.push({
      title:       title.length > 120 ? title.substring(0, 120) + '...' : title,
      description: desc || title,
      link:        getTag('link') || getTag('guid'),
      pubDate,
      source:      sourceName,
    });
  }
  return items;
}

export async function GET() {
  try {
    // ── 1. Telegram channels ──────────────────────────────────────────────────
    const telegramResults = await Promise.allSettled(
      TELEGRAM_CHANNELS.map(async (channel) => {
        try {
          const res = await fetch(`https://t.me/s/${channel}`, {
            signal:  AbortSignal.timeout(8000),
            cache:   'no-store',
            headers: {
              'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
              'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
              'Accept-Language': 'en-US,en;q=0.9',
              'Cache-Control':   'no-cache',
            },
          });
          if (!res.ok) return [];
          const html = await res.text();
          const parsed = parseTelegramHTML(html, channel);
          return parsed.slice(0, 10);
        } catch {
          return [];
        }
      })
    );

    const allArticles: any[] = [];
    for (const r of telegramResults) {
      if (r.status === 'fulfilled') allArticles.push(...r.value);
    }

    // ── 2. RSS fallback ───────────────────────────────────────────────────────
    if (allArticles.length === 0) {
      const rssResults = await Promise.allSettled(
        Object.entries(FALLBACK_FEEDS).map(async ([source, url]) => {
          try {
            const res = await fetch(url, { signal: AbortSignal.timeout(6000), cache: 'no-store' });
            if (!res.ok) return [];
            return parseRSSItems(await res.text(), source).slice(0, 6);
          } catch { return []; }
        })
      );
      for (const r of rssResults) {
        if (r.status === 'fulfilled') allArticles.push(...r.value);
      }
    }

    // ── 3. Enrich + score ────────────────────────────────────────────────────
    const newsItems = allArticles.map(a => {
      const text  = a.description || a.title || '';
      const score = scoreRisk(text);
      const coords = findCoords(text);
      return {
        id: crypto.createHash('md5').update((a.link || '') + (a.pubDate || '')).digest('hex'),
        title:       a.title,
        description: a.description,
        link:        a.link,
        published:   a.pubDate,
        source:      a.source,
        risk_score:  score,
        coords,
        coords_default: !coords,
        machine_assessment: score >= 8
          ? 'AI analysis indicates elevated tactical priority based on OSINT stream patterns.'
          : null,
      };
    });

    newsItems.sort((a, b) => new Date(b.published).getTime() - new Date(a.published).getTime());

    return NextResponse.json(
      { news: newsItems, total: newsItems.length, timestamp: new Date().toISOString() },
      { headers: { 'Cache-Control': 'no-store, max-age=0' } }
    );

  } catch {
    return NextResponse.json(
      { news: [], error: 'Failed to fetch intel', timestamp: new Date().toISOString() },
      { status: 500, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
