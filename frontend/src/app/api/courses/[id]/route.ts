import { NextRequest, NextResponse } from 'next/server';
import { deleteCourse, getCourse, upsertCourse } from '@/lib/courses/storage';
import { CourseData } from '@/lib/courses/types';

export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const course = await getCourse(id);
  if (!course) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  return NextResponse.json({ course });
}

export async function PUT(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const body = (await request.json()) as CourseData;
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
  const { id } = await context.params;
  const res = await deleteCourse(id);
  if (!res.ok) {
    return NextResponse.json({ error: res.error }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
