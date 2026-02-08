import { NextRequest, NextResponse } from 'next/server';

/**
 * Server-side proxy for GolfAPI.io requests.
 * Keeps the API key on the server and provides caching headers.
 *
 * Usage:
 *   GET /api/golf?action=search&q=pebble+beach
 *   GET /api/golf?action=club&id=123
 *   GET /api/golf?action=course&id=456
 */

const GOLF_API_BASE = 'https://golfapi.io/api/v1';

function getApiKey(): string | null {
  // Keep key strictly server-side (never expose NEXT_PUBLIC_*).
  return process.env.GOLF_API_KEY || null;
}

function apiHeaders(): HeadersInit {
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
  };
  const key = getApiKey();
  if (key) {
    headers['Authorization'] = `Bearer ${key}`;
  }
  return headers;
}

async function proxyFetch(url: string): Promise<Response> {
  const res = await fetch(url, {
    headers: apiHeaders(),
  });
  return res;
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const action = searchParams.get('action');

  if (!action) {
    return NextResponse.json(
      { error: 'Missing action parameter (search, club, course)' },
      { status: 400 }
    );
  }

  try {
    switch (action) {
      case 'search': {
        const q = searchParams.get('q')?.trim();
        if (!q) {
          return NextResponse.json({ error: 'Missing q parameter' }, { status: 400 });
        }
        const res = await proxyFetch(
          `${GOLF_API_BASE}/clubs?search=${encodeURIComponent(q)}`
        );
        if (!res.ok) {
          return NextResponse.json(
            { error: `GolfAPI error: ${res.status}` },
            { status: res.status }
          );
        }
        const data = await res.json();
        return NextResponse.json(data, {
          headers: { 'Cache-Control': 'public, max-age=3600' },
        });
      }

      case 'club': {
        const id = searchParams.get('id');
        if (!id) {
          return NextResponse.json({ error: 'Missing id parameter' }, { status: 400 });
        }
        const res = await proxyFetch(`${GOLF_API_BASE}/clubs/${id}`);
        if (!res.ok) {
          return NextResponse.json(
            { error: `GolfAPI error: ${res.status}` },
            { status: res.status }
          );
        }
        const data = await res.json();
        return NextResponse.json(data, {
          headers: { 'Cache-Control': 'public, max-age=86400' },
        });
      }

      case 'course': {
        const id = searchParams.get('id');
        if (!id) {
          return NextResponse.json({ error: 'Missing id parameter' }, { status: 400 });
        }
        const res = await proxyFetch(`${GOLF_API_BASE}/courses/${id}`);
        if (!res.ok) {
          return NextResponse.json(
            { error: `GolfAPI error: ${res.status}` },
            { status: res.status }
          );
        }
        const data = await res.json();
        return NextResponse.json(data, {
          headers: { 'Cache-Control': 'public, max-age=86400' },
        });
      }

      default:
        return NextResponse.json(
          { error: `Unknown action: ${action}` },
          { status: 400 }
        );
    }
  } catch (err) {
    console.error('Golf API proxy error:', err);
    return NextResponse.json(
      { error: 'Golf API request failed' },
      { status: 502 }
    );
  }
}
