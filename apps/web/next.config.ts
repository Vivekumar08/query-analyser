import type { NextConfig } from 'next';

const config: NextConfig = {
  // The Dockerfile copies `.next/standalone`, which only exists with this set.
  // Without it the image has no server to run and the container exits.
  output: 'standalone',
};

export default config;
