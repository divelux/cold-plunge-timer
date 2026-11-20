/* Checks for plunge.js. Run: node test.js */
'use strict';
const P = require('./plunge.js');
const fs = require('fs');
const path = require('path');

let checks = 0;
const failures = [];
function ok(cond, msg) { checks++; if (!cond) failures.push(msg); }

/* 1. Limits: 30 seconds to 5 minutes, nothing else gets through. */
ok(P.MIN_SEC === 30 && P.MAX_SEC === 300, 'the range must stay 30 s to 5 min');
ok(P.PRESETS[0] === 30 && P.PRESETS[P.PRESETS.length - 1] === 300, 'presets must span 30 s to 5 min');
P.PRESETS.forEach((s, i) => {
  ok(P.clampDuration(s) === s, 'preset ' + s + ' is not a valid duration');
  if (i) ok(s > P.PRESETS[i - 1], 'presets not ascending');
});
for (let s = -1000; s <= 5000; s += 7) {
  const c = P.clampDuration(s);
  ok(Number.isInteger(c) && c >= 30 && c <= 300 && c % 15 === 0, 'clampDuration(' + s + ') = ' + c);
}
[undefined, null, '', 'abc', NaN, Infinity, -Infinity, {}, []].forEach((v) => {
  const c = P.clampDuration(v);
  ok(c >= 30 && c <= 300, 'clampDuration(' + String(v) + ') = ' + c);
});
ok(P.clampDuration('90') === 90 && P.clampDuration(1e9) === 300 && P.clampDuration(1) === 30, 'clampDuration edge values');

/* 2. Formatting. */
ok(P.fmt(0) === '0:00' && P.fmt(5) === '0:05' && P.fmt(60) === '1:00' && P.fmt(90) === '1:30' && P.fmt(300) === '5:00' && P.fmt(-3) === '0:00', 'fmt');
ok(P.fmtWords(45) === '45 s' && P.fmtWords(60) === '1 min' && P.fmtWords(90) === '1 min 30 s' && P.fmtWords(300) === '5 min' && P.fmtWords(0) === '0 s', 'fmtWords');

/* 3. The clock: every duration, with and without the get-in countdown, sampled every 100 ms. */
let samples = 0;
const start = 1795000000000;
for (const dur of P.PRESETS) {
  for (const getIn of [0, P.GET_IN_SEC]) {
    let prevPhase = 'getin', prevRemain = Infinity;
    const order = { getin: 0, plunge: 1, done: 2 };
    for (let ms = 0; ms <= (getIn + dur + 3) * 1000; ms += 100) {
      const s = P.phaseAt(start, start + ms, getIn, dur);
      const id = 'dur ' + dur + ' getIn ' + getIn + ' at ' + ms + ' ms';
      samples++;
      ok(order[s.phase] >= order[prevPhase], id + ': phase went backwards');
      if (s.phase === prevPhase) ok(s.remainingSec <= prevRemain, id + ': time left went up');
      if (ms < getIn * 1000) ok(s.phase === 'getin' && s.remainingSec >= 1 && s.remainingSec <= getIn, id + ': get-in countdown wrong');
      else if (ms < (getIn + dur) * 1000) {
        ok(s.phase === 'plunge', id + ': should be in the water');
        ok(s.remainingSec >= 1 && s.remainingSec <= dur, id + ': remaining out of range (' + s.remainingSec + ')');
        ok(s.remainingSec + s.elapsedSec === dur || s.remainingSec + s.elapsedSec === dur + 0, id + ': elapsed + remaining should equal the duration');
        ok(s.progress >= 0 && s.progress < 1, id + ': progress out of range');
      } else ok(s.phase === 'done' && s.remainingSec === 0 && s.progress === 1 && s.elapsedSec === dur, id + ': should be done');
      prevPhase = s.phase; prevRemain = s.phase === 'done' ? 0 : s.remainingSec;
    }
    const first = P.phaseAt(start, start + getIn * 1000, getIn, dur);
    ok(first.phase === 'plunge' && first.remainingSec === dur, 'dur ' + dur + ': the clock should show the full time at the start');
    const last = P.phaseAt(start, start + (getIn + dur) * 1000 - 1, getIn, dur);
    ok(last.phase === 'plunge' && last.remainingSec === 1, 'dur ' + dur + ': last moment should show 1 second');
  }
}
ok(P.phaseAt(start, start - 5000, 5, 60).phase === 'getin', 'a clock that jumps backwards must not crash or finish');
ok(P.phaseAt(start, start + 3600e3, 5, 60).phase === 'done', 'a long sleep must land on done');

/* 4. Announcements: never at the very start or end, always at 10 s. */
for (const dur of P.PRESETS) {
  ok(!P.shouldAnnounce(dur, dur) && !P.shouldAnnounce(0, dur), 'no announcement at the ends of ' + dur);
  if (dur > 10) ok(P.shouldAnnounce(10, dur), '10 seconds left should be announced for ' + dur);
  let n = 0; for (let s = dur; s >= 0; s--) if (P.shouldAnnounce(s, dur)) n++;
  ok(n >= 1 && n <= 7, 'between 1 and 7 announcements for ' + dur + ', got ' + n);
}

/* 5. Log entries. */
let e = P.entry(start, 60, 60);
ok(e && e.full === true && e.actual === 60 && e.planned === 60 && e.t === start, 'full plunge entry');
e = P.entry(start, 120, 47.6);
ok(e && e.full === false && e.actual === 48, 'early exit entry');
ok(P.entry(start, 60, 4) === null && P.entry(start, 60, 0) === null && P.entry(start, 60, -5) === null, 'a false start must not be logged');
ok(P.entry(start, 60, 5) !== null, '5 seconds is the shortest logged plunge');
ok(P.entry(start, 60, 500).actual === 60, 'actual time cannot exceed the planned time');
ok(P.entry(NaN, 60, 60) === null, 'entry without a start time');
ok(P.entry(start, 9999, 9999).planned === 300, 'entry cannot be longer than 5 minutes');

