// Server-side link to SiteStar PROTECT, the service on the laptop wired to the physical model.
// PROTECT_URL points at it (a tunnel URL when the app runs in the cloud). Server routes only: every call goes through
// protectFetch, which adds the shared PROTECT_TOKEN that PROTECT requires on anything reaching it through a tunnel.

export const PROTECT_BASE = (process.env.PROTECT_URL || 'http://127.0.0.1:8796').replace(/\/$/, '');

export type ProjectRef = { id: string; name: string; city?: string; type?: string };

/** fetch() against PROTECT with the shared token. `path` starts with "/api/". */
export function protectFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const token = process.env.PROTECT_TOKEN?.trim();
  if (token) headers.set('X-Protect-Token', token);
  return fetch(`${PROTECT_BASE}${path}`, { cache: 'no-store', ...init, headers });
}

/** Connect the physical model to this project. Returns false when PROTECT is not reachable. */
export async function linkHardware(project: ProjectRef, by: 'dashboard' | 'deploy'): Promise<boolean> {
  try {
    const r = await protectFetch('/api/haven/link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: project.id,
        name: project.name,
        city: project.city ?? '',
        type: project.type ?? '',
        by,
      }),
      signal: AbortSignal.timeout(by === 'deploy' ? 1500 : 4000),
    });
    return r.ok;
  } catch {
    return false;
  }
}
