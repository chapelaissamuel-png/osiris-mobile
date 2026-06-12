'use client';

import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';

interface Exchange { name: string; country: string; open: boolean; }
interface CountryRisk { code: string; risk_score: number; risk_level: string; tags: string[]; }

const RISK_TOOLTIPS: Record<string, string> = {
  CRITICAL: 'Active conflict, sanctions, or major instability detected',
  HIGH: 'Elevated threat level — ongoing tensions or security concerns',
  ELEVATED: 'Moderate risk — political instability or regional disputes',
  LOW: 'Stable — no significant threats detected',
};

export default function GlobalStatusBar() {
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const [risks, setRisks] = useState<CountryRisk[]>([]);
  const [cyber, setCyber] = useState<any>(null);
  const [openCount, setOpenCount] = useState(0);
  const [hoveredRisk, setHoveredRisk] = useState<CountryRisk | null>(null);
  const [anomalyCount, setAnomalyCount] = useState(0);
  const [anomalyHover, setAnomalyHover] = useState(false);
  const [anomalyList, setAnomalyList] = useState<any[]>([]);
  const [focalCount, setFocalCount] = useState(0);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const [riskRes, cyberRes] = await Promise.allSettled([
          fetch('/api/country-risk'),
          fetch('/api/cyber-threats'),
        ]);
        if (riskRes.status === 'fulfilled' && riskRes.value.ok) {
          const d = await riskRes.value.json();
          setExchanges(d.exchanges || []);
          setRisks(d.countries || []);
          setOpenCount(d.open_exchanges || 0);
        }
        if (cyberRes.status === 'fulfilled' && cyberRes.value.ok) {
          setCyber(await cyberRes.value.json());
        }
      } catch (e) { console.warn('[OSIRIS] Suppressed error:', e instanceof Error ? e.message : e); }
    };
    fetchData();
    const iv = setInterval(fetchData, 1800000);
    return () => clearInterval(iv);
  }, []);

  useEffect(() => {
    const fetchIntel = async () => {
      try {
        const [anomRes, fpRes] = await Promise.allSettled([
          fetch('/api/temporal-anomalies'),
          fetch('/api/focal-points'),
        ]);
        if (anomRes.status === 'fulfilled' && anomRes.value.ok) {
          const d = await anomRes.value.json();
          const list: any[] = d.anomalies || [];
          setAnomalyCount(list.length);
          setAnomalyList(list.slice(0, 5));
        }
        if (fpRes.status === 'fulfilled' && fpRes.value.ok) {
          const d = await fpRes.value.json();
          setFocalCount(d.total || 0);
        }
      } catch (e) { console.warn('[OSIRIS] Intel fetch error:', e instanceof Error ? e.message : e); }
    };
    fetchIntel();
    const iv = setInterval(fetchIntel, 300000); // 5 min
    return () => clearInterval(iv);
  }, []);

  const topRisks = risks.slice(0, 6);
  const cveCount = cyber?.stats?.active_cves || 0;

  const riskColor = (level: string) =>
    level === 'CRITICAL' ? '#FF3D3D' : level === 'HIGH' ? '#FF9500' : level === 'ELEVATED' ? '#FFD700' : '#00E676';

  const countryFlag = (code: string) => {
    try {
      return String.fromCodePoint(...code.toUpperCase().split('').map(c => 0x1F1E6 + c.charCodeAt(0) - 65));
    } catch { return code; }
  };

  if (exchanges.length === 0 && risks.length === 0) return null;

  const tickerContent = (
    <>
      {exchanges.map(ex => (
        <span key={ex.name} className="inline-flex items-center gap-0.5 mx-2">
          <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${ex.open ? 'bg-[var(--alert-green)]' : 'bg-[var(--text-muted)]/30'}`} />
          <span className={`${ex.open ? 'text-[var(--text-primary)]' : 'text-[var(--text-muted)]/40'}`}>{ex.name}</span>
        </span>
      ))}
      <span className="text-[var(--border-primary)] mx-1">|</span>
      {topRisks.map(r => (
        <span
          key={r.code}
          className="inline-flex items-center gap-0.5 mx-1.5 relative cursor-help pointer-events-auto"
          onMouseEnter={() => setHoveredRisk(r)}
          onMouseLeave={() => setHoveredRisk(null)}
        >
          <span className="text-[10px]">{countryFlag(r.code)}</span>
          <span style={{ color: riskColor(r.risk_level) }} className="font-bold">{r.risk_score}</span>
        </span>
      ))}
      <span className="text-[var(--border-primary)] mx-1">|</span>
      <span className="inline-flex items-center gap-1 mx-2">
        <span className="text-[#E040FB]">CYBER</span>
        <span className="text-[var(--text-primary)]">{cveCount} CVEs</span>
      </span>
      <span className="text-[var(--border-primary)] mx-1">|</span>
      {focalCount > 0 && (
        <span className="inline-flex items-center gap-1 mx-2">
          <span className="w-1.5 h-1.5 rounded-full bg-orange-400 animate-osiris-pulse flex-shrink-0" />
          <span className="text-orange-400 font-bold">{focalCount}</span>
          <span className="text-[var(--text-muted)]">FOCAL PTS</span>
        </span>
      )}
      <span
        className="inline-flex items-center gap-1 mx-2 cursor-help pointer-events-auto relative"
        onMouseEnter={() => setAnomalyHover(true)}
        onMouseLeave={() => setAnomalyHover(false)}
      >
        <span className={anomalyCount > 0 ? 'text-yellow-400 font-bold' : 'text-[var(--text-muted)]'}>
          {anomalyCount}
        </span>
        <span className="text-[var(--text-muted)]">ANOMALIES</span>
        {anomalyCount > 0 && <span className="w-1 h-1 rounded-full bg-yellow-400 animate-osiris-pulse flex-shrink-0" />}
      </span>
    </>
  );

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ delay: 4, duration: 0.8 }}
      className="hidden md:block absolute bottom-0 left-0 right-0 z-[198] pointer-events-none"
    >
      <div className="h-[22px] overflow-hidden bg-black/90 border-t border-[var(--cyan-primary)]/40 flex items-center text-[8px] font-mono tracking-wider backdrop-blur-md relative" style={{ boxShadow: '0 -4px 20px rgba(0, 229, 255, 0.1)' }}>
        {/* Animated glitch line overlay */}
        <div className="absolute top-0 left-0 right-0 h-[1px] bg-gradient-to-r from-transparent via-[var(--cyan-primary)] to-transparent opacity-50" style={{ animation: 'hud-scanline 3s linear infinite' }} />
        
        {/* Static label */}
        <div className="flex-shrink-0 px-3 h-full flex items-center gap-1 border-r border-[var(--cyan-primary)]/30 bg-black pointer-events-auto relative z-10 shadow-[4px_0_10px_rgba(0,0,0,0.5)]">
          <span className="text-[var(--cyan-primary)]/50">MKT</span>
          <span className="text-[var(--cyan-primary)] font-bold">{openCount}/{exchanges.length}</span>
        </div>

        {/* CSS-animated ticker */}
        <div className="flex-1 overflow-hidden relative" style={{ maskImage: 'linear-gradient(to right, transparent, black 5%, black 95%, transparent)' }}>
          <div className="flex items-center animate-ticker whitespace-nowrap">
            {tickerContent}
            {tickerContent}
          </div>
        </div>
      </div>

      {/* Anomaly tooltip */}
      {anomalyHover && anomalyCount > 0 && (
        <div className="absolute bottom-[28px] right-1/4 z-[300] pointer-events-none">
          <div className="glass-panel px-3 py-2 text-[10px] font-mono whitespace-nowrap" style={{ borderColor: 'rgba(250,204,21,0.4)', minWidth: '220px' }}>
            <div className="text-yellow-400 font-bold mb-2 tracking-widest text-[9px]">TEMPORAL ANOMALIES</div>
            {anomalyList.map((a: any, i: number) => (
              <div key={i} className="flex items-center gap-2 mb-1">
                <span className="text-yellow-400 font-bold text-[9px]">Z{a.z_score?.toFixed(1) ?? '?'}</span>
                <span className="text-[var(--text-secondary)] text-[9px]">{a.type} · {a.region ?? 'Global'}</span>
                <span className={`text-[8px] font-bold ${a.severity === 'critical' ? 'text-red-400' : a.severity === 'high' ? 'text-orange-400' : 'text-yellow-400'}`}>
                  {a.severity?.toUpperCase()}
                </span>
              </div>
            ))}
            {anomalyCount > 5 && <div className="text-[var(--text-muted)] text-[8px]">+{anomalyCount - 5} more</div>}
          </div>
        </div>
      )}

      {/* Hover tooltip for risk scores */}
      {hoveredRisk && (
        <div
          className="absolute bottom-[28px] left-1/2 -translate-x-1/2 z-[300] pointer-events-none"
        >
          <div className="glass-panel px-3 py-2 text-[10px] font-mono text-center whitespace-nowrap" style={{ borderColor: `${riskColor(hoveredRisk.risk_level)}40` }}>
            <div className="flex items-center gap-2 mb-1">
              <span className="text-[12px]">{countryFlag(hoveredRisk.code)}</span>
              <span className="font-bold" style={{ color: riskColor(hoveredRisk.risk_level) }}>
                {hoveredRisk.risk_level}
              </span>
              <span className="text-[var(--text-muted)]">Score: {hoveredRisk.risk_score}/100</span>
            </div>
            <div className="text-[9px] text-[var(--text-secondary)]">
              {RISK_TOOLTIPS[hoveredRisk.risk_level] || 'Risk assessment based on global threat data'}
            </div>
            {hoveredRisk.tags?.length > 0 && (
              <div className="flex gap-1 mt-1 justify-center flex-wrap">
                {hoveredRisk.tags.slice(0, 3).map(t => (
                  <span key={t} className="px-1.5 py-0.5 rounded text-[8px]" style={{ backgroundColor: `${riskColor(hoveredRisk.risk_level)}15`, color: riskColor(hoveredRisk.risk_level) }}>
                    {t}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </motion.div>
  );
}
