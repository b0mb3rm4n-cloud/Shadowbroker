/**
 * useStrikeRadar — fusion v1 client hook.
 *
 * Polls a co-located StrikeRadar Pro instance through Shadowbroker's
 * /api/strikeradar/* proxy and exposes a compact view of risk scores
 * per tracked country.
 *
 * Design:
 *   - One probe call to /api/strikeradar/api/health at mount → decides
 *     `available`. If false, the hook is a no-op for the rest of its life
 *     so the panel can render nothing without uselessly polling.
 *   - When available, fetches /api/countries once, then /api/assessment?country=<slug>
 *     for each country in parallel, repeating every REFRESH_MS.
 *   - Errors never throw; they just leave `data` empty + `error` set, and
 *     the panel renders a "stale" badge.
 *
 * See FUSION.md for the cross-repo contract.
 */
'use client';

import { useEffect, useState, useRef, useCallback } from 'react';

export interface StrikeRadarCountry {
  slug: string;
  iso: string;
  display_name: string;
  flag: string;
  region: string;
  attackers: string[];
  signal_count: number;
}

export interface StrikeRadarSignal {
  name: string;
  key: string;
  score: number;
  confidence: number;
  status: string;     // live | stale | error | simulated
  detail?: string;
}

export interface StrikeRadarAssessment {
  country?: string;
  // SR returns:
  //   probability:   0..100 composite (the "score" we display)
  //   risk_level:    string label, e.g. "IMMINENT" | "HIGH" | "ELEVATED" | ...
  //   alert_color:   hex color SR has already chosen for the level
  //   signals:       full per-signal breakdown
  probability: number;
  risk_level?: string;
  alert_color?: string;
  weighted_score?: number;
  bayesian_score?: number;
  raw_score?: number;
  escalation_multiplier?: number;
  signals: StrikeRadarSignal[];
  timestamp?: string;
  trend_8h?: number;
  trend_72h?: number;
  methodology?: string;
  // Warm-up sentinel: when present and equal to "loading" the rest of
  // the fields are missing and this entry should be ignored.
  status?: string;
}

export interface UseStrikeRadarResult {
  available: boolean;
  loading: boolean;
  error: string | null;
  countries: StrikeRadarCountry[];
  assessments: Record<string, StrikeRadarAssessment>;
  refresh: () => void;
}

const PROXY_BASE = '/api/strikeradar';
const REFRESH_MS = 60_000;
const PROBE_TIMEOUT_MS = 6_000;

async function fetchJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, {
    cache: 'no-store',
    signal,
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} on ${url}`);
  }
  return (await res.json()) as T;
}

export function useStrikeRadar(): UseStrikeRadarResult {
  const [available, setAvailable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [countries, setCountries] = useState<StrikeRadarCountry[]>([]);
  const [assessments, setAssessments] = useState<Record<string, StrikeRadarAssessment>>({});
  const refreshTokenRef = useRef(0);
  const mountedRef = useRef(true);

  const tick = useCallback(async () => {
    const myToken = ++refreshTokenRef.current;
    try {
      // SR's /api/countries returns {"countries":[...]} not a bare array.
      // Tolerate both shapes so a contract change on either side doesn't
      // immediately break this hook.
      const raw = await fetchJson<unknown>(`${PROXY_BASE}/api/countries`);
      const list: StrikeRadarCountry[] = Array.isArray(raw)
        ? (raw as StrikeRadarCountry[])
        : ((raw as { countries?: StrikeRadarCountry[] })?.countries ?? []);
      if (!mountedRef.current || myToken !== refreshTokenRef.current) return;
      setCountries(list);
      const results = await Promise.allSettled(
        list.map((c) =>
          fetchJson<StrikeRadarAssessment>(
            `${PROXY_BASE}/api/assessment?country=${encodeURIComponent(c.slug)}`,
          ).then((a) => [c.slug, a] as const),
        ),
      );
      if (!mountedRef.current || myToken !== refreshTokenRef.current) return;
      const next: Record<string, StrikeRadarAssessment> = {};
      for (const r of results) {
        if (r.status === 'fulfilled') {
          // Skip warmup responses ({"status":"loading",...}) — they
          // lack the `probability` field. The panel shows "AWAITING"
          // for any country missing from this map.
          const a = r.value[1];
          if (a && typeof a.probability === 'number') {
            next[r.value[0]] = a;
          }
        }
      }
      setAssessments(next);
      setError(null);
    } catch (e) {
      if (!mountedRef.current) return;
      setError(e instanceof Error ? e.message : 'fetch_failed');
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  // One-shot probe: only enable polling if the proxy is wired up & SR is up.
  useEffect(() => {
    mountedRef.current = true;
    const ctrl = new AbortController();
    const timeoutId = window.setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
    (async () => {
      try {
        const res = await fetch(`${PROXY_BASE}/api/health`, {
          cache: 'no-store',
          signal: ctrl.signal,
        });
        window.clearTimeout(timeoutId);
        if (res.ok) {
          if (!mountedRef.current) return;
          setAvailable(true);
          tick();
        } else {
          if (!mountedRef.current) return;
          setAvailable(false);
          setLoading(false);
        }
      } catch {
        window.clearTimeout(timeoutId);
        if (!mountedRef.current) return;
        setAvailable(false);
        setLoading(false);
      }
    })();
    return () => {
      mountedRef.current = false;
      ctrl.abort();
      window.clearTimeout(timeoutId);
    };
  }, [tick]);

  // Polling loop — only runs once `available` flips true.
  useEffect(() => {
    if (!available) return undefined;
    const handle = window.setInterval(tick, REFRESH_MS);
    return () => window.clearInterval(handle);
  }, [available, tick]);

  return {
    available,
    loading,
    error,
    countries,
    assessments,
    refresh: tick,
  };
}
