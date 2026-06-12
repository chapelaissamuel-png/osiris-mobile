
import { NextResponse } from 'next/server';

/**
 * OSIRIS — Cyber Threat Intelligence
 *
 * Sources:
 *   1. Shodan (SHODAN_API_KEY) — host/count + facets (0 query credits consumed)
 *      • Global vulnerable hosts + top-exposed countries
 *      • Active Cobalt Strike C2 beacons
 *      • EternalBlue / MS17-010 still-exposed hosts
 *      • Log4Shell / CVE-2021-44228 unpatched hosts
 *      • Exposed RDP with known vulnerabilities
 *      • Exposed ICS/SCADA (Modbus port 502, BACnet 47808, S7 102)
 *   2. URLhaus (abuse.ch) — recent malware-distribution URLs (free, no key)
 *   3. Feodo Tracker (abuse.ch) — active botnet C2 server IPs (free, no key)
 *   4. CISA KEV — US gov known-exploited CVEs, last 30 days (free, no key)
 */

// ─── Types ────────────────────────────────────────────────────────────────────
interface FacetEntry { count: number; value: string; }
interface ShodanCountBody {
  total:   number;
  facets?: { country?: FacetEntry[]; port?: FacetEntry[] };
}
interface ShodanStat {
  label:         string;
  total:         number;
  top_countries: Array<{ country: string; count: number }>;
  top_ports?:    Array<{ port: string;    count: number }>;
}
type ShodanStats = Record<string, ShodanStat>;

// ─── Shodan query manifest ────────────────────────────────────────────────────
//     Each entry = 1 API call, 0 query credits consumed (count-only endpoint).
const SHODAN_QUERIES = [
  {
    key: 'vulnerable_hosts',
    label: 'Vulnerable Hosts (any CVE)',
    query: 'has_vuln:true',
    facets: 'country:10,port:10',
    withPorts: true,
  },
  {
    key: 'cobalt_strike',
    label: 'Cobalt Strike C2 Beacons',
    query: 'product:"Cobalt Strike Beacon"',
    facets: 'country:5',
    withPorts: false,
  },
  {
    key: 'eternal_blue',
    label: 'EternalBlue / MS17-010',
    query: 'vuln:ms17-010',
    facets: 'country:5',
    withPorts: false,
  },
  {
    key: 'log4shell',
    label: 'Log4Shell (CVE-2021-44228)',
    query: 'vuln:CVE-2021-44228',
    facets: 'country:5',
    withPorts: false,
  },
  {
    key: 'rdp_vulnerable',
    label: 'Exposed RDP with Vulns',
    query: 'port:3389 has_vuln:true',
    facets: 'country:5',
    withPorts: false,
  },
  {
    key: 'ics_exposed',
    label: 'Exposed ICS / SCADA',
    query: 'port:502 OR port:47808 OR port:102',
    facets: 'country:5',
    withPorts: false,
  },
] as const;

// ─── In-memory caches ─────────────────────────────────────────────────────────
const G = globalThis as unknown as {
  cyberShodanStats:    ShodanStats;
  cyberShodanCacheAt:  number;
  cyberLiveData:       any;
  cyberLiveCacheAt:    number;
};
if (!G.cyberShodanStats) { G.cyberShodanStats = {}; G.cyberShodanCacheAt = 0; }
if (!G.cyberLiveData)    { G.cyberLiveData = null;  G.cyberLiveCacheAt = 0; }

const SHODAN_TTL =  60 * 60 * 1000;   // 1 h  — global exposure stats change slowly
const LIVE_TTL   =  15 * 60 * 1000;   // 15 min — malware URLs refresh quickly

// ─── Shodan: single count query ───────────────────────────────────────────────
async function shodanCount(key: string, query: string, facets: string): Promise<ShodanCountBody> {
  const qs = new URLSearchParams({ key, query, facets });
  const res = await fetch(`https://api.shodan.io/shodan/host/count?${qs}`, {
    signal: AbortSignal.timeout(9000),
    headers: { Accept: 'application/json' },
  });
  if (res.status === 401) throw new Error('Shodan 401 — invalid key');
  if (res.status === 403) throw new Error('Shodan 403 — upgrade required');
  if (!res.ok)            throw new Error(`Shodan HTTP ${res.status}`);
  return res.json();
}

