
import { NextResponse } from 'next/server';

/**
 * OSIRIS — Space Weather API
 *
 * Sources (all NOAA SWPC, 100% free, no key):
 *   1. Kp index        — current geomagnetic storm level (1-min planetary K)
 *   2. RTSW solar wind — real-time solar wind from DSCOVR/ACE at L1: speed, density, Bz_GSM
 *   3. GOES X-ray      — solar flare detections (latest)
 *   4. 3-day Kp forecast — predicted storm activity window
 *   5. NOAA alerts     — watches, warnings, emergencies
 *
 * Tactical relevance (OSIRIS):
 *   Bz_GSM < -10 nT   → HF radio blackout / military comms disruption
 *   Kp ≥ 5            → GPS position errors + satellite drag increases
 *   X-class flare      → shortwave radio blackout, sun-facing hemisphere
 *   G4+ storm (Kp ≥ 7) → power grid GIC risk, pipeline corrosion, satellite ops disrupted
 */

interface SolarWindReading {
  time_tag:    string;
  speed:       number;   // km/s — solar wind bulk speed
  density:     number;   // protons/cm³
  temperature: number;   // Kelvin
  bx_gsm:      number;   // nT
  by_gsm:      number;   // nT
  bz_gsm:      number;   // nT — negative (southward) = energy input to magnetosphere
  source:      string;   // DSCOVR or ACE
}

const SWPC = {
  kp_1min:     'https://services.swpc.noaa.gov/json/planetary_k_index_1m.json',
  solar_wind:  'https://services.swpc.noaa.gov/json/rtsw/rtsw_wind_1m.json',
  flares:      'https://services.swpc.noaa.gov/json/goes/primary/xray-flares-latest.json',
  kp_forecast: 'https://services.swpc.noaa.gov/json/noaa_planetary_k_index_forecast.json',
  alerts:      'https://services.swpc.noaa.gov/json/alerts.json',
} as const;

function stormLevel(kp: number): { level: string; color: string } {
  if (kp >= 8) return { level: 'Extreme (G5)',  color: '#FF1744' };
  if (kp >= 7) return { level: 'Severe (G4)',   color: '#FF3D3D' };
  if (kp >= 6) return { level: 'Strong (G3)',   color: '#FF9500' };
  if (kp >= 5) return { level: 'Moderate (G2)', color: '#FFD700' };
  if (kp >= 4) return { level: 'Minor (G1)',    color: '#FFD700' };
  if (kp >= 3) return { level: 'Unsettled',     color: '#D4AF37' };
  return { level: 'Quiet', color: '#00E676' };
}

/** Tactical ops impact assessment based on current space weather */
function assessImpact(kp: number, bz: number, topFlare: string) {
  const isX = topFlare.startsWith('X');
  const isM = topFlare.startsWith('M');

  const hf_radio =
    isX      ? '🔴 Blackout (R3+) — HF comms disrupted, sun-facing hemisphere'
    : isM    ? '🟡 Minor blackout risk — HF degraded on dayside'
    : kp >= 6 ? '🟡 Polar cap absorption — HF polar routes degraded'
    :           '🟢 Normal';

  const gps =
    kp >= 7  ? '🔴 Severe scintillation — GPS accuracy degraded globally'
    : kp >= 5 ? '🟡 Scintillation — accuracy reduced at high latitudes'
    : isX    ? '🟡 Ionospheric disturbance — single-freq GPS affected'
    :           '🟢 Normal';

  const satellite =
    kp >= 8  ? '🔴 G4/G5 — LEO orbital decay surge, charging risk extreme'
    : kp >= 5 ? '🟡 Elevated drag — LEO adjustments may be needed'
    : bz < -15 ? '🟡 Southward IMF — surface charging elevated'
    :           '🟢 Normal';

  const power_grid =
    kp >= 7  ? '🔴 GIC risk — transformer damage possible at high latitudes'
    : kp >= 5 ? '🟡 Minor induced currents — high-latitude grids watch'
    :           '🟢 Normal';

  const affected = [hf_radio, gps, satellite, power_grid].filter(s => !s.startsWith('🟢'));
  return {
    hf_radio, gps, satellite, power_grid,
    summary: affected.length === 0
      ? 'Space weather quiet — all systems nominal'
      : `${affected.length} system${affected.length > 1 ? 's' : ''} affected`,
  };
}

