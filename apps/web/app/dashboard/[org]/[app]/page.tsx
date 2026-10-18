import { redirect } from 'next/navigation';

export default async function AppIndex({ params }: { params: Promise<{ org: string; app: string }> }) {
  const { org, app } = await params;
  redirect(`/dashboard/${encodeURIComponent(org)}/${encodeURIComponent(app)}/queries`);
}
