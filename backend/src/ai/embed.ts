import { config } from '../config.js';
import { EMBED_LADDER } from './models.js';

// NVIDIA NIM embeddings (OpenAI-compatible /v1/embeddings). Dormant until
// NVIDIA_API_KEY exists: every caller MUST treat null as "no embeddings" and keep
// working off FULLTEXT alone. Ladder ids from NIM docs 2026-08-25 (unverified live).

const BATCH = 32; // NIM caps inputs per request; keep batches small and predictable

async function embedWith(model: string, texts: string[], inputType: 'passage' | 'query'): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    const slice = texts.slice(i, i + BATCH);
    const r = await fetch(`${config.nvidia.baseUrl}/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.nvidia.apiKey}` },
      body: JSON.stringify({ model, input: slice, input_type: inputType, truncate: 'END', encoding_format: 'float' }),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`${model} ${r.status}: ${text.slice(0, 200)}`);
    const data = (JSON.parse(text).data || []) as { index?: number; embedding: number[] }[];
    if (data.length !== slice.length) throw new Error(`${model}: got ${data.length} vectors for ${slice.length} inputs`);
    for (const d of data.sort((a, b) => (a.index ?? 0) - (b.index ?? 0))) out.push(d.embedding);
  }
  return out;
}

/** Embed texts via the NIM ladder. Returns null when no key is set or every id
 *  failed — callers fall back to keyword search rather than storing garbage. */
/** Returns the vectors AND the model that produced them: vector spaces from different
 *  models are incomparable, so callers must store the model and re-embed on change. */
export async function embedTexts(texts: string[], inputType: 'passage' | 'query' = 'passage'): Promise<{ model: string; vectors: number[][] } | null> {
  if (!config.nvidia.apiKey || !texts.length) return null;
  const ladder = config.nvidia.model && EMBED_LADDER.includes(config.nvidia.model)
    ? [config.nvidia.model, ...EMBED_LADDER.filter((m) => m !== config.nvidia.model)]
    : EMBED_LADDER;
  const errs: string[] = [];
  for (const model of ladder) {
    try {
      return { model, vectors: await embedWith(model, texts, inputType) };
    } catch (e: any) {
      errs.push(`${model}: ${String(e?.message || e).slice(0, 120)}`);
    }
  }
  console.error(`[embed] all NIM embedding models failed — ${errs.join(' | ')}`);
  return null;
}
