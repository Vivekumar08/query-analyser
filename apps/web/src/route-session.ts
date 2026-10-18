import { NextResponse } from 'next/server';
import { getSession, type Session } from './auth';

/** Route-handler gate: the session, or a 401 to return. Never redirects. */
export async function sessionOr401(): Promise<{ session: Session } | { response: Response }> {
  const session = await getSession();
  if (!session) return { response: NextResponse.json({ error: 'unauthorized' }, { status: 401 }) };
  return { session };
}
