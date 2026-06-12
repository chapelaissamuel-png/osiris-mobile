/**
 * OSIRIS — Keyword + LLM classification pipeline
 *
 * Adapted from World Monitor (github.com/koala73/worldmonitor), MIT License.
 * Original: server/worldmonitor/news/v1/_classifier.ts
 *
 * Pipeline:
 *  1. classifyByKeyword()  — instant sync, ~120 keywords across 5 severity tiers
 *  2. classifyWithLLM()    — async Groq Llama-3.1-8b-instant, overwrites keyword
 *                            result if LLM confidence is higher; 24 h title-hash cache
 */

export type ThreatLevel = 'critical' | 'high' | 'medium' | 'low' | 'info';

export const SEVERITY_VALUES: Record<ThreatLevel, number> = {
  critical: 100,
  high: 75,
  medium: 50,
  low: 25,
  info: 0,
};

export type EventCategory =
  | 'conflict' | 'protest' | 'disaster' | 'diplomatic' | 'economic'
  | 'terrorism' | 'cyber' | 'health' | 'environmental' | 'military'
  | 'crime' | 'infrastructure' | 'tech' | 'general';

export interface ClassificationResult {
  level: ThreatLevel;
  category: EventCategory;
  confidence: number;
  source: 'keyword' | 'keyword-historical-downgrade' | 'llm';
}

type KeywordMap = Record<string, EventCategory>;

const CRITICAL_KEYWORDS: KeywordMap = {
  'nuclear strike': 'military',
  'nuclear attack': 'military',
  'nuclear war': 'military',
  'invasion': 'conflict',
  'declaration of war': 'conflict',
  'martial law': 'military',
  'coup': 'military',
  'coup attempt': 'military',
  'genocide': 'conflict',
  'ethnic cleansing': 'conflict',
  'chemical attack': 'terrorism',
  'biological attack': 'terrorism',
  'dirty bomb': 'terrorism',
  'mass casualty': 'conflict',
  'pandemic declared': 'health',
  'health emergency': 'health',
  'nato article 5': 'military',
  'evacuation order': 'disaster',
  'meltdown': 'disaster',
  'nuclear meltdown': 'disaster',
};

const HIGH_KEYWORDS: KeywordMap = {
  'war': 'conflict',
  'armed conflict': 'conflict',
  'airstrike': 'conflict',
  'air strike': 'conflict',
  'drone strike': 'conflict',
  'missile': 'military',
  'missile launch': 'military',
  'troops deployed': 'military',
  'military escalation': 'military',
  'bombing': 'conflict',
  'casualties': 'conflict',
  'hostage': 'terrorism',
  'terrorist': 'terrorism',
  'terror attack': 'terrorism',
  'assassination': 'crime',
  'cyber attack': 'cyber',
  'ransomware': 'cyber',
  'data breach': 'cyber',
  'sanctions': 'economic',
  'embargo': 'economic',
  'earthquake': 'disaster',
  'tsunami': 'disaster',
  'hurricane': 'disaster',
  'typhoon': 'disaster',
};

const MEDIUM_KEYWORDS: KeywordMap = {
  'protest': 'protest',
  'protests': 'protest',
  'riot': 'protest',
  'riots': 'protest',
  'unrest': 'protest',
  'demonstration': 'protest',
  'strike action': 'protest',
  'military exercise': 'military',
  'naval exercise': 'military',
  'arms deal': 'military',
  'weapons sale': 'military',
  'diplomatic crisis': 'diplomatic',
  'ambassador recalled': 'diplomatic',
  'expel diplomats': 'diplomatic',
  'trade war': 'economic',
  'tariff': 'economic',
  'recession': 'economic',
  'inflation': 'economic',
  'market crash': 'economic',
  'flood': 'disaster',
  'flooding': 'disaster',
  'wildfire': 'disaster',
  'volcano': 'disaster',
  'eruption': 'disaster',
  'outbreak': 'health',
  'epidemic': 'health',
  'infection spread': 'health',
  'oil spill': 'environmental',
  'ceasefire': 'diplomatic',
  'pipeline explosion': 'infrastructure',
  'blackout': 'infrastructure',
  'power outage': 'infrastructure',
  'internet outage': 'infrastructure',
  'derailment': 'infrastructure',
};

