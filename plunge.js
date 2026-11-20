/*!
 * Cold Plunge Timer — timing and history logic
 * (c) 2026 DIVELUX Inc. MIT License. https://diveluxsaunahat.com
 *
 * Pure functions, no DOM, no storage. Works in the browser
 * (window.ColdPlunge) and in Node (require('./plunge.js')).
 *
 * The timer runs from 30 seconds to 5 minutes and no longer. That ceiling is
 * a deliberate, conservative limit for a general-purpose tool, not a medical
 * figure and not a target. This file makes no health claims of any kind.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ColdPlunge = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MIN_SEC = 30;
  var MAX_SEC = 300;
  var STEP_SEC = 15;
  var DEFAULT_SEC = 60;
  var PRESETS = [30, 45, 60, 90, 120, 180, 240, 300];
  var GET_IN_SEC = 5;          // optional countdown before the clock starts
  var MIN_LOGGED_SEC = 5;      // shorter than this is a false start, not a plunge
  var HISTORY_MAX = 200;       // entries kept
  var VERSION = 1;

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  /* Any input -> a whole number of seconds between 30 and 300, on a 15 s step. */
  function clampDuration(sec) {
    var n = typeof sec === 'number' ? sec : parseFloat(sec);
    if (!isFinite(n)) return DEFAULT_SEC;
    return clamp(Math.round(n / STEP_SEC) * STEP_SEC, MIN_SEC, MAX_SEC);
  }

  /* 90 -> "1:30" */
  function fmt(sec) {
    var s = Math.max(0, Math.round(sec));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }
  /* 90 -> "1 min 30 s", 60 -> "1 min", 45 -> "45 s" */
  function fmtWords(sec) {
    var s = Math.max(0, Math.round(sec)), m = Math.floor(s / 60), r = s % 60;
    return m && r ? m + ' min ' + r + ' s' : m ? m + ' min' : r + ' s';
  }

  /*
   * Where a run is at a given moment. All times in milliseconds since the epoch.
   *   startMs      when Start was pressed
   *   getInSec     get-in countdown (0 to skip)
   *   durationSec  plunge length
   * Returns { phase: 'getin' | 'plunge' | 'done', remainingSec, elapsedSec, progress }
   * remainingSec counts down within the current phase, rounded up so the
   * display shows the full duration at the start and hits 0 exactly at the end.
   */
  function phaseAt(startMs, nowMs, getInSec, durationSec) {
    var t = Math.max(0, nowMs - startMs) / 1000;
    if (t < getInSec) {
      return { phase: 'getin', remainingSec: Math.ceil(getInSec - t), elapsedSec: 0, progress: 0 };
    }
    var inWater = t - getInSec;
    if (inWater < durationSec) {
      return { phase: 'plunge', remainingSec: Math.ceil(durationSec - inWater), elapsedSec: Math.floor(inWater), progress: inWater / durationSec };
    }
    return { phase: 'done', remainingSec: 0, elapsedSec: durationSec, progress: 1 };
  }

  /* Seconds at which the screen reader is told the time left. */
  function shouldAnnounce(remainingSec, durationSec) {
    if (remainingSec <= 0 || remainingSec >= durationSec) return false;
    return remainingSec === 10 || remainingSec === 30 || (remainingSec % 60 === 0);
  }

  /* ---------- history ---------- */

  /* One finished or abandoned plunge. Returns null for a false start. */
  function entry(startMs, plannedSec, actualSec) {
    var planned = clampDuration(plannedSec);
    var actual = Math.round(clamp(Number(actualSec) || 0, 0, planned));
    if (!isFinite(startMs) || actual < MIN_LOGGED_SEC) return null;
    return { t: Math.round(startMs), planned: planned, actual: actual, full: actual >= planned };
  }

  function validEntry(e) {
    return e && typeof e === 'object' && isFinite(e.t) && e.t > 0 &&
      isFinite(e.planned) && e.planned >= MIN_SEC && e.planned <= MAX_SEC &&
      isFinite(e.actual) && e.actual >= MIN_LOGGED_SEC && e.actual <= e.planned;
  }

  /* Text from storage -> a clean list, oldest first. Never throws. */
  function parse(text) {
    var data;
    try { data = JSON.parse(text); } catch (e) { return []; }
    var list = data && Array.isArray(data.plunges) ? data.plunges : Array.isArray(data) ? data : [];
    return list.filter(validEntry).map(function (e) {
      return { t: Math.round(e.t), planned: Math.round(e.planned), actual: Math.round(e.actual), full: e.actual >= e.planned };
    }).sort(function (a, b) { return a.t - b.t; }).slice(-HISTORY_MAX);
  }
  function serialize(list) { return JSON.stringify({ v: VERSION, plunges: list }); }

  /* Returns a new list; the input is not changed. */
  function add(list, e) {
    if (!validEntry(e)) return list.slice();
    return list.concat([e]).sort(function (a, b) { return a.t - b.t; }).slice(-HISTORY_MAX);
  }

  /* Local calendar day, "2026-11-20". */
  function dayKey(ms) {
    var d = new Date(ms);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function summarize(list, nowMs) {
    var today = dayKey(nowMs);
    var weekAgo = nowMs - 7 * 24 * 3600 * 1000;
    var out = { total: list.length, today: 0, last7: 0, secondsTotal: 0, days: [] };
    var byDay = {};
    list.forEach(function (e) {
      var k = dayKey(e.t);
      if (k === today) out.today++;
      if (e.t > weekAgo && e.t <= nowMs) out.last7++;
      out.secondsTotal += e.actual;
      if (!byDay[k]) { byDay[k] = { day: k, plunges: [] }; out.days.push(byDay[k]); }
      byDay[k].plunges.push(e);
    });
    out.days.sort(function (a, b) { return a.day < b.day ? 1 : -1; });           // newest day first
    out.days.forEach(function (d) { d.plunges.sort(function (a, b) { return b.t - a.t; }); });
    return out;
  }

  return {
    MIN_SEC: MIN_SEC, MAX_SEC: MAX_SEC, STEP_SEC: STEP_SEC, DEFAULT_SEC: DEFAULT_SEC, PRESETS: PRESETS,
    GET_IN_SEC: GET_IN_SEC, MIN_LOGGED_SEC: MIN_LOGGED_SEC, HISTORY_MAX: HISTORY_MAX,
    clampDuration: clampDuration, fmt: fmt, fmtWords: fmtWords, phaseAt: phaseAt, shouldAnnounce: shouldAnnounce,
    entry: entry, parse: parse, serialize: serialize, add: add, dayKey: dayKey, summarize: summarize
  };
});
