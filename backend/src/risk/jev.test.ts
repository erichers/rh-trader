import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  JEV_CHOICE_CONF_MIN,
  JEV_COHERENT_MIN,
  JEV_SETUP_SIZE_DOWN,
  JEV_SKIP_CONF_MIN,
  applyJevSizeDown,
  composeJevEntry,
  httpJevClient,
  jevEntryGate,
  jevEntryMode,
  jevEntryQuestion,
  jevEntryQuestions,
  parseJevPanel,
  parseJevPick,
  typesafeConfigured,
  type JevClient,
  type JevPanelAnswers,
} from './jev.js';

function panel(over: Partial<JevPanelAnswers> = {}): JevPanelAnswers {
  return {
    signal_coherent: 0.9,
    action: { choice: 'enter', confidence: 0.88 },
    setup_quality: { score: 1.8, confidence: 0.8 },
    too_crowded_same_day: 0.1,
    ...over,
  };
}

function mockClient(answers: Record<string, unknown>): JevClient {
  return {
    async systemOne() {
      return {
        model: 'jev-latest',
        answers: answers as any,
        usage: { input_tokens: 12, output_tokens: 4 },
      };
    },
  };
}

describe('Jev / TypeSafe entry panel', () => {
  it('parses enter | skip | size_down and exposes the four questions', () => {
    assert.equal(parseJevPick('enter'), 'enter');
    assert.equal(parseJevPick('SKIP'), 'skip');
    assert.equal(parseJevPick('size-down'), 'size_down');
    assert.equal(parseJevPick('nope'), null);
    assert.equal(applyJevSizeDown(4), 2);
    assert.equal(applyJevSizeDown(1), 1);
    assert.equal(jevEntryQuestion().type, 'choice');
    const q = jevEntryQuestions();
    assert.equal(q.signal_coherent.type, 'noul');
    assert.equal(q.action.type, 'choice');
    assert.equal(q.setup_quality.type, 'score');
    assert.deepEqual(q.setup_quality.criteria, ['weak', 'ok', 'strong']);
    assert.equal(q.too_crowded_same_day.type, 'noul');
    assert.equal(jevEntryMode(''), 'shadow');
    assert.equal(jevEntryMode('active'), 'active');
  });

  it('compose: shadow never blocks (even on skip / low coherent)', () => {
    const skip = composeJevEntry(panel({
      signal_coherent: 0.1,
      action: { choice: 'skip', confidence: 0.99 },
      setup_quality: { score: 0, confidence: 1 },
    }), 'shadow');
    assert.equal(skip.pick, 'enter');
    assert.equal(skip.failOpen, true);
    assert.match(skip.because, /shadow/);
  });

  it('compose: active skip if coherent < 0.55', () => {
    const g = composeJevEntry(panel({ signal_coherent: 0.4 }), 'active');
    assert.equal(g.pick, 'skip');
    assert.equal(g.failOpen, false);
    assert.match(g.because, /signal_coherent/);
    assert.ok(JEV_COHERENT_MIN === 0.55);
  });

  it('compose: active skip if action=skip and conf ≥ 0.70 (and ≥ 0.75 so we trust it)', () => {
    const g = composeJevEntry(panel({
      action: { choice: 'skip', confidence: 0.80 },
    }), 'active');
    assert.equal(g.pick, 'skip');
    assert.equal(g.failOpen, false);
    assert.ok(0.80 >= JEV_SKIP_CONF_MIN);
  });

  it('compose: Choice conf < 0.75 fail-opens even in active', () => {
    const low = composeJevEntry(panel({
      signal_coherent: 0.2,
      action: { choice: 'skip', confidence: 0.72 },
    }), 'active');
    assert.equal(low.pick, 'enter');
    assert.equal(low.failOpen, true);
    assert.ok(0.72 < JEV_CHOICE_CONF_MIN);
    assert.ok(0.72 >= JEV_SKIP_CONF_MIN);

    const missing = composeJevEntry(panel({
      action: { choice: 'skip', confidence: null },
    }), 'active');
    assert.equal(missing.pick, 'enter');
    assert.equal(missing.failOpen, true);
  });

  it('compose: size_down if action=size_down or setup_quality < 1.2', () => {
    const byAction = composeJevEntry(panel({
      action: { choice: 'size_down', confidence: 0.86 },
    }), 'active');
    assert.equal(byAction.pick, 'size_down');
    assert.equal(byAction.failOpen, false);

    const byScore = composeJevEntry(panel({
      action: { choice: 'enter', confidence: 0.86 },
      setup_quality: { score: 1.0, confidence: 0.7 },
    }), 'active');
    assert.equal(byScore.pick, 'size_down');
    assert.ok(1.0 < JEV_SETUP_SIZE_DOWN);

    const enter = composeJevEntry(panel(), 'active');
    assert.equal(enter.pick, 'enter');
    assert.equal(enter.failOpen, false);
  });

  it('fail-opens when no API key (does not call the network)', async () => {
    assert.equal(typesafeConfigured(''), false);
    const open = await jevEntryGate(
      { symbol: 'QQQ', why: 'breakout', dte: 7, side: 'buy', source: 'bot' },
      { apiKey: '', mode: 'active' },
    );
    assert.equal(open.pick, 'enter');
    assert.equal(open.failOpen, true);
    assert.equal(open.called, false);
    assert.match(open.because, /TYPESAFE_API_KEY unset/);
  });

  it('shadow mode never blocks a mocked skip', async () => {
    const logs: string[] = [];
    const skip = await jevEntryGate(
      { symbol: 'NVDA', bot: 'AI Catalyst', why: 'ema cross', dte: 1, side: 'buy', source: 'bot' },
      {
        apiKey: 'test-not-a-secret',
        mode: 'shadow',
        client: mockClient({
          signal_coherent: { type: 'noul', noul: 0.2 },
          action: { type: 'choice', choice: 'skip', confidence: 0.95, probabilities: { skip: 1 } },
          setup_quality: { type: 'score', score: 0, confidence: 1 },
          too_crowded_same_day: { type: 'noul', noul: 0.9 },
        }),
        log: async (_f, line) => { logs.push(line); },
      },
    );
    assert.equal(skip.pick, 'enter');
    assert.equal(skip.failOpen, true);
    assert.equal(skip.called, true);
    assert.equal(skip.mode, 'shadow');
    assert.ok(logs.length >= 1);
    assert.match(logs[0], /"usage"/);
    assert.ok(!logs[0].includes('test-not-a-secret'));
  });

  it('active mode honors mocked skip and size_down', async () => {
    const skip = await jevEntryGate(
      { symbol: 'NVDA', bot_name: 'AI Catalyst', signal_why: 'ema cross', dte_or_leaps: 1, side: 'buy', source: 'bot' },
      {
        apiKey: 'test-not-a-secret',
        mode: 'active',
        client: mockClient({
          signal_coherent: { type: 'noul', noul: 0.8 },
          action: { type: 'choice', choice: 'skip', confidence: 0.91, probabilities: { skip: 1 } },
          setup_quality: { type: 'score', score: 1.5, confidence: 0.8 },
          too_crowded_same_day: { type: 'noul', noul: 0.2 },
        }),
      },
    );
    assert.equal(skip.pick, 'skip');
    assert.equal(skip.failOpen, false);
    assert.equal(skip.called, true);
    assert.equal(skip.answer.choice, 'skip');

    const down = await jevEntryGate(
      { symbol: 'AAPL', why: 'rsi bounce', dte: 7, premium: 1.8, side: 'buy', source: 'ai' },
      {
        apiKey: 'test-not-a-secret',
        mode: 'active',
        client: mockClient({
          signal_coherent: { type: 'noul', noul: 0.7 },
          action: { type: 'choice', choice: 'size_down', confidence: 0.8, probabilities: { size_down: 1 } },
          setup_quality: { type: 'score', score: 1.0, confidence: 0.6 },
          too_crowded_same_day: { type: 'noul', noul: 0.4 },
        }),
      },
    );
    assert.equal(down.pick, 'size_down');
    assert.equal(down.failOpen, false);
  });

  it('fail-opens on client errors', async () => {
    const gate = await jevEntryGate(
      { symbol: 'SPY', why: 'momo', dte: 4, side: 'buy', source: 'bot' },
      {
        apiKey: 'test-not-a-secret',
        mode: 'active',
        paper: true,
        client: { async systemOne() { throw new Error('503 typesafe down'); } },
      },
    );
    assert.equal(gate.pick, 'enter');
    assert.equal(gate.failOpen, true);
    assert.match(gate.because, /fail-open/);
    assert.match(gate.because, /503/);
  });

  it('does not call Jev for exits', async () => {
    let called = 0;
    const gate = await jevEntryGate(
      { symbol: 'QQQ', side: 'sell', source: 'bot' },
      { apiKey: 'test-not-a-secret', mode: 'active', client: { async systemOne() { called++; return { answers: {} }; } } },
    );
    assert.equal(called, 0);
    assert.equal(gate.called, false);
    assert.match(gate.because, /exit\/flatten/);
  });

  it('HTTP client POSTs /v1/systemone with Bearer, jev-latest, and no leaked key', async () => {
    const seen: { url: string; headers: Record<string, string>; body: any }[] = [];
    const fetchFn = (async (url: any, init: any) => {
      seen.push({
        url: String(url),
        headers: init.headers,
        body: JSON.parse(init.body),
      });
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            model: 'jev-latest',
            answers: {
              action: { type: 'choice', choice: 'enter', confidence: 0.7, probabilities: { enter: 1 } },
            },
            usage: { input_tokens: 10, output_tokens: 2 },
          });
        },
      };
    }) as unknown as typeof fetch;
    const client = httpJevClient({
      apiKey: 'sk-test-not-committed',
      baseUrl: 'https://api.typesafe.ai',
      fetchFn,
    });
    const res = await client.systemOne({
      state: { symbol: 'QQQ' },
      questions: jevEntryQuestions(),
    });
    assert.equal(res.answers?.action?.choice, 'enter');
    assert.equal(seen[0].url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(seen[0].headers.Authorization, 'Bearer sk-test-not-committed');
    assert.equal(seen[0].body.model, 'jev-latest');
    assert.ok(seen[0].body.questions.signal_coherent);
    assert.ok(seen[0].body.questions.action);
    assert.ok(seen[0].body.questions.setup_quality);
    assert.ok(seen[0].body.questions.too_crowded_same_day);
    assert.ok(!JSON.stringify(seen[0].body).includes('sk-test-not-committed'));
  });

  it('parseJevPanel reads noul / choice / score', () => {
    const p = parseJevPanel({
      signal_coherent: { type: 'noul', noul: 0.66 },
      action: { type: 'choice', choice: 'enter', confidence: 0.81 },
      setup_quality: { type: 'score', score: 1.4, confidence: 0.5 },
      too_crowded_same_day: { type: 'noul', noul: 0.2 },
    });
    assert.equal(p.signal_coherent, 0.66);
    assert.equal(p.action?.choice, 'enter');
    assert.equal(p.setup_quality?.score, 1.4);
    assert.equal(p.too_crowded_same_day, 0.2);
  });
});
