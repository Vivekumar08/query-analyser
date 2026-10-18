import { GlassCard } from './GlassCard';

/**
 * Static, illustrative preview of the dashboard for the homepage hero.
 * Fetches nothing — the numbers are examples, not anyone's data.
 */
const ROWS = [
  { model: 'Order', op: 'find', time: '4.2s', share: 100 },
  { model: 'User', op: 'aggregate', time: '1.1s', share: 28 },
  { model: 'Cart', op: 'findOne', time: '640ms', share: 16 },
];

export function ProductPreview() {
  return (
    <GlassCard className="p-5">
      <div aria-label="Example dashboard preview">
        <div className="mb-3 flex items-center justify-between">
          <span className="text-xs text-caption">Time wasted · last 24h</span>
          <span className="rounded-full bg-accent px-2.5 py-0.5 text-[11px] font-medium text-accent-text">● live</span>
        </div>
        <ul className="flex flex-col gap-3 text-sm">
          {ROWS.map((r) => (
            <li key={r.model}>
              <div className="flex justify-between">
                <span>
                  <span className="font-semibold">{r.model}</span>.{r.op}
                </span>
                <span className="font-semibold tabular-nums">{r.time}</span>
              </div>
              <div className="mt-1.5 h-1.5 rounded-full bg-muted">
                <div className="h-full rounded-full bg-chart-1" style={{ width: `${r.share}%`, opacity: 0.4 + r.share / 166 }} />
              </div>
            </li>
          ))}
        </ul>
        <svg viewBox="0 0 300 60" className="mt-4 h-14 w-full" aria-hidden>
          <path d="M0,48 C40,46 60,22 100,28 C140,34 160,12 200,16 C240,20 270,36 300,26 L300,60 L0,60Z" fill="var(--chart-1)" opacity="0.12" />
          <path d="M0,48 C40,46 60,22 100,28 C140,34 160,12 200,16 C240,20 270,36 300,26" fill="none" stroke="var(--chart-1)" strokeWidth="2" />
        </svg>
        <div className="mt-3 rounded-lg bg-accent/60 px-3 py-2 font-mono text-[11.5px] text-foreground">
          Order.collection.createIndex({'{'} email: 1, total: -1 {'}'})
        </div>
      </div>
    </GlassCard>
  );
}
