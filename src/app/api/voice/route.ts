/**
 * GET /api/voice?kind=answer&token=…[&format=pcm] → Geo's answer as streamed audio (Cartesia Sonic).
 * MP3 by default, or raw 16-bit mono PCM that the page schedules chunk by chunk.
 *
 * The page names WHAT to speak, never the words: the token was issued by /api/hey-geo for text the server produced
 * itself and expires after ten minutes. 503 tells the page to use the browser's own voice.
 */
import { CartesiaError, cartesiaConfigured, PCM_RATE, speak } from '@/lib/hey-geo/cartesia';
import { voiceTokenText } from '@/lib/hey-geo/voice-tokens';

export const dynamic = 'force-dynamic';
const refuse = (status: number, error: string) => Response.json({ error }, { status, headers: { 'Cache-Control': 'no-store' } });

export async function GET(request: Request) {
  if (!cartesiaConfigured()) return refuse(503, 'Cartesia is not configured on this server.');
  const params = new URL(request.url).searchParams;
  if (params.get('kind') !== 'answer') return refuse(400, 'Expected kind=answer.');
  const text = voiceTokenText(params.get('token') ?? '');
  if (!text) return refuse(404, 'That answer has expired. Ask again.');
  try {
    const pcm = params.get('format') === 'pcm';
    const { stream, firstAudioMs } = await speak(text.slice(0, 2000), request.signal, pcm ? 'pcm' : 'mp3');
    return new Response(stream, {
      headers: {
        'Content-Type': pcm ? `audio/L16;rate=${PCM_RATE};channels=1` : 'audio/mpeg',
        'Cache-Control': 'no-store',
        'Server-Timing': `cartesia;desc="Cartesia time to first audio";dur=${firstAudioMs}`,
      },
    });
  } catch (error) {
    console.error('[voice]', error instanceof CartesiaError ? error.message : 'Cartesia request failed');
    return refuse(502, 'Cartesia could not speak this right now.');
  }
}
