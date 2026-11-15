import { cartesiaConfigured, TTS_MODEL } from '@/lib/hey-geo/cartesia';

export const dynamic = 'force-dynamic';

/** Whether this server can speak and listen with Cartesia. Never includes the key. */
export function GET() {
  const on = cartesiaConfigured();
  return Response.json({ tts: on, stt: on, model: on ? TTS_MODEL : null }, { headers: { 'Cache-Control': 'no-store' } });
}
