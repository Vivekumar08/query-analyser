/**
 * The Mist palette as hex values. app/globals.css mirrors these exactly (a test
 * checks that), and contrast.test.ts holds every text token to WCAG AA.
 */
export const MIST = {
  base: '#F7F8FC',
  hazeBlue: '#DCE6FF',
  hazeLilac: '#EADFFB',
  hazeSky: '#E3EEFF',
  ink: '#1E2235',
  muted: '#5A607A',
  caption: '#5C627C',
  // Spec's #6A72C9 measures ~4.1:1; darkened until small text passes AA on the base, strong glass and every haze stop.
  accentText: '#5259AC',
  // Bars and chart strokes only — about 3.3:1, never used for text.
  accentChart: '#7C83D6',
  border: '#E3E6F3',
  glassAlpha: 0.7,
  glassStrongAlpha: 0.9,
} as const;
