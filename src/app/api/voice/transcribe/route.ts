/** POST /api/voice/transcribe: one recorded question (the request body is the audio) → { text } from Cartesia Ink. */
import { guardOrigin } from '@/lib/http';
import { CartesiaError, cartesiaConfigured, transcribe } from '@/lib/hey-geo/cartesia';

export const dynamic = 'force-dynamic';
const MAX_AUDIO = 4 * 1024 * 1024;

export async function POST(request: Request) {
  if (!cartesiaConfigured()) return Response.json({ error: 'Cartesia is not configured on this server.' }, { status: 503 });
  try {
    guardOrigin(request);
  } catch {
    return Response.json({ error: 'Cross-origin requests are not allowed.' }, { status: 403 });
  }
  const audio = await request.blob();
  if (!audio.size || audio.size > MAX_AUDIO) return Response.json({ error: 'Record a question of up to about a minute.' }, { status: 400 });
  try {
    return Response.json({ text: await transcribe(audio, request.signal) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[transcribe]', error instanceof CartesiaError ? error.message : 'Cartesia request failed');
    return Response.json({ error: 'Cartesia could not transcribe that.' }, { status: 502 });
  }
}