/* 6. Storage text: garbage in, clean list out. */
['', 'null', 'undefined', '{', '[]', '{}', '42', '"x"', '{"plunges":"no"}', '{"plunges":[null,1,"a",{}]}'].forEach((t) => {
  const list = P.parse(t);
  ok(Array.isArray(list) && list.length === 0, 'parse(' + t + ') should be an empty list');
});
ok(P.parse(null).length === 0 && P.parse(undefined).length === 0, 'parse of nothing');
const dirty = JSON.stringify({ v: 1, plunges: [
  { t: start + 2000, planned: 60, actual: 60, full: false },         // full flag wrong: recomputed
  { t: start, planned: 60, actual: 30 },
  { t: start + 1000, planned: 60, actual: 90 },                       // longer than planned: dropped
  { t: start + 3000, planned: 10, actual: 10 },                       // below the minimum: dropped
  { t: start + 4000, planned: 600, actual: 300 },                     // above the maximum: dropped
  { t: -1, planned: 60, actual: 60 }, { t: 'x', planned: 60, actual: 60 },
  { t: start + 5000, planned: 60, actual: 2 }                         // false start: dropped
] });
let list = P.parse(dirty);
ok(list.length === 2 && list[0].t === start && list[1].full === true, 'parse should keep 2 clean entries in time order: ' + JSON.stringify(list));
ok(JSON.stringify(P.parse(P.serialize(list))) === JSON.stringify(list), 'serialize then parse should return the same list');
ok(P.parse(JSON.stringify(list)).length === 2, 'a bare array from an older version should still load');

/* 7. add(): pure, ordered, capped. */
const before = JSON.stringify(list);
const added = P.add(list, P.entry(start + 10000, 90, 90));
ok(JSON.stringify(list) === before && added.length === 3, 'add must not change its input');
ok(P.add(list, null).length === 2 && P.add(list, { t: 1 }).length === 2, 'add must ignore invalid entries');
let big = [];
for (let i = 0; i < P.HISTORY_MAX + 50; i++) big = P.add(big, P.entry(start + i * 60000, 60, 60));
ok(big.length === P.HISTORY_MAX && big[0].t === start + 50 * 60000, 'the log should keep the newest ' + P.HISTORY_MAX);
for (let i = 1; i < big.length; i++) ok(big[i].t > big[i - 1].t, 'log out of order');

/* 8. Summary. */
const noon = new Date(2026, 10, 20, 12, 0, 0).getTime();
const day = 24 * 3600 * 1000;
let log = [];
[[0, 60, 60], [-3600e3, 60, 20], [-day, 120, 120], [-3 * day, 30, 30], [-6 * day, 60, 60], [-8 * day, 60, 60], [-40 * day, 300, 300]].forEach(([off, pl, ac]) => { log = P.add(log, P.entry(noon + off, pl, ac)); });
let s = P.summarize(log, noon + 1000);
ok(s.total === 7 && s.today === 2 && s.last7 === 5, 'summary counts: ' + JSON.stringify([s.total, s.today, s.last7]));
ok(s.secondsTotal === 60 + 20 + 120 + 30 + 60 + 60 + 300, 'summary seconds');
ok(s.days.length === 6 && s.days[0].day === '2026-11-20' && s.days[0].plunges.length === 2, 'summary days');
ok(s.days[0].plunges[0].t > s.days[0].plunges[1].t, 'newest plunge first within a day');
for (let i = 1; i < s.days.length; i++) ok(s.days[i].day < s.days[i - 1].day, 'days not newest first');
s = P.summarize([], noon);
ok(s.total === 0 && s.today === 0 && s.last7 === 0 && s.days.length === 0, 'empty summary');
ok(P.dayKey(new Date(2026, 0, 5, 23, 59).getTime()) === '2026-01-05' && P.dayKey(new Date(2026, 0, 6, 0, 0).getTime()) === '2026-01-06', 'dayKey uses the local calendar day');

/* 9. The page keeps its promises: safety text present, no health claims. */
const page = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const readme = fs.readFileSync(path.join(__dirname, 'README.md'), 'utf8');
ok((page.match(/<h1[\s>]/g) || []).length === 1, 'index.html must have exactly one h1');
['Do not plunge alone', 'go numb', 'shiver hard', 'Not medical advice', 'talk to your doctor', 'weather.gov/safety/coldwater'].forEach((t) => ok(page.includes(t), 'index.html: safety text missing: ' + t));
[['index.html', page], ['README.md', readme]].forEach(([name, text]) => {
  const banned = /\b(boosts?|burns? fat|detox|immune|immunity|metabolism|dopamine|inflammation|recovery|heals?|cures?|treats?|benefits? of|weight loss|testosterone|longevity)\b/i;
  const m = text.replace(/makes no claims[^.]*\./gi, '').match(banned);
  ok(!m, name + ': health-claim wording found: ' + (m && m[0]));
  ok(/not medical advice/i.test(text), name + ': "not medical advice" missing');
});

console.log(checks + ' checks, ' + samples + ' clock samples');
if (failures.length) {
  console.error(failures.length + ' FAILED');
  failures.slice(0, 25).forEach((f) => console.error(' - ' + f));
  process.exit(1);
}
console.log('all passed');
