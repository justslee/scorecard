import { Suspense } from 'react';
import CourseEditorClient from './CourseEditorClient';

export default function CourseEditorPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-zinc-950 text-zinc-100 p-4">Loading editor…</div>}>
      <CourseEditorClient />
    </Suspense>
  );
}