const LOW_KEYWORDS: KeywordMap = {
  'election': 'diplomatic',
  'vote': 'diplomatic',
  'referendum': 'diplomatic',
  'summit': 'diplomatic',
  'treaty': 'diplomatic',
  'agreement': 'diplomatic',
  'negotiation': 'diplomatic',
  'talks': 'diplomatic',
  'peacekeeping': 'diplomatic',
  'humanitarian aid': 'diplomatic',
  'peace treaty': 'diplomatic',
  'climate change': 'environmental',
  'emissions': 'environmental',
  'pollution': 'environmental',
  'deforestation': 'environmental',
  'drought': 'environmental',
  'vaccine': 'health',
  'vaccination': 'health',
  'disease': 'health',
  'virus': 'health',
  'public health': 'health',
  'covid': 'health',
  'interest rate': 'economic',
  'gdp': 'economic',
  'unemployment': 'economic',
  'regulation': 'economic',
};

const TECH_HIGH_KEYWORDS: KeywordMap = {
  'major outage': 'infrastructure',
  'service down': 'infrastructure',
  'global outage': 'infrastructure',
  'zero-day': 'cyber',
  'critical vulnerability': 'cyber',
  'supply chain attack': 'cyber',
  'mass layoff': 'economic',
};

const TECH_MEDIUM_KEYWORDS: KeywordMap = {
  'outage': 'infrastructure',
  'breach': 'cyber',
  'hack': 'cyber',
  'vulnerability': 'cyber',
  'layoff': 'economic',
  'layoffs': 'economic',
  'antitrust': 'economic',
  'monopoly': 'economic',
  'ban': 'economic',
  'shutdown': 'infrastructure',
};

const TECH_LOW_KEYWORDS: KeywordMap = {
  'ipo': 'economic',
  'funding': 'economic',
  'acquisition': 'economic',
  'merger': 'economic',
  'launch': 'tech',
  'release': 'tech',
  'update': 'tech',
  'partnership': 'economic',
  'startup': 'tech',
  'ai model': 'tech',
  'open source': 'tech',
};

const EXCLUSIONS = [
  'protein', 'couples', 'relationship', 'dating', 'diet', 'fitness',
  'recipe', 'cooking', 'shopping', 'fashion', 'celebrity', 'movie',
  'tv show', 'sports', 'game', 'concert', 'festival', 'wedding',
  'vacation', 'travel tips', 'life hack', 'self-care', 'wellness',
];

const SHORT_KEYWORDS = new Set([
  'war', 'coup', 'ban', 'vote', 'riot', 'riots', 'hack', 'talks', 'ipo', 'gdp',
  'virus', 'disease', 'flood',
]);

const keywordRegexCache = new Map<string, RegExp>();

