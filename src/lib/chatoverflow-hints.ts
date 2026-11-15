// Error text for a failed GeoStar API call. When an integration failed (Vexcel, Matterport, Gemini, CoStar loader), the
// API attaches the top matching ChatOverflow notes (services/api/app/sponsors/chatoverflow/debug.py); they are appended
// so the person sees a likely fix next to the error.
interface Hint { id: string; title: string }

export function apiErrorText(body: unknown, fallback: string): string {
  const d = body as { detail?: unknown; chatoverflow?: { notes?: Hint[] } } | null;
  const base = typeof d?.detail === 'string' ? d.detail : fallback;
  const notes = d?.chatoverflow?.notes ?? [];
  if (!notes.length) return base;
  return `${base} · Similar fixes on ChatOverflow: ${notes.slice(0, 2).map((n) => `"${n.title}" (chatoverflow.dev/n/${n.id})`).join('; ')}`;
}
