// Run with: npm test   (Node 22.18+ strips TypeScript types natively)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluate, parseDuration, route } from '../src/intents.ts';

const cases: [string, object][] = [
  ['Set a timer for 5 minutes', { kind: 'timer', seconds: 300 }],
  ['timer for 1 hour 30 minutes', { kind: 'timer', seconds: 5400 }],
  ['set a timer for half an hour', { kind: 'timer', seconds: 1800 }],
  ['10 minute ka timer lagao', { kind: 'timer', seconds: 600 }],
  ['5 मिनट का टाइमर', { kind: 'timer', seconds: 300 }],
  ['Set an alarm for 7:30 a.m.', { kind: 'alarm', hour: 7, minute: 30 }],
  ['wake me up at 6 pm', { kind: 'alarm', hour: 18, minute: 0 }],
  ['alarm for 12 am', { kind: 'alarm', hour: 0, minute: 0 }],
  ['call 98765 43210', { kind: 'call', number: '9876543210' }],
  ['Open YouTube', { kind: 'open', app: 'youtube', name: 'youtube' }],
  ['whatsapp kholo', { kind: 'open', app: 'whatsapp', name: 'whatsapp' }],
  ['open spotify', { kind: 'open', app: null, name: 'spotify' }],
  ['Search for biryani near me', { kind: 'search', q: 'biryani near me' }],
  ['navigate to MG Road', { kind: 'navigate', place: 'mg road' }],
  ["what's the time", { kind: 'time' }],
  ['what is the date today', { kind: 'date' }],
  ['how much battery is left', { kind: 'battery' }],
  ['Hey Vaani, stop', { kind: 'stop' }],
  ['What is the capital of Australia?', { kind: 'cloud' }],
  ['Explain UPI in one line', { kind: 'cloud' }],
  ['what is 2 people', { kind: 'cloud' }],
];

for (const [input, want] of cases) {
  test(`route: ${input}`, () => assert.deepEqual(route(input), want));
}

test('math phrases', () => {
  assert.equal((route("What's 18% of 2,450") as any).value, 441);
  assert.equal((route('25 into 4') as any).value, 100);
  assert.equal((route('what is 12 plus 30 divided by 3') as any).value, 22);
  assert.equal((route('2 to the power of 10') as any).value, 1024);
  assert.equal((route('7 x 8') as any).value, 56);
});

test('evaluator rejects junk instead of guessing', () => {
  assert.ok(Number.isNaN(evaluate('2 + ')));
  assert.ok(Number.isNaN(evaluate('(2 + 3')));
  assert.equal(evaluate('-(2+3)*2'), -10);
});

test('parseDuration ignores numbers without units', () => {
  assert.equal(parseDuration('timer 5'), 0);
});

test('phone cache key merges trivially different phrasings, keeps locales apart', async () => {
  const { cacheKey } = await import('../src/cacheKey.ts');
  assert.equal(cacheKey('Hey Vaani, what is UPI?', 'en-IN'), cacheKey('what is upi', 'en-IN'));
  assert.equal(cacheKey("What's the capital of France", 'en-IN'), cacheKey('what is capital of france', 'en-IN'));
  assert.notEqual(cacheKey('what is upi', 'en-IN'), cacheKey('what is upi', 'hi-IN'));
  assert.notEqual(cacheKey('capital of austria', 'en-IN'), cacheKey('capital of australia', 'en-IN'));
});