// ─── URLhaus: recent malware-distribution URLs ────────────────────────────────
async function fetchURLhaus() {
  const res = await fetch('https://urlhaus-api.abuse.ch/v1/urls/recent/', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    signal:  AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`URLhaus HTTP ${res.status}`);
  const data = await res.json();
  const all    = (data.urls || []) as any[];
  const online = all.filter((u: any) => u.url_status === 'online');

  const tagCount: Record<string, number> = {};
  for (const u of online) {
    for (const tag of (u.tags || []) as string[]) {
      tagCount[tag] = (tagCount[tag] || 0) + 1;
    }
  }
  const top_threats = Object.entries(tagCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([name, count]) => ({ name, count }));

  return {
    online_count: online.length,
    total_recent: all.length,
    top_threats,
    sample: online.slice(0, 6).map((u: any) => ({
      url:    u.url,
      added:  u.url_added,
      tags:   u.tags,
      threat: u.threat,
    })),
  };
}

// ─── Feodo Tracker: active botnet C2 IPs ─────────────────────────────────────
async function fetchFeodo() {
  const res = await fetch('https://feodotracker.abuse.ch/downloads/ipblocklist.json', {
    signal:  AbortSignal.timeout(12000),
    headers: { 'User-Agent': 'OSIRIS-Intelligence-Platform/4' },
  });
  if (!res.ok) throw new Error(`Feodo HTTP ${res.status}`);
  const list   = (await res.json()) as any[];
  const online = list.filter((c: any) => c.status === 'online');

  const byCountry: Record<string, number> = {};
  const byFamily:  Record<string, number> = {};
  for (const c of online) {
    if (c.country) byCountry[c.country] = (byCountry[c.country] || 0) + 1;
    if (c.malware) byFamily[c.malware]   = (byFamily[c.malware]  || 0) + 1;
  }
  const top_countries = Object.entries(byCountry)
    .sort((a, b) => b[1] - a[1]).slice(0, 8)
    .map(([country, count]) => ({ country, count }));
  const malware_families = Object.keys(byFamily).sort();

  return {
    total_online: online.length,
    total_tracked: list.length,
    top_countries,
    malware_families,
    sample: online.slice(0, 10).map((c: any) => ({
      ip:         c.ip_address,
      port:       c.port,
      malware:    c.malware,
      country:    c.country,
      as_name:    c.as_name,
      last_online: c.last_online,
    })),
  };
}

// ─── CISA KEV: known-exploited CVEs (last 30 days) ───────────────────────────
async function fetchCISA() {
  const res = await fetch(
    'https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json',
    { signal: AbortSignal.timeout(12000) }
  );
  if (!res.ok) throw new Error(`CISA HTTP ${res.status}`);
  const data = await res.json();
  const recent = (data.vulnerabilities || [])
    .filter((v: any) => (Date.now() - new Date(v.dateAdded).getTime()) / 86400000 <= 30)
    .slice(0, 10)
    .map((v: any) => ({
      id:      v.cveID,
      name:    v.vulnerabilityName,
      vendor:  v.vendorProject,
      product: v.product,
      date:    v.dateAdded,
      due:     v.dueDate,
    }));
  return {
    total_kev: data.vulnerabilities?.length ?? 0,
    recent,
  };
}