export async function GET() {
  try {
    const [kpRes, windRes, flareRes, forecastRes, alertsRes] = await Promise.allSettled([
      fetch(SWPC.kp_1min,     { signal: AbortSignal.timeout(8000) }).then(r => r.json()),
      fetch(SWPC.solar_wind,  { signal: AbortSignal.timeout(8000) }).then(r => r.json()),
      fetch(SWPC.flares,      { signal: AbortSignal.timeout(8000) }).then(r => r.json()),
      fetch(SWPC.kp_forecast, { signal: AbortSignal.timeout(8000) }).then(r => r.json()),
      fetch(SWPC.alerts,      { signal: AbortSignal.timeout(8000) }).then(r => r.json()),
    ]);

    // ── Kp (current) ──────────────────────────────────────────────────────────
    let kpIndex     = 0;
    let kpTimestamp = '';
    if (kpRes.status === 'fulfilled' && Array.isArray(kpRes.value) && kpRes.value.length > 0) {
      const latest = kpRes.value[kpRes.value.length - 1];
      kpIndex      = parseFloat(latest.kp_index ?? latest.Kp ?? 0);
      kpTimestamp  = latest.time_tag ?? '';
    }
    const { level: storm_level, color: storm_color } = stormLevel(kpIndex);

    // ── Solar wind (RTSW DSCOVR/ACE) ─────────────────────────────────────────
    let solar_wind: Partial<SolarWindReading> = {};
    if (windRes.status === 'fulfilled' && Array.isArray(windRes.value)) {
      // Find most recent entry with valid speed + bz
      const valid = windRes.value.filter((d: any) => d.speed != null && d.bz_gsm != null);
      if (valid.length > 0) {
        const d = valid[valid.length - 1];
        solar_wind = {
          time_tag:    d.time_tag,
          speed:       Math.round(d.speed ?? 0),
          density:     Math.round((d.density ?? 0) * 10) / 10,
          temperature: Math.round(d.temperature ?? 0),
          bx_gsm:      Math.round((d.bx_gsm ?? 0) * 10) / 10,
          by_gsm:      Math.round((d.by_gsm ?? 0) * 10) / 10,
          bz_gsm:      Math.round((d.bz_gsm ?? 0) * 10) / 10,
          source:      d.source ?? 'DSCOVR',
        };
      }
    }
    const bz = (solar_wind as SolarWindReading).bz_gsm ?? 0;
    const bz_status =
      bz < -20 ? '🔴 Extreme southward IMF — major geomagnetic storm energy input'
      : bz < -10 ? '🟠 Strong southward IMF — storm likely'
      : bz < -5  ? '🟡 Moderate southward IMF — minor storm possible'
      : bz > 5   ? '🟢 Northward IMF — magnetosphere shielded'
      :             '⚪ Near-neutral IMF';

    // ── Solar flares ──────────────────────────────────────────────────────────
    const solar_flares: any[] = [];
    let topFlare = 'A0.0';
    if (flareRes.status === 'fulfilled' && Array.isArray(flareRes.value)) {
      for (const f of flareRes.value.slice(0, 8)) {
        if (!f.max_class) continue;
        solar_flares.push({ class: f.max_class, begin: f.begin_time, peak: f.max_time, end: f.end_time });
        if (f.max_class > topFlare) topFlare = f.max_class;
      }
    }

    // ── 3-day Kp forecast ─────────────────────────────────────────────────────
    const kp_forecast: any[] = [];
    if (forecastRes.status === 'fulfilled' && Array.isArray(forecastRes.value)) {
      for (const f of forecastRes.value.slice(0, 72)) {
        kp_forecast.push({ time_tag: f.time_tag, kp: parseFloat(f.kp ?? 0), observed: f.observed ?? 'predicted' });
      }
    }
    const max_forecast_kp = kp_forecast.length > 0 ? Math.max(...kp_forecast.map(f => f.kp)) : kpIndex;

    // ── NOAA alerts ───────────────────────────────────────────────────────────
    const alerts: any[] = [];
    if (alertsRes.status === 'fulfilled' && Array.isArray(alertsRes.value)) {
      for (const a of alertsRes.value.slice(0, 10)) {
        alerts.push({ id: a.product_id, issue_datetime: a.issue_datetime, message: (a.message ?? '').substring(0, 250) });
      }
    }

    const impact = assessImpact(kpIndex, bz, topFlare);

    return NextResponse.json({
      kp_index:       kpIndex,
      storm_level,
      storm_color,
      kp_timestamp:   kpTimestamp,
      solar_wind,
      bz_status,
      solar_flares,
      top_flare:      topFlare,
      alerts,
      kp_forecast,
      max_forecast_kp,
      impact,
      source: 'NOAA SWPC — Kp 1-min + RTSW solar wind (DSCOVR/ACE) + GOES flares + 3-day forecast',
      timestamp: new Date().toISOString(),
    });

  } catch (error) {
    console.error('[OSIRIS/SpaceWeather] Fatal:', error);
    return NextResponse.json(
      { kp_index: 0, storm_level: 'Unknown', storm_color: '#555', alerts: [], solar_flares: [], error: 'Failed' },
      { status: 500 }
    );
  }
}
