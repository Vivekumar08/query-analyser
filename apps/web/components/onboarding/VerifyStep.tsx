'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export function VerifyStep({ email }: { email: string }) {
  const router = useRouter();
  const [sending, setSending] = useState(false);

  // The link is usually opened in another tab; re-resolve the step when the
  // user comes back. The server component re-renders with fresh /v1/me.
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') router.refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [router]);

  const resend = async () => {
    setSending(true);
    try {
      const res = await fetch('/api/auth/verify-request', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      if (res.ok) toast.success('Email sent');
      else toast.error('Something went wrong. Please try again.');
    } catch {
      toast.error('Something went wrong. Please try again.');
    } finally {
      setSending(false);
    }
  };

  return (
    <Card>
      <CardHeader><CardTitle>Verify your email</CardTitle></CardHeader>
      <CardContent className="flex flex-col gap-4 text-sm">
        <p className="text-muted-foreground">We sent a link to <strong className="text-foreground">{email}</strong>. Click it, then come back here.</p>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={resend} disabled={sending}>
            {sending && <Loader2 className="size-4 animate-spin" aria-hidden />} Resend email
          </Button>
          <Button onClick={() => router.refresh()}>I&apos;ve verified, continue</Button>
        </div>
      </CardContent>
    </Card>
  );
}
