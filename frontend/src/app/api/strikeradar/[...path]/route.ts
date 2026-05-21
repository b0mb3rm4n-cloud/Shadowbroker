/**
 * StrikeRadar proxy route — forwards /api/strikeradar/* browser calls to a
 * co-located StrikeRadar Pro instance. Mirrors the main /api/[...path]
 * proxy's design (server-side env var, no client bundling, streaming
 * response, request retries for transient backend warmup).
 *
 * This route is part of the fusion v1 integration. See FUSION.md.
 *
 * Browser:  GET /api/strikeradar/api/assessment?country=iran
 * Upstream: GET ${STRIKERADAR_URL}/api/assessment?country=iran
 *
 * STRIKERADAR_URL is a plain server-side env var (not NEXT_PUBLIC_), read
 * at request time. Defaults to http://127.0.0.1:8001 so a local dev
 * `uvicorn main:app --port 8001` works out of the box.
 *
 * Failure mode: when StrikeRadar is unreachable we return 502 with a tiny
 * JSON body so the React widget can detect "fusion offline" and hide
 * itself cleanly — Shadowbroker itself never blocks on this proxy.
 */

import { NextRequest, NextResponse } from 'next/server';

const STRIP_REQUEST = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
  'expect',
]);

const STRIP_RESPONSE = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
  // Node fetch decompresses gzip/br automatically; forwarding these would
  // make the browser try to decode plain bytes again.
  'content-encoding',
  'content-length',
]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function proxy(
  req: NextRequest,
  pathSegments: string[],
): Promise<NextResponse> {
  const strikeradarUrl = (
    process.env.STRIKERADAR_URL ?? 'http://127.0.0.1:8001'
  ).replace(/\/+$/, '');

  // pathSegments comes in as e.g. ["api","assessment"] — we forward verbatim
  // so SR's URL space stays a 1:1 mirror through this proxy.
  const targetUrl = new URL(
    `/${pathSegments.join('/')}`,
    strikeradarUrl,
  );
  targetUrl.search = req.nextUrl.search;

  const forwardHeaders = new Headers();
  req.headers.forEach((value, key) => {
    if (!STRIP_REQUEST.has(key.toLowerCase())) {
      forwardHeaders.set(key, value);
    }
  });
  // Optional shared bearer for hardened deploys.
  const sharedKey = process.env.STRIKERADAR_API_KEY;
  if (sharedKey) {
    forwardHeaders.set('X-API-Key', sharedKey);
  }

  const isBodyless = req.method === 'GET' || req.method === 'HEAD';
  const requestInit: RequestInit & { duplex?: 'half' } = {
    method: req.method,
    headers: forwardHeaders,
    cache: 'no-store',
  };
  if (!isBodyless) {
    const body = await req.text();
    if (body.length > 0) requestInit.body = body;
  }

  // Lightweight retry on transient connection failure (SR cold-start can
  // take a couple of seconds). 4 attempts at 250ms = max ~1s extra latency.
  let upstream: Response | null = null;
  let fetchError: unknown = null;
  const maxAttempts = isBodyless ? 4 : 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      upstream = await fetch(targetUrl.toString(), requestInit);
      fetchError = null;
      break;
    } catch (error) {
      fetchError = error;
      if (attempt >= maxAttempts) {
        console.error('strikeradar proxy upstream fetch failed', {
          method: req.method,
          target: targetUrl.toString(),
          error,
        });
        break;
      }
      await sleep(250);
    }
  }

  if (!upstream) {
    return new NextResponse(
      JSON.stringify({
        ok: false,
        error: 'strikeradar_unavailable',
        detail:
          fetchError instanceof Error ? fetchError.message : 'fetch_failed',
        target: targetUrl.toString(),
      }),
      {
        status: 502,
        headers: {
          'Content-Type': 'application/json',
          'X-Proxy-Error':
            fetchError instanceof Error ? fetchError.name : 'fetch_failed',
          'Cache-Control': 'no-store, max-age=0',
        },
      },
    );
  }

  const responseHeaders = new Headers();
  upstream.headers.forEach((value, key) => {
    if (!STRIP_RESPONSE.has(key.toLowerCase())) {
      responseHeaders.set(key, value);
    }
  });
  // SR responses are small JSON; don't cache (scores change every cycle).
  responseHeaders.set('Cache-Control', 'no-store, max-age=0');

  if (upstream.status === 304) {
    return new NextResponse(null, { status: 304, headers: responseHeaders });
  }
  return new NextResponse(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  return proxy(req, (await params).path);
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  return proxy(req, (await params).path);
}
