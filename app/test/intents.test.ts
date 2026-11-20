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
  ['open spotify', { kind: 'open', app: 'spotify', name: 'spotify' }],
  ['Open Telegram', { kind: 'open', app: 'telegram', name: 'telegram' }],
  ['telegram app kholo', { kind: 'open', app: 'telegram', name: 'telegram' }],
  ['टेलीग्राम खोलो', { kind: 'open', app: 'telegram', name: 'टेलीग्राम' }],
  ['launch Google Pay', { kind: 'open', app: 'gpay', name: 'google pay' }],
  ['open some random app', { kind: 'open', app: null, name: 'some random' }],
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

// ---- alarms & timers in English, Hinglish and Hindi (fixed "now" = 9:00 am) ----
const NINE_AM = new Date(2026, 10, 19, 9, 0);
const alarm = (s: string, now = NINE_AM) => route(s, now);

test('alarms: Hindi word order (time before "alarm")', () => {
  assert.deepEqual(alarm('kal subah 10 baje ka alarm lagao'), { kind: 'alarm', hour: 10, minute: 0, tomorrow: true });
  assert.deepEqual(alarm('Kal Subha Bara Baje ka Alarm Lagao'), { kind: 'alarm', hour: 12, minute: 0, tomorrow: true });
  assert.deepEqual(alarm('कल सुबह 10 बजे का अलार्म लगाओ'), { kind: 'alarm', hour: 10, minute: 0, tomorrow: true });
  assert.deepEqual(alarm('कल सुबह दस बजे का अलार्म लगा दो'), { kind: 'alarm', hour: 10, minute: 0, tomorrow: true });
  assert.deepEqual(alarm('subah saat baje ka alarm'), { kind: 'alarm', hour: 7, minute: 0 });
  assert.deepEqual(alarm('mujhe 6 baje utha dena'), { kind: 'alarm', hour: 18, minute: 0 }, 'no period at 9am: next 6 o\'clock is 6 pm');
});

test('alarms: Hindi fractions and times of day', () => {
  assert.deepEqual(alarm('saade saat baje ka alarm'), { kind: 'alarm', hour: 19, minute: 30 });
  assert.deepEqual(alarm('subah saade saat baje alarm lagao'), { kind: 'alarm', hour: 7, minute: 30 });
  assert.deepEqual(alarm('sava aath baje subah ka alarm'), { kind: 'alarm', hour: 8, minute: 15 });
  assert.deepEqual(alarm('paune saat baje shaam ka alarm'), { kind: 'alarm', hour: 18, minute: 45 });
  assert.deepEqual(alarm('dopahar 2 baje ka alarm'), { kind: 'alarm', hour: 14, minute: 0 });
  assert.deepEqual(alarm('raat 11 baje ka alarm'), { kind: 'alarm', hour: 23, minute: 0 });
  assert.deepEqual(alarm('raat 12 baje ka alarm'), { kind: 'alarm', hour: 0, minute: 0 });
  assert.deepEqual(alarm('रात दो बजे का अलार्म'), { kind: 'alarm', hour: 2, minute: 0 });
  assert.deepEqual(alarm('शाम साढ़े छह बजे का अलार्म'), { kind: 'alarm', hour: 18, minute: 30 });
});

test('alarms: English keeps working', () => {
  assert.deepEqual(alarm('set an alarm for 10 am tomorrow'), { kind: 'alarm', hour: 10, minute: 0, tomorrow: true });
  assert.deepEqual(alarm('Set an alarm for 7:30 a.m.'), { kind: 'alarm', hour: 7, minute: 30 });
  assert.deepEqual(alarm('alarm at 7.45 pm'), { kind: 'alarm', hour: 19, minute: 45 });
  assert.deepEqual(alarm('wake me up at 6 in the morning'), { kind: 'alarm', hour: 6, minute: 0 });
  assert.deepEqual(alarm('set an alarm for 7'), { kind: 'alarm', hour: 19, minute: 0 }, '7 am has passed at 9 am');
  assert.deepEqual(alarm('set an alarm for 7', new Date(2026, 10, 19, 23, 0)), { kind: 'alarm', hour: 7, minute: 0 });
  assert.deepEqual(alarm('alarm for 18:20'), { kind: 'alarm', hour: 18, minute: 20 });
});

