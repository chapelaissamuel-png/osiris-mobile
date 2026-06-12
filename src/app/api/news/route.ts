import { NextResponse } from 'next/server';
import crypto from 'crypto';

/**
 * OSIRIS — Intelligence Feed
 *
 * Strategy:
 *  1. Scrape Telegram public preview pages (t.me/s/<channel>) — no API key needed.
 *  2. If Telegram IP-blocks the server (empty results), fall back to RSS feeds.
 *  3. Both paths use cache:'no-store' to prevent Next.js Data Cache from freezing responses.
 *  4. Response header is no-store so CDN/shared caches never serve stale intel.
 */

const TELEGRAM_CHANNELS = ['OSINTtechnical', 'Faytuks', 'Liveuamap', 'CyberKnow'];

// More diverse fallback set — Reuters updates every 15-30 min, much fresher than BBC/GDACS
const FALLBACK_FEEDS: Record<string, string> = {
  Reuters:     'https://feeds.reuters.com/reuters/worldNews',
  'Al Jazeera': 'https://www.aljazeera.com/xml/rss/all.xml',
  BBC:          'https://feeds.bbci.co.uk/news/world/rss.xml',
  GDACS:        'https://www.gdacs.org/xml/rss.xml',
  'AP News':    'https://rsshub.app/apnews/topics/world-news',
};

const RISK_KEYWORDS = [
  'war','missile','strike','attack','crisis','tension','military','conflict',
  'defense','clash','nuclear','invasion','bomb','drone','weapon','sanctions',
  'ceasefire','escalation','killed','destroyed','operation','casualty',
  'frontline','threat','explosion','coup','siege','hostage','offensive',
];

const KEYWORD_COORDS: Record<string, [number, number]> = {
  'ukraine':       [49.487, 31.272], 'kyiv':          [50.450, 30.523],
  'russia':        [61.524,105.318], 'moscow':         [55.755, 37.617],
  'israel':        [31.046, 34.851], 'gaza':           [31.416, 34.333],
  'iran':          [32.427, 53.688], 'lebanon':        [33.854, 35.862],
  'syria':         [34.802, 38.996], 'yemen':          [15.552, 48.516],
  'china':         [35.861,104.195], 'taiwan':         [23.697,120.960],
  'united states': [38.907,-77.036], 'europe':         [48.800,  2.300],
  'middle east':   [31.500, 34.800], 'sudan':          [15.558, 32.532],
  'myanmar':       [17.133, 95.932], 'haiti':          [18.971,-72.285],
  'afghanistan':   [33.939, 67.710], 'north korea':    [40.339,127.510],
  'pakistan':      [30.375, 69.345], 'sahel':          [15.000,  2.000],
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
 * Robust Telegram parser — anchors on the stable <a class="tgme_widget_message_date"> + <time>
 * elements instead of the outer wrapper divs whose class names change frequently.
 */
function parseTelegramHTML(html: string, channel: string): any[] {
  if (!html || html.length < 500) return [];

  const items: any[] = [];

  // Strategy: find all (link, datetime) pairs from the stable date-anchor elements,
  // then look backwards in the HTML chunk for the message text div.
  const dateLinkRe = /<a[^>]+class="tgme_widget_message_date"[^>]+href="(https:\/\/t\.me\/[^"]+)"[^>]*>[\s\S]{0,200}?<time[^>]+datetime="([^"]+)"/gi;
  const matches = [...html.matchAll(dateLinkRe)];

  if (matches.length === 0) {
    // Fallback: try alternate structure where datetime comes first
    const altRe = /<time[^>]+datetime="([^"]+)"[\s\S]{0,300}?<a[^>]+href="(https:\/\/t\.me\/[^"]+)"/gi;
    for (const m of html.matchAll(altRe)) {
      matches.push({ ...m, index: m.index!, 1: m[2], 2: m[1] } as any);
    }
  }

  for (const m of matches) {
    const link    = m[1];
    const pubDate = m[2];
    const pos     = m.index ?? 0;

    // Search the chunk BEFORE this date link for the message text
    const chunkStart = Math.max(0, pos - 4000);
    const chunk      = html.substring(chunkStart, pos + 200);

    // Try class="tgme_widget_message_text" first, then any tgme_widget_message_text variant
    const textRe = /<div[^>]+class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
    let lastText: string | null = null;
    for (const tm of chunk.matchAll(textRe)) {
      const candidate = stripHtml(tm[1]);
      if (candidate.length >= 10) lastText = candidate;
    }

    if (!lastText) continue;

    const title = lastText.split('\n')[0].substring(0, 120);
    items.push({
      title,
      description: lastText,
      link,
      pubDate,
      source: `t.me/${channel}`,
    });
  }

  // De-duplicate by link
  const seen = new Set<string>();
  return items.filter(i => { if (seen.has(i.link)) return false; seen.add(i.link); return true; });
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
    // Validate the date — if invalid or missing, use now so items don't appear stale
    const parsedDate = raw ? new Date(raw) : null;
    const pubDate = parsedDate && !isNaN(parsedDate.getTime()) ? parsedDate.toISOString() : new Date().toISOString();

    if (!title) continue;
    items.push({
      title: title.length > 120 ? title.substring(0, 120) + '...' : title,
      description: desc || title,
      link:    getTag('link') || getTag('guid'),
      pubDate,
      source:  sourceName,
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
          const res = await fetch(`https://t.me/s/${channel}?_=${Date.now()}`, {
            signal:  AbortSignal.timeout(8000),
            // cache:'no-store' prevents Next.js Data Cache from freezing Telegram responses
            cache:   'no-store',
            headers: {
              'User-Agent':       'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
              'Accept':           'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
              'Accept-Language':  'en-US,en;q=0.9',
              'Cache-Control':    'no-cache',
            },
          });
          if (!res.ok) return [];
          const html = await res.text();
          return parseTelegramHTML(html, channel).slice(-10);
        } catch {
          return [];
        }
      })
    );

    const allArticles: any[] = [];
    for (const r of telegramResults) {
      if (r.status === 'fulfilled') allArticles.push(...r.value);
    }

    // ── 2. RSS fallback (used when Telegram is IP-blocked) ───────────────────
    if (allArticles.length === 0) {
      const rssResults = await Promise.allSettled(
        Object.entries(FALLBACK_FEEDS).map(async ([source, url]) => {
          try {
            const res = await fetch(url, {
              signal: AbortSignal.timeout(6000),
              cache:  'no-store',
            });
            if (!res.ok) return [];
            return parseRSSItems(await res.text(), source).slice(0, 6);
          } catch {
            return [];
          }
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
        coords:      coords,
        coords_default: !coords,
        machine_assessment: score >= 8
          ? 'AI analysis indicates elevated tactical priority based on OSINT stream patterns.'
          : null,
      };
    });

    newsItems.sort((a, b) => new Date(b.published).getTime() - new Date(a.published).getTime());

    // no-store: never serve stale intel from CDN or shared caches
    return NextResponse.json(
      { news: newsItems, total: newsItems.length, timestamp: new Date().toISOString() },
      { headers: { 'Cache-Control': 'no-store, max-age=0' } }
    );

  } catch (error) {
    return NextResponse.json(
      { news: [], error: 'Failed to fetch intel', timestamp: new Date().toISOString() },
      { status: 500, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
