import { createClerkClient, verifyToken } from '@clerk/nextjs/server';
import { guardOrigin, HttpError, routeError } from '@/lib/http';
import { mongo } from '@/lib/mongo';

// Saves the signed-in Clerk user to MongoDB Atlas (collection `users`, one document per Clerk user id).
// Called once per session by the account controls with the user's session token. The token is verified here with
// the Clerk secret key, so this route needs no request middleware. Clerk stays the source of truth for credentials;
// Atlas keeps the GeoStar profile: who they are, when they joined and last signed in, and how many sessions they had.
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    guardOrigin(req);
    const secretKey = process.env.CLERK_SECRET_KEY;
    if (!secretKey) throw new HttpError(503, 'Sign-in is not configured on this server.');
    const token = req.headers.get('authorization')?.replace(/^Bearer /, '') || '';
    if (!token) throw new HttpError(401, 'Sign in first.');
    let userId: string;
    try {
      userId = (await verifyToken(token, { secretKey })).sub;
    } catch {
      throw new HttpError(401, 'Your session has expired. Sign in again.');
    }
    const user = await createClerkClient({ secretKey }).users.getUser(userId);
    const db = await mongo();
    if (!db) throw new HttpError(503, 'MongoDB is not configured on this server.');

    const users = db.collection('users');
    await users.createIndex({ clerk_id: 1 }, { unique: true });
    const now = new Date();
    const email = user.primaryEmailAddress?.emailAddress ?? user.emailAddresses[0]?.emailAddress ?? null;
    const name = [user.firstName, user.lastName].filter(Boolean).join(' ') || user.username || null;
    const result = await users.findOneAndUpdate(
      { clerk_id: userId },
      {
        $set: {
          email,
          name,
          image_url: user.imageUrl ?? null,
          sign_in_methods: user.externalAccounts.map((a) => a.provider),
          last_seen_at: now,
        },
        $setOnInsert: { clerk_id: userId, created_at: now, clerk_created_at: new Date(user.createdAt) },
        $inc: { sessions: 1 },
      },
      { upsert: true, returnDocument: 'after', projection: { _id: 0 } },
    );
    return Response.json({ stored: true, user: result }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return routeError(error);
  }
}