test('alarms: relative times become a clock time, not "10 o\'clock"', () => {
  assert.deepEqual(alarm('set an alarm in 10 minutes'), { kind: 'alarm', hour: 9, minute: 10 });
  assert.deepEqual(alarm('20 minute baad ka alarm lagao'), { kind: 'alarm', hour: 9, minute: 20 });
  assert.deepEqual(alarm('dedh ghante baad alarm'), { kind: 'alarm', hour: 10, minute: 30 });
});

test('alarms/timers without a time open the clock instead of going to the cloud', () => {
  assert.deepEqual(route('set an alarm'), { kind: 'open', app: 'clock', name: 'clock' });
  assert.deepEqual(route('alarm lagao'), { kind: 'open', app: 'clock', name: 'clock' });
  assert.equal(route('how does an alarm clock work').kind, 'cloud');
  assert.equal(alarm('alarm for 25 baje').kind, 'cloud', 'impossible hour is not guessed');
});

test('timers: Hindi number words and fractions', () => {
  assert.deepEqual(route('paanch minute ka timer lagao'), { kind: 'timer', seconds: 300 });
  assert.deepEqual(route('पाँच मिनट का टाइमर'), { kind: 'timer', seconds: 300 });
  assert.deepEqual(route('dedh ghante ka timer'), { kind: 'timer', seconds: 5400 });
  assert.deepEqual(route('dhai minute ka timer'), { kind: 'timer', seconds: 150 });
  assert.deepEqual(route('aadha ghanta timer'), { kind: 'timer', seconds: 1800 });
  assert.deepEqual(route('set a timer for an hour'), { kind: 'timer', seconds: 3600 });
  assert.deepEqual(route('timer for 2 minutes 30 seconds'), { kind: 'timer', seconds: 150 });
});

test('alarms: dangerous misreads are refused', () => {
  assert.deepEqual(alarm('10 baje ka alarm cancel karo'), { kind: 'open', app: 'clock', name: 'alarms' }, 'cancel must never set an alarm');
  assert.deepEqual(alarm('timer band karo'), { kind: 'open', app: 'clock', name: 'alarms' });
  assert.notEqual(alarm('set 2 alarms').kind, 'alarm', 'a count is not a time');
  assert.deepEqual(alarm('wake me up in half an hour'), { kind: 'alarm', hour: 9, minute: 30 });
  assert.deepEqual(alarm('alarm for ten thirty'), { kind: 'alarm', hour: 10, minute: 30 });
  assert.deepEqual(alarm('alarm at noon'), { kind: 'alarm', hour: 12, minute: 0 });
  assert.deepEqual(alarm('भोर में 5 बजे का अलार्म'), { kind: 'alarm', hour: 5, minute: 0 });
});

// ---- regression table from the pre-submission edge-case audit ----
const HALF_TWO = new Date(2026, 10, 19, 14, 30);
const kind = (s: string) => route(s, HALF_TWO).kind;

test('questions are answered, never turned into an action', () => {
  for (const q of [
    'how do i get a passport', 'how do i get rid of acne', 'route 66 history', 'take me through the steps',
    'open source software kya hai', 'open heart surgery kya hai', 'start a business kaise kare', 'start up india kya hai',
    'launch date of chandrayaan 3', 'start the car', 'how to set alarm on iphone 15', "my alarm didn't ring at 6 am",
    'google kya hai', 'google ka ceo kaun hai', 'search engine kya hai', 'search for', 'how to set a timer', 'alarm mat lagao',
  ]) assert.equal(kind(q), 'cloud', q);
});

