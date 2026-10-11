import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Query Analyser',
  description: 'Find the queries costing you the most time.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-white text-slate-900 antialiased">{children}</body>
    </html>
  );
}
