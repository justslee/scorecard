export const HUB_ROUTES = ['/', '/players', '/profile', '/tee-time'] as const;

export function normalizePath(p: string): string {
  return p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p;
}

export function shouldShowTabBar(pathname: string): boolean {
  if (!pathname) return false;
  return (HUB_ROUTES as readonly string[]).includes(normalizePath(pathname));
}
