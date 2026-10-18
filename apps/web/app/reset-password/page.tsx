import { ResetClient } from '../_components/ResetClient';

export default async function ResetPasswordPage({
  searchParams,
}: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 px-4">
      <h1 className="text-2xl font-semibold">Choose a new password</h1>
      {token
        ? <ResetClient token={token} />
        : <p className="text-slate-600">This link is missing its token. Use the link from your email.</p>}
    </main>
  );
}
