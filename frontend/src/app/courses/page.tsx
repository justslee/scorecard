'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { CourseListItem } from '@/lib/courses/types';

export default function CoursesPage() {
  const [courses, setCourses] = useState<CourseListItem[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/courses?search=${encodeURIComponent(search)}`);
      const data = await res.json();
      setCourses(Array.isArray(data.courses) ? data.courses : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load courses');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <div className="max-w-3xl mx-auto p-4">
        <div className="flex items-center justify-between gap-3 mb-4">
          <h1 className="text-xl font-semibold">Courses</h1>
          <Link
            href="/courses/editor"
            className="px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-sm"
          >
            New Course
          </Link>
        </div>

        <div className="flex gap-2 mb-4">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && load()}
            placeholder="Search by name or address"
            className="flex-1 px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-sm"
          />
          <button
            onClick={load}
            className="px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-sm hover:bg-zinc-800"
          >
            Search
          </button>
        </div>

        {loading ? (
          <div className="text-zinc-400">Loading…</div>
        ) : error ? (
          <div className="text-red-400">{error}</div>
        ) : courses.length === 0 ? (
          <div className="text-zinc-400">No saved courses yet.</div>
        ) : (
          <div className="space-y-2">
            {courses.map((c) => (
              <div
                key={c.id}
                className="p-3 rounded-xl bg-zinc-900 border border-zinc-800 flex items-center justify-between gap-3"
              >
                <div className="min-w-0">
                  <div className="font-medium truncate">{c.name}</div>
                  {c.address ? (
                    <div className="text-xs text-zinc-400 truncate">{c.address}</div>
                  ) : null}
                </div>
                <Link
                  href={`/courses/editor?id=${encodeURIComponent(c.id)}`}
                  className="px-3 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-sm"
                >
                  Edit
                </Link>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
