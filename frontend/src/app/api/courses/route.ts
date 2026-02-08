import { NextRequest, NextResponse } from 'next/server';
import { CourseData } from '@/lib/courses/types';

const hasSupabase = !!(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);

export async function GET(request: NextRequest) {
  if (!hasSupabase) {
    return NextResponse.json({ courses: [] });
  }
  const { listCourses } = await import('@/lib/courses/storage');
  const { searchParams } = new URL(request.url);
  const search = searchParams.get('search') || undefined;
  const courses = await listCourses({ search });
  return NextResponse.json({ courses });
}

export async function POST(request: NextRequest) {
  if (!hasSupabase) {
    return NextResponse.json({ error: 'Supabase not configured' }, { status: 501 });
  }
  try {
    const { upsertCourse } = await import('@/lib/courses/storage');
    const body = (await request.json()) as CourseData;
    if (!body?.id || !body?.name) {
      return NextResponse.json({ error: 'Missing id or name' }, { status: 400 });
    }
    const saved = await upsertCourse(body);
    return NextResponse.json({ course: saved });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Failed to create course' },
      { status: 500 }
    );
  }
}