function getKeywordRegex(kw: string): RegExp {
  let re = keywordRegexCache.get(kw);
  if (!re) {
    re = SHORT_KEYWORDS.has(kw)
      ? new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`)
      : new RegExp(kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    keywordRegexCache.set(kw, re);
  }
  return re;
}

function matchKeywords(
  titleLower: string,
  keywords: KeywordMap,
): { keyword: string; category: EventCategory } | null {
  for (const [kw, cat] of Object.entries(keywords)) {
    if (getKeywordRegex(kw).test(titleLower)) return { keyword: kw, category: cat };
  }
  return null;
}

const HISTORICAL_ANCHORED_PREFIX_RE = /^(?:science history|throwback|flashback)\s*:?/i;
const HISTORICAL_BRAND_PREFIX_RE =
  /^(?:[A-Z][\w'&-]*\s+){1,4}(?:[Tt]hrowback|[Ff]lashback)(?:\s+[A-Za-z]+)?\s*:/;
const HISTORICAL_PREFIX_WITH_YEAR_RE = /^on this day in\s+(?:19|20)\d{2}\b/i;
const THIS_DAY_IN_HISTORY_RE = /^this day in history\b/i;
const HISTORICAL_PHRASE_RE =
  /\b(?:\d+\s+(?:years?|decades?|months?)\s+(?:ago|after|later)|anniversary|in memoriam|remembering|remembered|commemorat(?:e|es|ed|ion)|retrospective)\b/i;
const FULL_DATE_RE =
  /\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2},?\s+((?:19|20)\d{2})\b/i;
const ISO_DATE_RE = /\b((?:19|20)\d{2})-\d{1,2}-\d{1,2}\b/;

function isPastRetrospectiveYear(year: number, nowMs: number): boolean {
  return year < new Date(nowMs).getUTCFullYear() - 1;
}

export function hasHistoricalMarker(title: string, nowMs: number = Date.now()): boolean {
  if (HISTORICAL_ANCHORED_PREFIX_RE.test(title)) return true;
  if (HISTORICAL_BRAND_PREFIX_RE.test(title)) return true;
  if (HISTORICAL_PREFIX_WITH_YEAR_RE.test(title)) return true;
  if (THIS_DAY_IN_HISTORY_RE.test(title)) return true;
  if (HISTORICAL_PHRASE_RE.test(title)) return true;
  const fullDateMatch = title.match(FULL_DATE_RE);
  if (fullDateMatch && isPastRetrospectiveYear(parseInt(fullDateMatch[1]!, 10), nowMs)) return true;
  const isoDateMatch = title.match(ISO_DATE_RE);
  if (isoDateMatch && isPastRetrospectiveYear(parseInt(isoDateMatch[1]!, 10), nowMs)) return true;
  return false;
}

export function classifyByKeyword(title: string, variant?: string): ClassificationResult {
  const lower = title.toLowerCase();

  if (EXCLUSIONS.some(ex => lower.includes(ex))) {
    return { level: 'info', category: 'general', confidence: 0.3, source: 'keyword' };
  }

  const isTech = variant === 'tech';
  const isRetrospective = hasHistoricalMarker(title);

  let match = matchKeywords(lower, CRITICAL_KEYWORDS);
  if (match) {
    if (isRetrospective) {
      return { level: 'info', category: 'general', confidence: 0.85, source: 'keyword-historical-downgrade' };
    }
    return { level: 'critical', category: match.category, confidence: 0.9, source: 'keyword' };
  }

  match = matchKeywords(lower, HIGH_KEYWORDS);
  if (match) {
    if (isRetrospective) {
      return { level: 'info', category: 'general', confidence: 0.85, source: 'keyword-historical-downgrade' };
    }
    return { level: 'high', category: match.category, confidence: 0.8, source: 'keyword' };
  }

  if (isTech) {
    match = matchKeywords(lower, TECH_HIGH_KEYWORDS);
    if (match) return { level: 'high', category: match.category, confidence: 0.75, source: 'keyword' };
  }

  match = matchKeywords(lower, MEDIUM_KEYWORDS);
  if (match) return { level: 'medium', category: match.category, confidence: 0.7, source: 'keyword' };

  if (isTech) {
    match = matchKeywords(lower, TECH_MEDIUM_KEYWORDS);
    if (match) return { level: 'medium', category: match.category, confidence: 0.65, source: 'keyword' };
  }

  match = matchKeywords(lower, LOW_KEYWORDS);
  if (match) return { level: 'low', category: match.category, confidence: 0.6, source: 'keyword' };

  if (isTech) {
    match = matchKeywords(lower, TECH_LOW_KEYWORDS);
    if (match) return { level: 'low', category: match.category, confidence: 0.55, source: 'keyword' };
  }

  return { level: 'info', category: 'general', confidence: 0.3, source: 'keyword' };
}

// ─── LLM cache (in-memory, 24 h, keyed by title hash) ─────────────────────────
const G = globalThis as unknown as {
  classifyCache: Map<string, { result: ClassificationResult; expiresAt: number }>;
};
if (!G.classifyCache) G.classifyCache = new Map();

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const VALID_LEVELS = new Set(['critical', 'high', 'medium', 'low', 'info']);
const VALID_CATEGORIES = new Set([
  'conflict', 'protest', 'disaster', 'diplomatic', 'economic',
  'terrorism', 'cyber', 'health', 'environmental', 'military',
  'crime', 'infrastructure', 'tech', 'general',
]);

async function titleHash(title: string): Promise<string> {
  const data = new TextEncoder().encode(title.toLowerCase().trim());
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

const LLM_SYSTEM_PROMPT = `You classify news headlines into threat level and category. Return ONLY valid JSON, no other text.

Levels: critical, high, medium, low, info
Categories: conflict, protest, disaster, diplomatic, economic, terrorism, cyber, health, environmental, military, crime, infrastructure, tech, general

Guidelines for LEVEL assignment (geopolitical scope required for critical):
- critical: Active military strikes with international implications, geopolitical mass-casualty events (10+ killed in conflict/terrorism/state action), ceasefire agreements/collapses, nuclear incidents, pandemic declarations, coups, strait/waterway closures
- high: Armed conflict updates, major diplomatic actions, sanctions packages, significant natural disasters, blockades, terrorist attacks, domestic mass-casualty events
- medium: Ongoing conflict analysis, economic impact reports, protest movements, regional policy changes, military exercises
- low: Diplomatic meetings, trade discussions, humanitarian aid, election updates, peacekeeping deployments
- info: Opinion/editorial pieces, analysis/explainer articles, historical retrospectives, lifestyle, entertainment, routine local news

Key distinction: "critical" requires GEOPOLITICAL scope — events that destabilize international order, threaten cross-border security, or disrupt global systems.
Focus: geopolitical events, conflicts, disasters, diplomacy.
Classify by real-world event severity, not headline sentiment.

Return: {"level":"...","category":"..."}`;

/**
 * Calls Groq Llama-3.1-8b-instant to classify a headline.
 * Returns null if GROQ_API_KEY is absent, or on any error.
 * Result is cached in globalThis for 24 h by title hash.
 */
export async function classifyWithLLM(title: string): Promise<ClassificationResult | null> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey || !title.trim()) return null;

  const key = await titleHash(title);
  const cached = G.classifyCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.result;

  try {
    const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        messages: [
          { role: 'system', content: LLM_SYSTEM_PROMPT },
          { role: 'user', content: title.slice(0, 500) },
        ],
        temperature: 0,
        max_tokens: 50,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!resp.ok) return null;
    const data = await resp.json() as { choices?: Array<{ message?: { content?: string } }> };
    let content = data.choices?.[0]?.message?.content?.trim() ?? '';
    content = content.replace(/^```(?:\w+)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();

    let parsed: { level?: string; category?: string };
    try {
      parsed = JSON.parse(content);
    } catch {
      const m = content.match(/\{[\s\S]*\}/);
      if (!m) return null;
      parsed = JSON.parse(m[0]);
    }

    const level = VALID_LEVELS.has(parsed.level ?? '') ? parsed.level as ThreatLevel : null;
    const category = VALID_CATEGORIES.has(parsed.category ?? '') ? parsed.category as EventCategory : null;
    if (!level || !category) return null;

    const result: ClassificationResult = { level, category, confidence: 0.9, source: 'llm' };
    G.classifyCache.set(key, { result, expiresAt: Date.now() + CACHE_TTL_MS });
    return result;

  } catch {
    return null;
  }
}

/**
 * Full pipeline: keyword first (sync), then LLM async.
 * The LLM result is fired-and-forgotten to populate the cache for next request.
 * Returns keyword result immediately; subsequent requests for the same title
 * will return the LLM result from cache.
 */
export function classifyItem(title: string, variant?: string): ClassificationResult {
  const keywordResult = classifyByKeyword(title, variant);

  if (process.env.GROQ_API_KEY) {
    classifyWithLLM(title).catch(() => {});
  }

  return keywordResult;
}

/**
 * Awaits the full pipeline (keyword + LLM) and returns the best result.
 * LLM result wins if its confidence >= keyword confidence.
 */
export async function classifyItemFull(title: string, variant?: string): Promise<ClassificationResult> {
  const keywordResult = classifyByKeyword(title, variant);
  const llmResult = await classifyWithLLM(title);

  if (llmResult && llmResult.confidence >= keywordResult.confidence) {
    return llmResult;
  }
  return keywordResult;
}
