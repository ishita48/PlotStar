import 'server-only';
import { MongoClient, type Db } from 'mongodb';

// One MongoDB Atlas connection per server process (the same cluster the GeoStar API uses: MONGODB_URI / MONGODB_DB).
let client: MongoClient | null = null;
let connecting: Promise<MongoClient> | null = null;

export async function mongo(): Promise<Db | null> {
  const uri = process.env.MONGODB_URI;
  if (!uri) return null;
  if (!client) {
    connecting ??= new MongoClient(uri, { serverSelectionTimeoutMS: 8000, appName: 'geostar-web' }).connect();
    try {
      client = await connecting;
    } catch (error) {
      connecting = null;
      throw error;
    }
  }
  return client.db(process.env.MONGODB_DB || 'plotstar');
}
