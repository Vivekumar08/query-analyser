import { handleCredentialsAuth } from '@/src/credentials-auth';

export async function POST(request: Request): Promise<Response> {
  return handleCredentialsAuth('/v1/auth/login', await request.text());
}
