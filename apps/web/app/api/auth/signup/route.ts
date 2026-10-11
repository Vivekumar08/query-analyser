import { handleCredentialsAuth } from '@/src/credentials-auth';

export async function POST(request: Request): Promise<Response> {
  // Success status from the API is 201; handleCredentialsAuth always
  // responds 200 on success.
  return handleCredentialsAuth('/v1/auth/signup', await request.text());
}
