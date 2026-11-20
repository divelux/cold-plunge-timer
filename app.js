/*!
 * Cold Plunge Timer — interface
 * (c) 2026 DIVELUX Inc. MIT License. https://diveluxsaunahat.com
 */
(function () {
  'use strict';
  var P = window.ColdPlunge;
  if (!P || !document.querySelector('[data-o="clock"]')) return;

  var KEY = 'dvx-cold-plunge-v1';          // localStorage: the log
  var KEY_PREFS = 'dvx-cold-plunge-prefs'; // localStorage: last duration and switches
  var KEY_SESSION = 'dvx-cold-plunge-session'; // sessionStorage: count for this visit

  function $(name) { return document.querySelector('[data-o="' + name + '"]'); }
  function btn(name) { return document.querySelector('[data-a="' + name + '"]'); }
  function opt(name) { return document.querySelector('[data-i="' + name + '"]'); }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
  }
  function store(kind) { try { return window[kind]; } catch (e) { return null; } }
  function load(kind, key) { try { return store(kind).getItem(key); } catch (e) { return null; } }
  function save(kind, key, value) { try { store(kind).setItem(key, value); return true; } catch (e) { return false; } }

  /* ---------- state ---------- */
  var prefs = {};
  try { prefs = JSON.parse(load('localStorage', KEY_PREFS) || '{}') || {}; } catch (e) { prefs = {}; }
  var duration = P.clampDuration(prefs.duration == null ? P.DEFAULT_SEC : prefs.duration);
  var history = P.parse(load('localStorage', KEY));
  var sessionCount = Math.max(0, parseInt(load('sessionStorage', KEY_SESSION), 10) || 0);
  var canStore = save('localStorage', KEY_PREFS, JSON.stringify(prefs));
  var run = null;        // { startMs, getIn, duration } while the clock is going
  var finished = false;  // the last run reached zero and has not been reset
  var tick = null, audio = null, wake = null, lastSaid = null;

  if (prefs.sound === false) opt('sound').checked = false;
  if (prefs.getin === false) opt('getin').checked = false;

  function savePrefs() {
    prefs = { duration: duration, sound: opt('sound').checked, getin: opt('getin').checked };
    save('localStorage', KEY_PREFS, JSON.stringify(prefs));
  }

  /* ---------- duration chips ---------- */
  $('chips').innerHTML = P.PRESETS.map(function (s) {
    return '<label class="dvx-chip"><input type="radio" name="cpt-dur" value="' + s + '"' + (s === duration ? ' checked' : '') + '>' +
      '<span>' + P.fmt(s) + '<i class="dvx-sr"> ' + esc(P.fmtWords(s)) + '</i></span></label>';
  }).join('');
  $('chips').addEventListener('change', function (e) {
    if (run) return;
    duration = P.clampDuration(e.target.value);
    finished = false;
    savePrefs();
    idle();
  });

  /* ---------- sound, vibration, wake lock ---------- */
  function initAudio() {
    // Must happen inside a tap or click, or mobile browsers keep it muted.
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!audio && AC) audio = new AC();
      if (audio && audio.state === 'suspended') audio.resume();
    } catch (e) { audio = null; }
  }
  function beep(kind) {
    if (navigator.vibrate) { try { navigator.vibrate(kind === 'done' ? [300, 150, 300, 150, 600] : [200]); } catch (e) { /* ignore */ } }
    if (!opt('sound').checked || !audio) return;
    var notes = kind === 'done' ? [880, 880, 880, 1175] : kind === 'go' ? [587, 784] : [440];
    var t0 = audio.currentTime + 0.03;
    notes.forEach(function (hz, i) {
      var osc = audio.createOscillator(), gain = audio.createGain();
      var at = t0 + i * 0.36, len = kind === 'done' && i === notes.length - 1 ? 0.9 : kind === 'count' ? 0.12 : 0.28;
      osc.type = 'sine'; osc.frequency.value = hz;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.5, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + len);
      osc.connect(gain); gain.connect(audio.destination);
      osc.start(at); osc.stop(at + len + 0.05);
    });
  }
  function requestWake() {
    if (!('wakeLock' in navigator) || wake) return;
    navigator.wakeLock.request('screen').then(function (lock) {
      if (!run) { lock.release(); return; }
      wake = lock;
      lock.addEventListener('release', function () { if (wake === lock) wake = null; });
    }).catch(function () { /* low battery, not allowed, etc. */ });
  }
  function releaseWake() {
    if (wake) { var w = wake; wake = null; try { w.release(); } catch (e) { /* ignore */ } }
  }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && run) { requestWake(); frame(); }
  });

  /* ---------- drawing ---------- */
  function say(text) { $('live').textContent = text; }
  function setButtons(mode) {
    // mode: idle | getin | plunge | done
    btn('start').hidden = mode === 'getin' || mode === 'plunge';
    btn('start').textContent = mode === 'done' ? 'Plunge again' : 'Start';
    btn('out').hidden = mode !== 'plunge' && mode !== 'getin';
    btn('out').textContent = mode === 'getin' ? 'Cancel' : "I'm out";
    btn('reset').hidden = mode !== 'done';
    document.querySelectorAll('input[name="cpt-dur"]').forEach(function (r) { r.disabled = mode === 'getin' || mode === 'plunge'; });
    document.body.setAttribute('data-cpt', mode);
  }
  function idle() {
    $('phase').textContent = 'Ready when you are';
    $('clock').textContent = P.fmt(duration);
    $('bar').style.width = '0%';
    $('next').textContent = opt('getin').checked ?
      'Tap Start, then you have ' + P.GET_IN_SEC + ' seconds to get in.' : 'The clock starts the moment you tap Start.';
    setButtons('idle');
    document.title = 'Cold Plunge Timer: big digits, sound and a plunge log';
  }

  function frame() {
    if (!run) return;
    var s = P.phaseAt(run.startMs, Date.now(), run.getIn, run.duration);
    if (s.phase === 'getin') {
      $('phase').textContent = 'Get in';
      $('clock').textContent = String(s.remainingSec);
      $('next').textContent = P.fmtWords(run.duration) + ' in the water starts in a moment.';
      if (lastSaid !== 'g' + s.remainingSec) { lastSaid = 'g' + s.remainingSec; if (s.remainingSec <= 3) beep('count'); }
      setButtons('getin');
      return;
    }
    if (s.phase === 'plunge') {
      if (run.phase !== 'plunge') {
        run.phase = 'plunge';
        if (run.getIn) beep('go');
        say('In the water. ' + P.fmtWords(run.duration) + ' on the clock.');
        setButtons('plunge');
      }
      $('phase').textContent = 'In the water';
      $('clock').textContent = P.fmt(s.remainingSec);
      $('bar').style.width = (s.progress * 100).toFixed(1) + '%';
      $('next').textContent = 'Get out sooner if you go numb, shiver hard or feel unwell.';
      document.title = P.fmt(s.remainingSec) + ' left · Cold Plunge Timer';
      if (lastSaid !== s.remainingSec && P.shouldAnnounce(s.remainingSec, run.duration)) {
        lastSaid = s.remainingSec;
        say(P.fmtWords(s.remainingSec) + ' left.');
      }
      return;
    }
    finish(run.duration, true);
  }

  function finish(actualSec, full) {
    var e = P.entry(run.startMs + run.getIn * 1000, run.duration, actualSec);
    stopClock();
    finished = true;
    if (e) {
      history = P.add(history, e);
      canStore = save('localStorage', KEY, P.serialize(history)) && canStore;
      sessionCount++;
      save('sessionStorage', KEY_SESSION, String(sessionCount));
    }
    $('clock').textContent = full ? '0:00' : P.fmt(actualSec);
    $('bar').style.width = full ? '100%' : $('bar').style.width;
    $('phase').textContent = full ? 'Time. Out you get' : e ? 'Out after ' + P.fmtWords(actualSec) : 'Stopped';
    $('next').textContent = e ? 'Dry off, get dressed and warm up slowly. Plunge ' + sessionCount + ' of this session is logged.' :
      'Under ' + P.MIN_LOGGED_SEC + ' seconds is not logged.';
    setButtons('done');
    document.title = 'Cold Plunge Timer: big digits, sound and a plunge log';
    if (full) beep('done');
    say(full ? 'Time is up. Get out and warm up slowly.' : e ? 'Stopped after ' + P.fmtWords(actualSec) + '.' : 'Stopped.');
    drawLog();
  }

  function stopClock() {
    clearInterval(tick); tick = null; run = null; lastSaid = null;
    releaseWake();
  }

  /* ---------- buttons ---------- */
  btn('start').addEventListener('click', function () {
    initAudio();
    finished = false;
    run = { startMs: Date.now(), getIn: opt('getin').checked ? P.GET_IN_SEC : 0, duration: duration, phase: 'getin' };
    $('bar').style.width = '0%';
    if (!run.getIn) { beep('go'); }
    requestWake();
    clearInterval(tick);
    tick = setInterval(frame, 200);
    frame();
    btn('out').focus();
  });
  btn('out').addEventListener('click', function () {
    if (!run) return;
    var s = P.phaseAt(run.startMs, Date.now(), run.getIn, run.duration);
    if (s.phase === 'getin') { stopClock(); idle(); say('Cancelled.'); btn('start').focus(); return; }
    var inWater = Math.min(run.duration, (Date.now() - run.startMs) / 1000 - run.getIn);
    finish(Math.floor(inWater), inWater >= run.duration);
    btn('start').focus();
  });
  btn('reset').addEventListener('click', function () { finished = false; idle(); say('Timer reset.'); btn('start').focus(); });
  opt('sound').addEventListener('change', savePrefs);
  opt('getin').addEventListener('change', function () { savePrefs(); if (!run && !finished) idle(); });

  btn('newsession').addEventListener('click', function () {
    sessionCount = 0;
    save('sessionStorage', KEY_SESSION, '0');
    drawLog();
  });
  function clearUi(asking) {
    btn('clear').hidden = asking; btn('clearyes').hidden = !asking; btn('clearno').hidden = !asking;
  }
  btn('clear').addEventListener('click', function () { clearUi(true); $('clearstatus').textContent = 'Delete all ' + history.length + ' logged plunges?'; btn('clearno').focus(); });
  btn('clearno').addEventListener('click', function () { clearUi(false); $('clearstatus').textContent = ''; btn('clear').focus(); });
  btn('clearyes').addEventListener('click', function () {
    history = [];
    save('localStorage', KEY, P.serialize(history));
    sessionCount = 0; save('sessionStorage', KEY_SESSION, '0');
    clearUi(false);
    drawLog();
    $('clearstatus').textContent = 'Log cleared.';
  });

  /* ---------- log ---------- */
  function dayLabel(key, todayKey, yesterdayKey) {
    if (key === todayKey) return 'Today';
    if (key === yesterdayKey) return 'Yesterday';
    var p = key.split('-');
    return new Date(+p[0], +p[1] - 1, +p[2]).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  }
  function drawLog() {
    var now = Date.now();
    var sum = P.summarize(history, now);
    $('nsession').textContent = sessionCount;
    $('ntoday').textContent = sum.today;
    $('nweek').textContent = sum.last7;
    $('ntotal').textContent = sum.total;
    btn('newsession').disabled = sessionCount === 0;
    $('clearbox').hidden = sum.total === 0;
    if (!sum.total) {
      $('history').innerHTML = '<p class="cpt-empty">No plunges logged yet. Finish one and it shows up here.</p>';
    } else {
      var todayKey = P.dayKey(now), yKey = P.dayKey(now - 24 * 3600 * 1000);
      var shown = 0, html = '';
      sum.days.forEach(function (d) {
        if (shown >= 30) return;
        html += '<h3 class="cpt-day">' + esc(dayLabel(d.day, todayKey, yKey)) + '</h3><ol class="cpt-rows">';
        d.plunges.forEach(function (e) {
          if (shown >= 30) return;
          shown++;
          var at = new Date(e.t).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
          html += '<li><span class="cpt-at">' + esc(at) + '</span><span class="cpt-len">' + esc(P.fmt(e.actual)) +
            '<i class="dvx-sr"> ' + esc(P.fmtWords(e.actual)) + '</i></span><span class="cpt-how">' +
            (e.full ? 'full time' : 'out early, planned ' + esc(P.fmt(e.planned))) + '</span></li>';
        });
        html += '</ol>';
      });
      if (sum.total > shown) html += '<p class="dvx-hint">Showing the latest ' + shown + ' of ' + sum.total + '.</p>';
      $('history').innerHTML = html;
    }
    $('lognote').textContent = canStore ? 'The log is kept in this browser only. Nothing is sent anywhere.' :
      'This browser is not letting the page save anything, so the log will be gone when you close the tab.';
  }

  idle();
  drawLog();
})();