// ─── Main handler ─────────────────────────────────────────────────────────────
export async function GET() {
  try {
    const now       = Date.now();
    const shodanKey = process.env.SHODAN_API_KEY;

    // ── 1. Shodan exposure stats (1-hour cache) ───────────────────────────────
    let shodanStats: ShodanStats = G.cyberShodanStats;
    let shodanSource = '';

    if (shodanKey && (Object.keys(shodanStats).length === 0 || now - G.cyberShodanCacheAt > SHODAN_TTL)) {
      const settled = await Promise.allSettled(
        SHODAN_QUERIES.map(q => shodanCount(shodanKey, q.query, q.facets))
      );
      const fresh: ShodanStats = {};
      let ok = 0;
      for (let i = 0; i < SHODAN_QUERIES.length; i++) {
        const q = SHODAN_QUERIES[i];
        const r = settled[i];
        if (r.status === 'fulfilled') {
          fresh[q.key] = {
            label:         q.label,
            total:         r.value.total ?? 0,
            top_countries: (r.value.facets?.country ?? []).map(f => ({ country: f.value, count: f.count })),
            ...(q.withPorts ? { top_ports: (r.value.facets?.port ?? []).map(f => ({ port: f.value, count: f.count })) } : {}),
          };
          ok++;
        } else {
          console.warn(`[OSIRIS/Shodan] "${q.key}":`, (r as PromiseRejectedResult).reason?.message);
        }
      }
      if (ok > 0) {
        G.cyberShodanStats   = fresh;
        G.cyberShodanCacheAt = now;
        shodanStats          = fresh;
        shodanSource = `Shodan (${ok}/${SHODAN_QUERIES.length} queries, 0 credits used)`;
      } else {
        shodanSource = 'Shodan queries failed — check SHODAN_API_KEY';
      }
    } else if (!shodanKey) {
      shodanSource = 'Shodan disabled (set SHODAN_API_KEY)';
    } else {
      shodanSource = `Shodan (cached, ${Object.keys(shodanStats).length} metrics)`;
    }

    // ── 2. Live threat feeds (15-min cache) ───────────────────────────────────
    let live = G.cyberLiveData;
    if (!live || now - G.cyberLiveCacheAt > LIVE_TTL) {
      const [urlhausR, feodoR, cisaR] = await Promise.allSettled([
        fetchURLhaus(),
        fetchFeodo(),
        fetchCISA(),
      ]);
      live = {
        urlhaus: urlhausR.status === 'fulfilled' ? urlhausR.value : null,
        feodo:   feodoR.status   === 'fulfilled' ? feodoR.value   : null,
        cisa:    cisaR.status    === 'fulfilled' ? cisaR.value    : null,
        errors: [
          urlhausR.status === 'rejected' ? `URLhaus: ${(urlhausR as PromiseRejectedResult).reason?.message}` : null,
          feodoR.status   === 'rejected' ? `Feodo: ${(feodoR as PromiseRejectedResult).reason?.message}`   : null,
          cisaR.status    === 'rejected' ? `CISA: ${(cisaR as PromiseRejectedResult).reason?.message}`    : null,
        ].filter(Boolean),
      };
      G.cyberLiveData  = live;
      G.cyberLiveCacheAt = now;
    }

    // ── 3. Compute threat level ───────────────────────────────────────────────
    const cisaRecent   = live?.cisa?.recent?.length   ?? 0;
    const urlhausLive  = live?.urlhaus?.online_count  ?? 0;
    const feodoLive    = live?.feodo?.total_online    ?? 0;
    const cobaltTotal  = shodanStats?.cobalt_strike?.total ?? 0;
    const vulnHosts    = shodanStats?.vulnerable_hosts?.total ?? 0;

    let threat_level = 'ELEVATED';
    if (cisaRecent >= 8 || urlhausLive >= 50 || cobaltTotal > 5000 || vulnHosts > 20_000_000) {
      threat_level = 'CRITICAL';
    } else if (cisaRecent >= 4 || urlhausLive >= 15 || cobaltTotal > 500) {
      threat_level = 'HIGH';
    }

    return NextResponse.json({
      threat_level,
      shodan_stats:  shodanStats,
      malware_urls:  live?.urlhaus  ?? null,
      botnets:       live?.feodo    ?? null,
      cisa_kev:      live?.cisa     ?? null,
      feed_errors:   live?.errors   ?? [],
      sources: [
        shodanSource,
        'URLhaus (abuse.ch — malware URLs)',
        'Feodo Tracker (abuse.ch — botnet C2)',
        'CISA KEV (US-CERT known exploited CVEs)',
      ].join(' | '),
      timestamp: new Date().toISOString(),
    }, {
      headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600' },
    });

  } catch (err) {
    console.error('[OSIRIS/CyberThreats] Fatal:', err);
    return NextResponse.json({ threats: [], error: 'Failed' }, { status: 500 });
  }
}
