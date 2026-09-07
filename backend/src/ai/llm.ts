import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import {
  PROVIDERS, isConfigured, isPoisoned, providerConfig, resolveChain, firstFor,
  type ProviderName, type Task, type ResolvedEntry,
 TASKS } from './models.js';
import { recordLlmCall } from './activity.js';

export type { ProviderName, Task };
export type Tool = { name: string; description: string; parameters: any };

type OpenAICompat = { name: ProviderName; baseUrl: string; apiKey: string; model: string };

/** Which provider answers a task first. Chains + ids live in ai/models.ts. */
export function providerFor(task: Task): ProviderName | null {
  return firstFor(task)?.provider ?? null;
}

/** The model id that task will hit first (for provenance columns). */
export function modelFor(task: Task): string | null {
  return firstFor(task)?.model ?? null;
}

export function aiReady(): boolean {
  return PROVIDERS.some(isConfigured);
}

const LABEL: Record<ProviderName, string> = { muse: 'Muse', anthropic: 'Claude', kimi: 'Kimi', groq: 'Groq', nvidia: 'NVIDIA', local: 'Local' };

export function aiLabel(): string {
  const one = (t: Task) => {
    const e = firstFor(t);
    return e ? `${LABEL[e.provider]} ${e.model}` : 'none';
  };
  const missing = TASKS.filter((t) => !firstFor(t));
  return `research: ${one('research')} · chat: ${one('chat')}${missing.length ? ` · NO PROVIDER for: ${missing.join(', ')}` : ''}`;
}

export function aiProvider(): ProviderName | null { return providerFor('research'); }

export function aiShort(): string {
  const cap = (p: ProviderName | null) => (p ? LABEL[p] : null);
  // Watch lead + chat lead (Muse when configured) is the desk lamp.
  const names = [...new Set([cap(providerFor('watch')), cap(providerFor('chat'))].filter(Boolean))];
  return names.length ? names.join(' + ') : 'no AI key';
}

let anth: Anthropic | null = null;
function anthropic(): Anthropic {
  if (!anth) anth = new Anthropic({ apiKey: config.anthropic.apiKey });
  return anth;
}

function ocFor(e: ResolvedEntry): OpenAICompat {
  const c = providerConfig(e.provider);
  if (!c.apiKey && e.provider !== 'local') throw new Error(`${e.provider} not configured`);
  return { name: e.provider, baseUrl: c.baseUrl, apiKey: c.apiKey, model: e.model };
}

const FAST_TASKS: Task[] = ['chat', 'triage', 'watch', 'performance'];

/** Per-model request shaping (patterns proven in the frida project, 2026-08):
 *  gpt-oss takes reasoning_effort; nemotron/deepseek need thinking switched OFF
 *  (prefix + chat_template_kwargs) and room to answer; Kimi wants temperature 1. */
function shapeBody(oc: OpenAICompat, task: Task, body: any): any {
  const m = oc.model.toLowerCase();
  const out: any = { model: oc.model, temperature: oc.name === 'kimi' || oc.name === 'muse' ? 1 : 0.2, ...body };
  if (m.includes('gpt-oss')) out.reasoning_effort = FAST_TASKS.includes(task) ? 'low' : 'medium';
  // Muse Spark always reasons; reasoning_effort:"none" is HTTP 400. Meta tunes it for temperature 1.0.
  if (oc.name === 'muse' || m.includes('muse-spark')) {
    out.reasoning_effort = FAST_TASKS.includes(task) ? 'low' : 'high';
    out.temperature = 1;
  }
  if (/nemotron|deepseek/.test(m)) {
    // Nemotron-3 reads enable_thinking, older nemotron/deepseek templates read thinking; send both.
    out.chat_template_kwargs = { ...(out.chat_template_kwargs || {}), thinking: false, enable_thinking: false };
    out.max_tokens = Math.max(1600, Number(out.max_tokens) || 0);
    const msgs: any[] = Array.isArray(out.messages) ? out.messages : [];
    out.messages = msgs[0]?.role === 'system'
      ? [{ ...msgs[0], content: `/no_think\n${msgs[0].content}` }, ...msgs.slice(1)]
      : [{ role: 'system', content: '/no_think' }, ...msgs];
  }
  return out;
}

