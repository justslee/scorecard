import { NextRequest, NextResponse } from 'next/server';
import { findNearbyCourses } from '@/lib/courses/storage';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const lat = Number(searchParams.get('lat'));
  const lng = Number(searchParams.get('lng'));
  const radiusMeters = searchParams.get('radiusMeters')
    ? Number(searchParams.get('radiusMeters'))
    : undefined;

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return NextResponse.json({ error: 'lat and lng are required' }, { status: 400 });
  }

  const courses = await findNearbyCourses({ lat, lng, radiusMeters });
  return NextResponse.json({ courses });
}
