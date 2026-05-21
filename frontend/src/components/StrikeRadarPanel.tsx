/**
 * StrikeRadarPanel — fusion v1 floating panel.
 *
 * Renders a compact strike-risk dashboard powered by a co-located
 * StrikeRadar Pro instance (via /api/strikeradar/* proxy). Self-hiding:
 * if SR is not reachable the panel returns null and adds zero overhead
 * to the rest of Shadowbroker.
 *
 * Layout: bottom-right floating card stack, collapsible. Each tracked
 * country gets a row with flag + name + score badge + level. Click a
 * row to expand the per-signal breakdown.
 *
 * See FUSION.md (root of this repo + strikeradar/) for the full design.
 */
'use client';

import React, { useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDown, ChevronUp, Crosshair, RefreshCw, ExternalLink } from 'lucide-react';
import { useStrikeRadar, type StrikeRadarAssessment } from '@/hooks/useStrikeRadar';

interface StrikeRadarPanelProps {
  /** Optional callback when user clicks the "fly to country" icon. */
  onFlyTo?: (country: { slug: string; iso: string }) => void;
}

// ── Visual helpers ──────────────────────────────────────────────────────────

// Visual style buckets. SR returns its own `risk_level` string ("IMMINENT",
// "HIGH", "ELEVATED", "GUARDED", "LOW", "QUIET") and `alert_color` hex —
// we mostly defer to those, falling back to numeric bucketing only when
// the assessment hasn't arrived yet.
function levelClasses(score: number, srLevel?: string): {
  text: string; bg: string; ring: string; label: string;
} {
  const lvl = (srLevel || '').toUpperCase();
  if (lvl === 'IMMINENT' || lvl === 'CRITICAL' || score >= 75) return {
    text: 'text-red-300', bg: 'bg-red-950/70', ring: 'ring-red-500/60',
    label: lvl || 'CRITICAL',
  };
  if (lvl === 'HIGH' || lvl === 'ELEVATED' || score >= 55) return {
    text: 'text-orange-300', bg: 'bg-orange-950/70', ring: 'ring-orange-500/60',
    label: lvl || 'ELEVATED',
  };
  if (lvl === 'GUARDED' || score >= 35) return {
    text: 'text-yellow-300', bg: 'bg-yellow-950/70', ring: 'ring-yellow-500/60',
    label: lvl || 'GUARDED',
  };
  if (lvl === 'LOW' || score >= 15) return {
    text: 'text-cyan-300', bg: 'bg-cyan-950/70', ring: 'ring-cyan-500/60',
    label: lvl || 'LOW',
  };
  return {
    text: 'text-green-300', bg: 'bg-green-950/70', ring: 'ring-green-500/60',
    label: lvl || 'QUIET',
  };
}

function fmtScore(n: number | undefined): string {
  if (typeof n !== 'number' || Number.isNaN(n)) return '—';
  return n.toFixed(0);
}

// ── Per-country card ────────────────────────────────────────────────────────