/** Reasoning models leak their scratchpad into content. Never let it reach a caller. */
function stripThink(s: string): string {
  if (!s) return '';
  let out = s.replace(/<think>[\s\S]*?<\/think>/gi, '');
  const last = [...out.matchAll(/<\/think>/gi)].pop(); // unterminated opener (index on the ORIGINAL string)
  if (last && last.index != null) out = out.slice(last.index + last[0].length);
  return out.trim();
}

async function openaiChat(oc: OpenAICompat, task: Task, body: any): Promise<any> {
  const r = await fetch(`${oc.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(oc.apiKey ? { authorization: `Bearer ${oc.apiKey}` } : {}) },
    body: JSON.stringify(shapeBody(oc, task, body)),
    signal: AbortSignal.timeout(oc.name === 'nvidia' ? 45_000 : 120_000), // a hung NIM rung must not stall the chain; Kimi research may legitimately run long
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${oc.name} ${oc.model} ${r.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

function poisonCheck(p: ProviderName): void {
  if (!isPoisoned(p)) return;
  console.warn(`[llm] ${p} poisoned via LLM_POISON_PROVIDERS (disaster drill)`);
  throw new Error(`${p} poisoned via LLM_POISON_PROVIDERS`);
}

/** Attach provenance without polluting JSON.stringify of the parsed payload. */
function withMeta(obj: any, e: ResolvedEntry): any {
  if (obj && typeof obj === 'object') {
    Object.defineProperty(obj, '_provider', { value: e.provider, enumerable: false });
    Object.defineProperty(obj, '_model', { value: e.model, enumerable: false });
  }
  return obj;
}

const NO_PROVIDER = 'No AI provider configured (set META_MUSE_API_KEY / GROQ_API_KEY / NVIDIA_API_KEY / KIMI_API_KEY / ANTHROPIC_API_KEY)';

/** Single completion expected to return JSON.
 *  LAW (2026-08-24): cascade on ANY per-model error (404 decommission, 400, 429,
 *  5xx, timeout) — a missing key just means the provider isn't in the chain. */
export async function llmJSON(system: string, user: string, task: Task = 'research'): Promise<any> {
  const chain = resolveChain(task);
  if (!chain.length) throw new Error(NO_PROVIDER);
  const prompt = user + '\n\nRespond with ONLY a valid JSON object, no prose, no markdown fences.';
  const errs: string[] = [];
  for (const e of chain) {
    try {
      poisonCheck(e.provider);
      recordLlmCall({ provider: e.provider, task, model: e.model, phase: 'start' });
      let raw = '';
      if (e.provider === 'anthropic') {
        const res: any = await (anthropic().messages.create as any)({
          model: e.model, max_tokens: 2000, thinking: { type: 'adaptive' },
          system, messages: [{ role: 'user', content: prompt }],
        });
        raw = (res.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n');
      } else {
        const res = await openaiChat(ocFor(e), task, {
          response_format: { type: 'json_object' },
          messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
        });
        raw = stripThink(res.choices?.[0]?.message?.content || '');
      }
      console.log(`[llm] ${task} answered by ${e.provider} ${e.model}`);
      recordLlmCall({ provider: e.provider, task, model: e.model, phase: 'ok' });
      return withMeta(parseJSONLoose(raw), e);
    } catch (err: any) {
      const msg = String(err?.message || err).slice(0, 160);
      recordLlmCall({ provider: e.provider, task, model: e.model, phase: 'error', detail: msg });
      errs.push(`${e.provider} ${e.model}: ${msg}`);
      console.error(`[llm] ${e.provider} ${e.model} failed (${task}): ${msg} — cascading to next model`);
    }
  }
  throw new Error(`all providers failed (${task}) — ${errs.join(' | ')}`);
}

/** Agentic tool loop. Provider-agnostic. */
export async function llmAgent(
  system: string,
  userPrompt: string,
  tools: Tool[],
  runTool: (name: string, args: any) => Promise<any>,
  task: Task = 'agent',
  maxIters = 8,
  opts?: { readOnlyTools?: boolean }, // read-only tool sets (SQL/knowledge lookups) may safely re-run on cascade
): Promise<{ text: string; calls: { name: string; args: any; result: any }[]; provider: ProviderName; model: string }> {
  const chain = resolveChain(task);
  if (!chain.length) throw new Error(NO_PROVIDER);
  const errs: string[] = [];
  for (const e of chain) {
    try {
      poisonCheck(e.provider);
      recordLlmCall({ provider: e.provider, task, model: e.model, phase: 'start' });
      const out = await agentWith(e, task, system, userPrompt, tools, runTool, maxIters);
      console.log(`[llm] ${task} answered by ${e.provider} ${e.model}`);
      recordLlmCall({ provider: e.provider, task, model: e.model, phase: 'ok' });
      return { ...out, provider: e.provider, model: e.model };
    } catch (err: any) {
      const msg = String(err?.message || err).slice(0, 160);
      recordLlmCall({ provider: e.provider, task, model: e.model, phase: 'error', detail: msg });
      errs.push(`${e.provider} ${e.model}: ${msg}`);
      console.error(`[llm] ${e.provider} ${e.model} agent failed (${task}): ${msg}${err?.toolsRan ? ' — tools already ran, NOT cascading' : ' — cascading to next model'}`);
      if (err?.toolsRan && !opts?.readOnlyTools) throw err; // a re-run on another provider would re-execute side-effectful tools
    }
  }
  throw new Error(`all providers failed (${task}) — ${errs.join(' | ')}`);
}

async function agentWith(
  e: ResolvedEntry,
  task: Task,
  system: string,
  userPrompt: string,
  tools: Tool[],
  runTool: (name: string, args: any) => Promise<any>,
  maxIters: number,
): Promise<{ text: string; calls: { name: string; args: any; result: any }[] }> {
  const calls: { name: string; args: any; result: any }[] = [];
  // ANY throw after a tool has run must abort the cascade — a re-run on another provider
  // would re-execute side-effectful tools. (Gate review 2026-08-24: model-call-only marking
  // let post-tool throws escape unmarked.)
  try {
  if (e.provider === 'anthropic') {
    const aTools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
    const messages: any[] = [{ role: 'user', content: userPrompt }];
    for (let i = 0; i < maxIters; i++) {
      const res: any = await (anthropic().messages.create as any)({
        model: e.model, max_tokens: 4000, thinking: { type: 'adaptive' }, system, tools: aTools, messages,
      });
      if (res.stop_reason !== 'tool_use')
        return { text: (res.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n'), calls };
      messages.push({ role: 'assistant', content: res.content });
      const results: any[] = [];
      for (const b of res.content) {
        if (b.type !== 'tool_use') continue;
        let out: any;
        try { out = await runTool(b.name, b.input); } catch (err: any) { out = { error: err?.message || String(err) }; }
        calls.push({ name: b.name, args: b.input, result: out });
        results.push({ type: 'tool_result', tool_use_id: b.id, content: JSON.stringify(out).slice(0, 12000) });
      }
      messages.push({ role: 'user', content: results });
    }
    return { text: 'Reached max tool iterations.', calls };
  }

  // OpenAI-compatible (Muse / Kimi / Groq / NVIDIA NIM).
  const oc = ocFor(e);
  const oTools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
  const messages: any[] = [{ role: 'system', content: system }, { role: 'user', content: userPrompt }];
  for (let i = 0; i < maxIters; i++) {
    const res = await openaiChat(oc, task, { messages, tools: oTools, tool_choice: 'auto' });
    const msg = res.choices?.[0]?.message;
    if (!msg) break;
    const toolCalls = msg.tool_calls || [];
    if (!toolCalls.length) return { text: stripThink(msg.content || ''), calls };
    messages.push(msg);
    for (const tc of toolCalls) {
      let args: any = {};
      try { args = JSON.parse(tc.function.arguments || '{}'); } catch { args = {}; }
      let out: any;
      try { out = await runTool(tc.function.name, args); } catch (err: any) { out = { error: err?.message || String(err) }; }
      calls.push({ name: tc.function.name, args, result: out });
      messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(out).slice(0, 12000) });
    }
  }
  return { text: 'Reached max tool iterations.', calls };
  } catch (err: any) {
    if (calls.length) err.toolsRan = true;
    throw err;
  }
}

function parseJSONLoose(s: string): any {
  if (!s) return {};
  try { return JSON.parse(s); } catch { /* try extract */ }
  const m = s.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch { /* noop */ } }
  return { _raw: s };
}
