import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CatalogModel } from '../server/models.ts';
import { compactionPlan, priceCall, reasoningLevel } from '../server/saving.ts';

const model = (effort: string[] | undefined, reasoning = true) => ({ reasoning, effort }) as CatalogModel;

test('thinking uses the least the model allows, or high when asked', () => {
  assert.equal(reasoningLevel(model(['none', 'low', 'medium', 'high']), false), 'none');
  assert.equal(reasoningLevel(model(['none', 'low', 'medium', 'high']), true), 'high');
  assert.equal(reasoningLevel(model(['low', 'medium', 'high', 'xhigh', 'max']), false), 'low');
  assert.equal(reasoningLevel(model(['medium', 'high', 'xhigh']), false), 'medium');
  assert.equal(reasoningLevel(model(['low', 'high', 'max']), true), 'high');
  assert.equal(reasoningLevel(model(['max']), false), 'max', 'only one level exists');
  assert.equal(reasoningLevel(model(['high', 'max']), true), 'high');
  assert.equal(reasoningLevel(model(undefined), false), 'none', 'toggle-only models turn thinking off');
  assert.equal(reasoningLevel(model(undefined, false), true), undefined, 'not a reasoning model');
});

test('a reply is priced with cache reads at the cache rate, and the saving is the difference', () => {
  const cost = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
  const r = priceCall({ input: 11_000, output: 500, cacheRead: 10_000, cacheWrite: 0 }, cost);
  // 1k fresh input at $3/M + 10k cached at $0.30/M + 500 out at $15/M
  assert.equal(r.cost.toFixed(6), (0.003 + 0.003 + 0.0075).toFixed(6));
  assert.equal(r.cacheSaved.toFixed(6), '0.027000');
  // Writing to the cache costs extra, which counts against the saving.
  assert.ok(priceCall({ input: 10_000, output: 0, cacheRead: 0, cacheWrite: 10_000 }, cost).cacheSaved < 0);
  assert.deepEqual(priceCall({ input: 10, output: 10, cacheRead: 0, cacheWrite: 0 }, null), { cost: 0, cacheSaved: 0 });
});

test('compaction waits until history is big, and always keeps the newest messages', () => {
  const row = (n: number) => ({ role: 'user' as const, text: 'x'.repeat(n), created_at: new Date() });
  assert.equal(compactionPlan('', Array.from({ length: 20 }, () => row(100)), 200_000), null, 'small chat');
  assert.equal(compactionPlan('', Array.from({ length: 5 }, () => row(40_000)), 200_000), null, 'too few messages to fold');
  const plan = compactionPlan('', Array.from({ length: 10 }, () => row(12_000)), 200_000)!;
  assert.equal(plan.fold.length, 4);
  assert.equal(plan.keep.length, 6);
  assert.ok(compactionPlan('', Array.from({ length: 10 }, () => row(2_000)), 8_000), 'small context windows compact sooner');
});
