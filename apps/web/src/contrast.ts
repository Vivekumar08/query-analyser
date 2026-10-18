/**
 * WCAG 2.x contrast helpers. Used as a test-time gate on the Mist palette so a
 * "subtle" grey can never quietly drop below readable contrast.
 */
const rgb = (hex: string): [number, number, number] => {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`Not a #RRGGBB colour: ${hex}`);
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

const channel = (c: number) => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

const luminance = (hex: string) => {
  const [r, g, b] = rgb(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};

export function contrastRatio(fg: string, bg: string): number {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** The opaque colour seen when `fg` at `alpha` sits over `bg`. */
export function compositeOver(fg: string, alpha: number, bg: string): string {
  const f = rgb(fg);
  const b = rgb(bg);
  return `#${f
    .map((c, i) => Math.round(alpha * c + (1 - alpha) * b[i]!).toString(16).padStart(2, '0'))
    .join('')}`;
}