test('time, date and battery only for the whole question, not the keyword', () => {
  for (const q of ['what time is it in london', 'what is the time complexity of quicksort', 'time difference between india and usa',
    'match kitne baje hai', 'what is the date of diwali', 'how does a lithium battery work', 'battery kaise bachaye']) {
    assert.equal(kind(q), 'cloud', q);
  }
  for (const q of ['time batao', 'tell me the time', 'abhi kya time hua hai', 'what’s the time']) assert.equal(kind(q), 'time', q);
  for (const q of ['aaj ki date kya hai', 'aaj kaun sa din hai']) assert.equal(kind(q), 'date', q);
});

test('maths: names, dates and scores are not sums; Hindi and spoken operators are', () => {
  for (const q of ['9/11 kya hai', '26/11 kya hai', '24x7 kya hai', '20-20 kya hai', 'what is 4-4-2', '10,20 and 30']) assert.equal(kind(q), 'cloud', q);
  const val = (s: string) => (route(s) as { value: number }).value;
  assert.equal(val('5 + 3 kitna hota hai'), 8);
  assert.equal(val('2 + 2 कितना होता है'), 4);
  assert.equal(val('5 प्लस 3'), 8);
  assert.equal(val('5 गुना 3'), 15);
  assert.equal(val('two plus two'), 4);
  assert.equal(val('what’s 5 + 3'), 8);
  assert.equal(val('1,00,000 plus 5'), 100005);
  assert.equal(val('-2^2'), -4);
  assert.equal(val('what is 2 x 3 x 4'), 24);
});

test('alarms and timers: audit cases', () => {
  assert.deepEqual(route('set an alarm for 10 minutes', HALF_TWO), { kind: 'alarm', hour: 14, minute: 40 });
  assert.deepEqual(route('alarm for 1 hour', HALF_TWO), { kind: 'alarm', hour: 15, minute: 30 });
  assert.deepEqual(route('alarm for half past 6', HALF_TWO), { kind: 'alarm', hour: 18, minute: 30 });
  assert.deepEqual(route('quarter past 7 am alarm', HALF_TWO), { kind: 'alarm', hour: 7, minute: 15 });
  assert.deepEqual(route('quarter to 7 pm alarm', HALF_TWO), { kind: 'alarm', hour: 18, minute: 45 });
  assert.deepEqual(route('can you set an alarm for 6 am', HALF_TWO), { kind: 'alarm', hour: 6, minute: 0 });
  for (const q of ['snooze alarm for 10 minutes', 'stop alarm', 'stop the timer']) assert.deepEqual(route(q), { kind: 'open', app: 'clock', name: 'alarms' }, q);
  assert.deepEqual(route('timer for an hour and a half'), { kind: 'timer', seconds: 5400 });
  assert.deepEqual(route('2 minutes and a half timer'), { kind: 'timer', seconds: 150 });
  assert.deepEqual(route('timer for 1 hour 30'), { kind: 'timer', seconds: 5400 });
  assert.deepEqual(route('set a timer for twenty five minutes'), { kind: 'timer', seconds: 1500 });
});

test('more ways to open apps and stop', () => {
  for (const [q, app] of [['youtube chalao', 'youtube'], ['youtube khol de', 'youtube'], ['whatsapp kholiye', 'whatsapp'],
    ['open google chrome', 'chrome'], ['open wifi settings', 'settings'], ['open bluetooth', 'settings']] as const) {
    assert.equal((route(q) as { app: string }).app, app, q);
  }
  assert.equal(kind('bas karo'), 'stop');
  assert.equal(kind('chup karo'), 'stop');
  assert.deepEqual(route('how do i get to MG road'), { kind: 'navigate', place: 'mg road' });
  assert.deepEqual(route('take me home'), { kind: 'navigate', place: 'home' });
});
