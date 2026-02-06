import { NextRequest, NextResponse } from 'next/server';
import { listCourses, upsertCourse } from '@/lib/courses/storage';
import { CourseData } from '@/lib/courses/types';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const search = searchParams.get('search') || undefined;

  const courses = await listCourses({ search });
  return NextResponse.json({ courses });
}

export async function POST(request: NextRequest) {
  try {
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
