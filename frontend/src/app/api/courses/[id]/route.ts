import { NextRequest, NextResponse } from 'next/server';

const hasSupabase = !!(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);

export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  if (!hasSupabase) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const { getCourse } = await import('@/lib/courses/storage');
  const { id } = await context.params;
  const course = await getCourse(id);
  if (!course) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  return NextResponse.json({ course });
}

export async function PUT(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  if (!hasSupabase) {
    return NextResponse.json({ error: 'Supabase not configured' }, { status: 501 });
  }
  try {
    const { upsertCourse } = await import('@/lib/courses/storage');
    const { CourseData } = await import('@/lib/courses/types');
    const { id } = await context.params;
    const body = (await request.json()) as any;
    const saved = await upsertCourse({ ...body, id });
    return NextResponse.json({ course: saved });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'Failed to update course' },
      { status: 500 }
    );
  }
}

export async function DELETE(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  if (!hasSupabase) {
    return NextResponse.json({ error: 'Supabase not configured' }, { status: 501 });
  }
  const { deleteCourse } = await import('@/lib/courses/storage');
  const { id } = await context.params;
  const res = await deleteCourse(id);
  if (!res.ok) {
    return NextResponse.json({ error: res.error }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
