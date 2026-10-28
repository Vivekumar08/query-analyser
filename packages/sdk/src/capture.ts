import type { MappedStatement } from './command-map.js';
import { redact } from './redact.js';
import { buildSignature, type SignatureResult } from './signature.js';

export const MAX_MODEL_CHARS = 200;
export const MAX_COLLECTION_CHARS = 255;

export interface CapturedShape {
  sig: SignatureResult;
  sample: unknown;
  collection: string;
}

/** Signature, redacted sample and collection of a mapped statement. Truncates to the wire limits. */
export function shapeOf(st: MappedStatement, model: string): CapturedShape {
  const sig = buildSignature({
    model: model.slice(0, MAX_MODEL_CHARS),
    operation: st.operation,
    filter: st.filter,
    sort: st.sort,
    pipeline: st.pipeline,
  });
  const sample = st.sampleInput === null ? null : redact(st.sampleInput);
  return { sig, sample, collection: st.collection.slice(0, MAX_COLLECTION_CHARS) };
}
