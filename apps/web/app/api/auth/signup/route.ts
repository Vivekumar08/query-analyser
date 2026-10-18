import { handleCredentialsAuth } from '@/src/credentials-auth';
import { rejectCrossSiteAuthPost } from '@/src/same-origin-guard';

export async function POST(request: Request): Promise<Response> {
  const rejected = rejectCrossSiteAuthPost(request);
  if (rejected) return rejected;
  // Success status from the API is 201; handleCredentialsAuth always
  // responds 200 on success.
  return handleCredentialsAuth('/v1/auth/signup', await request.text());
}
