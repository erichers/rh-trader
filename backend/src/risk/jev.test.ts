import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyJevSizeDown,
  httpJevClient,
  jevEntryGate,
  jevEntryQuestion,
  parseJevPick,
  typesafeConfigured,
  type JevClient,
} from './jev.js';

function mockClient(choice: string, confidence = 0.8): JevClient {
  return {
    async systemOne() {
      return {
        answers: {
          jev_entry: { type: 'choice', choice, confidence, probabilities: { [choice]: 1 } },
        },
      };
    },
  };
}

describe('Jev / TypeSafe entry gate', () => {
  it('parses enter | skip | size_down', () => {
    assert.equal(parseJevPick('enter'), 'enter');
    assert.equal(parseJevPick('SKIP'), 'skip');
    assert.equal(parseJevPick('size-down'), 'size_down');
    assert.equal(parseJevPick('nope'), null);
    assert.equal(applyJevSizeDown(4), 2);
    assert.equal(applyJevSizeDown(1), 1);
    assert.equal(jevEntryQuestion().type, 'choice');
  });

  it('fail-opens when no API key (does not call the network)', async () => {
    assert.equal(typesafeConfigured(''), false);
    const open = await jevEntryGate(
      { symbol: 'QQQ', why: 'breakout', dte: 7, side: 'buy', source: 'bot' },
      { apiKey: '' },
    );
    assert.equal(open.pick, 'enter');
    assert.equal(open.failOpen, true);
    assert.equal(open.called, false);
    assert.match(open.because, /TYPESAFE_API_KEY unset/);
  });

  it('honors a mocked skip and size_down', async () => {
    const skip = await jevEntryGate(
      { symbol: 'NVDA', bot: 'AI Catalyst', why: 'ema cross', dte: 1, side: 'buy', source: 'bot' },
      { apiKey: 'test-not-a-secret', client: mockClient('skip', 0.91) },
    );
    assert.equal(skip.pick, 'skip');
    assert.equal(skip.failOpen, false);
    assert.equal(skip.called, true);
    assert.equal(skip.answer.choice, 'skip');

    const down = await jevEntryGate(
      { symbol: 'AAPL', why: 'rsi bounce', dte: 7, premium: 1.8, side: 'buy', source: 'ai' },
      { apiKey: 'test-not-a-secret', client: mockClient('size_down') },
    );
    assert.equal(down.pick, 'size_down');
    assert.equal(down.failOpen, false);
  });

  it('fail-opens on client errors (paper)', async () => {
    const gate = await jevEntryGate(
      { symbol: 'SPY', why: 'momo', dte: 4, side: 'buy', source: 'bot' },
      {
        apiKey: 'test-not-a-secret',
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
      { apiKey: 'test-not-a-secret', client: { async systemOne() { called++; return { answers: {} }; } } },
    );
    assert.equal(called, 0);
    assert.equal(gate.called, false);
    assert.match(gate.because, /exit\/flatten/);
  });

  it('HTTP client POSTs /v1/systemone with Bearer and no leaked key in the body', async () => {
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
            answers: { jev_entry: { type: 'choice', choice: 'enter', confidence: 0.7, probabilities: { enter: 1 } } },
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
      questions: { jev_entry: jevEntryQuestion() },
    });
    assert.equal(res.answers?.jev_entry?.choice, 'enter');
    assert.equal(seen[0].url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(seen[0].headers.Authorization, 'Bearer sk-test-not-committed');
    assert.equal(seen[0].body.model, 'jev-latest');
    assert.ok(!JSON.stringify(seen[0].body).includes('sk-test-not-committed'));
  });
});
