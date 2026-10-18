import { handleCredentialsAuth } from '@/src/credentials-auth';
import { rejectCrossSiteAuthPost } from '@/src/same-origin-guard';

export async function POST(request: Request): Promise<Response> {
  const rejected = rejectCrossSiteAuthPost(request);
  if (rejected) return rejected;
  return handleCredentialsAuth('/v1/auth/login', await request.text());
}
