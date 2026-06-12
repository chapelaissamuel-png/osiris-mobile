/**
 * OSIRIS — Source Tier System
 *
 * Adapted from World Monitor (github.com/koala73/worldmonitor), MIT License.
 * Original: server/_shared/source-tiers.ts + shared/source-tiers.json
 *
 * Tier 1: Wire services / official gov/intl orgs — fastest, most authoritative
 * Tier 2: Major established outlets — high-quality journalism
 * Tier 3: Specialty / regional / think tank sources — domain expertise
 * Tier 4: Aggregators and blogs — useful but less authoritative
 */

export const SOURCE_TIERS: Record<string, number> = {
  'Reuters': 1, 'Reuters World': 1, 'Reuters Business': 1, 'Reuters US': 1,
  'AP News': 1, 'AFP': 1, 'Bloomberg': 1,
  'White House': 1, 'State Dept': 1, 'Pentagon': 1,
  'UN News': 1, 'CISA': 1, 'UK MOD': 1, 'IAEA': 1, 'WHO': 1, 'UNHCR': 1,
  'Tagesschau': 1, 'ANSA': 1, 'NOS Nieuws': 1, 'SVT Nyheter': 1,
  'Wall Street Journal': 1, 'Balkan Insight': 1,

  'BBC World': 2, 'BBC Middle East': 2, 'BBC Persian': 2, 'BBC': 2,
  'Guardian World': 2, 'NPR News': 2, 'CNN World': 2, 'CNBC': 2,
  'MarketWatch': 2, 'Al Jazeera': 2, 'Financial Times': 2,
  'Politico': 2, 'Axios': 2, 'EuroNews': 2, 'France 24': 2,
  'Le Monde': 2, 'Fox News': 2, 'NBC News': 2, 'CBS News': 2,
  'ABC News': 2, 'PBS NewsHour': 2, 'Yonhap News': 2, 'NHK World': 2,
  'El País': 2, 'Der Spiegel': 2, 'DW News': 2, 'DFRLab': 2, 'OCCRP': 2,
  'Treasury': 2, 'DOJ': 2, 'DHS': 2, 'CDC': 2, 'FEMA': 2,
  'Military Times': 2, 'USNI News': 2, 'RUSI': 2, 'CNAS': 2,
  'War on the Rocks': 2, 'Nikkei Asia': 2, 'Bangkok Post': 2,
  'Meduza': 2, 'Novaya Gazeta Europe': 2, 'BBC Russian': 2,
  'GDACS': 2, 'ReliefWeb': 2, 'WHO Outbreaks': 2, 'NATO': 2, 'Defense.gov': 2,

  'Defense One': 3, 'Breaking Defense': 3, 'The War Zone': 3,
  'Defense News': 3, 'Janes': 3, 'Task & Purpose': 3, 'gCaptain': 3,
  'Foreign Policy': 3, 'The Diplomat': 3, 'Bellingcat': 3,
  'Atlantic Council': 3, 'Foreign Affairs': 3, 'CrisisWatch': 3,
  'CSIS': 3, 'RAND': 3, 'Brookings': 3, 'Carnegie': 3,
  'Krebs Security': 3, 'Ransomware.live': 3,
  'Federal Reserve': 3, 'SEC': 3, 'MIT Tech Review': 3, 'Ars Technica': 3,
  'Iran International': 3, 'Xinhua': 3, 'TASS': 3, 'RT': 3, 'RT Russia': 3,
  'Fars News': 3, 'Mongabay': 3, 'EFF News': 3,
  'OSINTtechnical': 3, 'Faytuks': 3, 'CyberKnow': 3, 'Liveuamap': 3,
  'warmonitor': 3, 'MiddleEastEye': 3, 'Intel_Slava_Z': 3,

  'Hacker News': 4, 'The Verge': 4, 'VentureBeat AI': 4,
  'Yahoo Finance': 4, 'ArXiv AI': 4, 'AI News': 4, 'TechCrunch': 4,
};

/** State-affiliated / propaganda outlets — show warning badge in UI */
export const STATE_AFFILIATED = new Set(['RT', 'RT Russia', 'TASS', 'Xinhua', 'Fars News']);

export function getSourceTier(sourceName: string): number {
  if (!sourceName) return 4;
  const exact = SOURCE_TIERS[sourceName];
  if (exact !== undefined) return exact;
  for (const [key, tier] of Object.entries(SOURCE_TIERS)) {
    if (sourceName.toLowerCase().includes(key.toLowerCase()) ||
        key.toLowerCase().includes(sourceName.toLowerCase())) {
      return tier;
    }
  }
  if (sourceName.startsWith('t.me/')) return 3;
  return 4;
}

export function isStateAffiliated(sourceName: string): boolean {
  return STATE_AFFILIATED.has(sourceName);
}

/** Sort items by tier (lower = more authoritative) then by date desc */
export function sortByTierThenDate<T extends { source?: string; published?: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const tierA = getSourceTier(a.source ?? '');
    const tierB = getSourceTier(b.source ?? '');
    if (tierA !== tierB) return tierA - tierB;
    return new Date(b.published ?? 0).getTime() - new Date(a.published ?? 0).getTime();
  });
}