function CountryCard({
  flag, displayName, slug, iso, assessment, expanded, onToggle, onFlyTo,
}: {
  flag: string;
  displayName: string;
  slug: string;
  iso: string;
  assessment: StrikeRadarAssessment | undefined;
  expanded: boolean;
  onToggle: () => void;
  onFlyTo?: StrikeRadarPanelProps['onFlyTo'];
}) {
  const score = assessment?.probability;
  const cls = levelClasses(score ?? 0, assessment?.risk_level);
  const topSignals = (assessment?.signals ?? [])
    .filter((s) => s.score > 0 && s.status !== 'simulated')
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);

  return (
    <div className={`rounded border border-[var(--border-primary)] ${cls.bg} backdrop-blur-sm overflow-hidden`}>
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center gap-2 px-2 py-1.5 hover:bg-white/5 transition-colors text-left"
      >
        <span className="text-lg leading-none">{flag}</span>
        <div className="flex-1 min-w-0">
          <div className="text-[11px] font-bold text-[var(--text-primary)] truncate">
            {displayName}
          </div>
          <div className={`text-[9px] tracking-widest font-bold ${cls.text}`}>
            {assessment ? cls.label : 'AWAITING'}
          </div>
        </div>
        <div className={`text-2xl font-mono font-black ${cls.text} tabular-nums`}>
          {fmtScore(score)}
        </div>
        {expanded
          ? <ChevronUp size={14} className="text-[var(--text-muted)]" />
          : <ChevronDown size={14} className="text-[var(--text-muted)]" />}
      </button>

      <AnimatePresence initial={false}>
        {expanded && assessment && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="overflow-hidden"
          >
            <div className="px-2 pb-2 pt-1 border-t border-white/5 space-y-1">
              {topSignals.length === 0 && (
                <div className="text-[9px] text-[var(--text-muted)] italic">
                  No active contributors.
                </div>
              )}
              {topSignals.map((s) => {
                const sc = levelClasses(s.score, undefined);
                return (
                  <div key={s.key || s.name} className="flex items-center gap-1.5">
                    <div className="flex-1 min-w-0">
                      <div className="text-[10px] text-[var(--text-primary)] truncate">
                        {s.name}
                      </div>
                      <div className="h-1 bg-black/40 rounded-sm overflow-hidden">
                        <div
                          className={`h-full ${sc.text.replace('text-', 'bg-')}`}
                          style={{ width: `${Math.max(0, Math.min(100, s.score))}%` }}
                        />
                      </div>
                    </div>
                    <span className={`text-[10px] font-mono ${sc.text} tabular-nums w-7 text-right`}>
                      {s.score.toFixed(0)}
                    </span>
                  </div>
                );
              })}
              {onFlyTo && (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onFlyTo({ slug, iso }); }}
                  className="mt-1 w-full flex items-center justify-center gap-1 text-[9px] uppercase tracking-widest text-cyan-400 hover:text-cyan-300 py-0.5 border border-cyan-900/40 hover:border-cyan-600/60 rounded-sm"
                >
                  <Crosshair size={9} />
                  Fly to {iso}
                </button>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ── Main panel ──────────────────────────────────────────────────────────────

export default function StrikeRadarPanel({ onFlyTo }: StrikeRadarPanelProps) {
  const { available, loading, error, countries, assessments, refresh } = useStrikeRadar();
  const [panelOpen, setPanelOpen] = useState(true);
  const [expandedSlug, setExpandedSlug] = useState<string | null>(null);

  const handleToggleRow = useCallback((slug: string) => {
    setExpandedSlug((prev) => (prev === slug ? null : slug));
  }, []);

  // SR not available → render nothing. Shadowbroker is unaffected.
  if (!available && !loading) return null;
  // Probe still in flight → render nothing yet (avoids flash of skeleton).
  if (loading) return null;

  return (
    <motion.div
      initial={{ opacity: 0, x: 40 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: 0.4, duration: 0.3 }}
      className="fixed bottom-12 right-3 z-[7500] pointer-events-auto w-[260px]"
    >
      <div className="bg-[var(--bg-secondary)]/80 backdrop-blur-xl border border-[var(--border-primary)] rounded-md shadow-[0_10px_40px_rgba(0,0,0,0.6)] overflow-hidden">
        <div className="flex items-center gap-1.5 px-2 py-1 bg-black/30 border-b border-[var(--border-primary)]">
          <Crosshair size={11} className="text-red-400" />
          <span className="text-[10px] font-bold tracking-widest text-[var(--text-primary)]">
            STRIKERADAR
          </span>
          <span className="text-[9px] text-[var(--text-muted)] uppercase">fusion v1</span>
          <div className="flex-1" />
          <button
            type="button"
            onClick={refresh}
            title="Refresh now"
            className="text-[var(--text-muted)] hover:text-cyan-400 transition-colors"
          >
            <RefreshCw size={10} />
          </button>
          <a
            href="/api/strikeradar/api/health"
            target="_blank"
            rel="noopener noreferrer"
            title="StrikeRadar health"
            className="text-[var(--text-muted)] hover:text-cyan-400 transition-colors"
          >
            <ExternalLink size={10} />
          </a>
          <button
            type="button"
            onClick={() => setPanelOpen((v) => !v)}
            className="text-[var(--text-muted)] hover:text-cyan-400 transition-colors"
            title={panelOpen ? 'Collapse' : 'Expand'}
          >
            {panelOpen ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
          </button>
        </div>

        <AnimatePresence initial={false}>
          {panelOpen && (
            <motion.div
              initial={{ height: 0 }}
              animate={{ height: 'auto' }}
              exit={{ height: 0 }}
              transition={{ duration: 0.18 }}
              className="overflow-hidden"
            >
              <div className="p-2 space-y-1.5">
                {error && (
                  <div className="text-[9px] text-orange-300 bg-orange-950/40 border border-orange-900/40 rounded-sm px-1.5 py-1">
                    {error}
                  </div>
                )}
                {countries.length === 0 && !error && (
                  <div className="text-[10px] text-[var(--text-muted)] italic text-center py-2">
                    No tracked countries.
                  </div>
                )}
                {countries.map((c) => (
                  <CountryCard
                    key={c.slug}
                    flag={c.flag}
                    displayName={c.display_name}
                    slug={c.slug}
                    iso={c.iso}
                    assessment={assessments[c.slug]}
                    expanded={expandedSlug === c.slug}
                    onToggle={() => handleToggleRow(c.slug)}
                    onFlyTo={onFlyTo}
                  />
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}
