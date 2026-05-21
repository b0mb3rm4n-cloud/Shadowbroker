# Shadowbroker ↔ StrikeRadar Pro — Fusion v1

This fork integrates StrikeRadar Pro into Shadowbroker as a side-by-side
fusion: SR consumes SB's live sensor telemetry to sharpen its country
strike-risk scores, and SB renders those scores as a floating panel in
the dashboard.

**Upstream Shadowbroker is unmodified** in spirit — every change in this
fork is a pure addition (one new proxy route, one hook, one component,
one line in `app/page.tsx`, one compose overlay, this doc). You can
`git fetch upstream && git merge upstream/main` without conflicts.

---

## 1. Architecture

```
┌─────────────────────────┐               ┌──────────────────────────┐
│   Shadowbroker          │               │   StrikeRadar Pro        │
│   (this fork)           │               │   (~/strikeradar)        │
│                         │               │                          │
│   Next.js frontend  ────┼── widget ────▶│   /api/countries         │
│   :3000                 │  (browser)    │   /api/assessment        │
│                         │  via SB       │   /api/health            │
│   Next.js proxy    ────►│  proxy        │                          │
│   /api/strikeradar/* ──┼──────────────▶│                          │
│                         │  (Docker net)  │                          │
│   FastAPI backend  ◀────┼── SR signal ──│   ShadowbrokerSignal     │
│   :8000                 │  every cycle  │   /api/live-data/fast    │
│   /api/live-data/fast   │               │   /api/sar/anomalies     │
│   /api/sar/anomalies    │               │   /api/health            │
│   /api/health           │               │                          │
└─────────────────────────┘               └──────────────────────────┘
```

Both directions degrade silently when the other side is unreachable:
SB's panel hides itself when the SR proxy returns 502, and SR's
`ShadowbrokerSignal` returns a no-op simulated result when SB is down.

---

## 2. What was added in this fork

| File | Purpose | LOC |
|---|---|---|
| `frontend/src/app/api/strikeradar/[...path]/route.ts` | Server-side proxy forwarding `/api/strikeradar/*` → `${STRIKERADAR_URL}/*`. Mirrors the existing SB `/api/[...path]` route. | ~140 |
| `frontend/src/hooks/useStrikeRadar.ts` | React hook that probes SR health, polls `/api/countries` + per-country `/api/assessment` every 60s, self-disables on failure. | ~120 |
| `frontend/src/components/StrikeRadarPanel.tsx` | Floating bottom-right panel rendering one card per tracked country with score, level, and top-3 contributing signals. Self-hiding. | ~210 |
| `frontend/src/app/page.tsx` | One import line + one `<StrikeRadarPanel>` mount inside the existing modal stack. | +18 |
| `docker-compose.fusion.yml` | Overlay that builds SB images from this fork's source, brings up SR alongside, and wires `STRIKERADAR_URL` / `SHADOWBROKER_BASE_URL`. | ~110 |
| `.env.fusion.example` | Env template for the overlay (SB keys + SR keys + cross-auth). | ~35 |
| `FUSION.md` | This file. | — |

**Zero modifications** to:
- The SB backend (FastAPI)
- `MaplibreViewer.tsx`, `MaplibreViewer/`, `map/layers/`
- Any of the 20+ existing panel components
- Upstream proxy `/api/[...path]/route.ts`
- The Dockerfile or any build script

---

## 3. Local bring-up (compose overlay)

Prerequisites: `~/Shadowbroker` (this fork) and `~/strikeradar` (the SR
repo) sitting side-by-side. Docker Engine + Compose v2 installed.

```bash
cd ~/Shadowbroker
cp .env.fusion.example .env.fusion          # then edit secrets
docker compose --env-file .env.fusion \
               -f docker-compose.yml \
               -f docker-compose.fusion.yml up -d --build
```

First build takes 3–6 min (SR + SB frontend compile). Subsequent rebuilds
are cached.

Verify:

```bash
curl -s http://localhost:8000/api/health | head -c 200          # Shadowbroker backend
curl -s http://localhost:8080/api/health | head -c 200          # StrikeRadar backend
curl -s http://localhost:3000/api/strikeradar/api/health        # SR via SB proxy (302+JSON)
xdg-open http://localhost:3000                                   # SB UI — panel bottom-right
```

To turn the SR-side ShadowbrokerSignal on (so SR actually uses SB
telemetry), edit `~/strikeradar/profiles/iran.yaml` (and `ukraine.yaml`,
`taiwan.yaml`) and flip:

```yaml
shadowbroker:
  enabled: true          # was false
```

Then add `"shadowbroker"` to the same file's `enabled_signals:` list and
rebalance `weights:` so they still sum to 1.0 (suggested first cut: take
0.04 each from `news`, `military_activity`, `prediction_markets`, and
`geopolitical` to give `shadowbroker: 0.16`). Restart SR:

```bash
docker compose -f docker-compose.yml -f docker-compose.fusion.yml \
               up -d --build strikeradar
```

---

## 4. Keeping the fork in sync with upstream Shadowbroker

The fusion code lives in **new files only** (plus an 18-line additive
edit to `app/page.tsx`). Merges from upstream should be conflict-free
99% of the time.

```bash
cd ~/Shadowbroker
git fetch upstream
git merge upstream/main          # on a release branch, or:
# git checkout fusion/strikeradar-v1
# git rebase upstream/main
```

If `app/page.tsx` conflicts (only happens if upstream touches the same
modal-stack region), the merge marker will be local to the
`<StrikeRadarPanel>` block — keep both sides and re-add the import.

Rebuild after merge:

```bash
docker compose -f docker-compose.yml -f docker-compose.fusion.yml \
               up -d --build frontend backend
```

---

## 5. Contract & API surface

The full bidirectional API contract is documented in
**`INTEGRATION.md`** (lives in both repos; keep them in lock-step).
Quick summary:

**SR → SB** (Python `ShadowbrokerSignal` calls these):
- `GET /api/health`
- `GET /api/live-data/fast`
- `GET /api/sar/anomalies`

**SB → SR** (React `useStrikeRadar` calls these, via `/api/strikeradar/*` proxy):
- `GET /api/health`
- `GET /api/countries`
- `GET /api/assessment?country=<slug>`

---

## 6. Disabling the fusion

To use this fork as plain Shadowbroker (no SR panel, no SB→SR proxy),
just bring up without the overlay:

```bash
docker compose -f docker-compose.yml up -d
```

The proxy route at `/api/strikeradar/*` still exists in the image but
returns 502 (no upstream); the React panel detects this via its health
probe and renders `null`, so the dashboard looks exactly like upstream
SB.

---

## 7. Roadmap (post-v1)

These are intentionally **not** in v1 to keep the diff minimal:

- **MapLibre choropleth layer** colouring country polygons by SR score
  on the main map. Requires a country-polygons GeoJSON and one new
  layer module under `frontend/src/components/map/layers/`.
- **Click country on map → open SR detail panel**. Needs a click
  handler on the choropleth layer above.
- **SB → SR "early warning" push**: SR exposes a webhook that SB
  invokes when a tracked telemetry threshold trips (e.g. ≥10 adversary
  mil aircraft in a threat zone). Avoids polling overhead, reduces
  reaction time from ~60s to seconds.
- **Per-signal sparkline** in the panel using SR's `/api/history`.
- **Authenticated mode** using SB's existing admin-session token to
  gate the SR proxy.

Open an issue on the fork (`b0mb3rm4n-cloud/Shadowbroker`) tagged
`fusion-v1.x` to discuss.
