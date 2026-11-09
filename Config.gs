// ─── General config ────────────────────────────────────────────────────────
// Defaults every deployment starts from (kept in the repository). A user's own
// values live in the "settings" tab of their sheet and win key by key; see
// resolveConfig_ in Code.gs. Keep DEFAULTS equal to the FSRS block of
// index.html: test/config.mjs checks it.

const DEFAULTS = {
  // FSRS v5, py-fsrs 5.1.0 defaults
  w: [
    0.40255, 1.18385, 3.17300, 15.69105, 7.19490, 0.53450, 1.46040, 0.00460,
    1.54575, 0.11920, 1.01925, 1.93950, 0.11000, 0.29605, 2.26980, 0.23150,
    2.98980, 0.51655, 0.66210
  ],
  retention: 0.94,      // interval = days until predicted recall falls to this
  max_interval: 365     // days; caps the scheduled interval only
};

// What an override may hold. The w bounds are the clips of the py-fsrs 5.1.0
// optimizer, so any fitted weights pass.
const LIMITS = {
  retention: [0.80, 0.97],
  max_interval: [30, 3650],
  w_lo: [0.01, 0.01, 0.01, 0.01, 1.0, 0.1, 0.1, 0.0, 0.0, 0.0,
         0.01, 0.1, 0.01, 0.01, 0.01, 0.0, 1.0, 0.0, 0.0],
  w_hi: [100, 100, 100, 100, 10.0, 4.0, 4.0, 0.75, 4.5, 0.8,
         3.5, 5.0, 0.25, 0.9, 4.0, 1.0, 6.0, 2.0, 2.0]
};

// '' when the override is valid, otherwise the reason it is ignored.
function checkSetting_(key, v) {
  const inRange = (x, [lo, hi]) => typeof x === 'number' && isFinite(x) && x >= lo && x <= hi;
  if (key === 'retention') {
    return inRange(v, LIMITS.retention)
      ? '' : 'expected a number in ' + LIMITS.retention.join('–');
  }
  if (key === 'max_interval') {
    return inRange(v, LIMITS.max_interval) && v % 1 === 0
      ? '' : 'expected a whole number in ' + LIMITS.max_interval.join('–');
  }
  if (key === 'w') {
    if (!Array.isArray(v) || v.length !== DEFAULTS.w.length) {
      return 'expected ' + DEFAULTS.w.length + ' values';
    }
    const bad = v.findIndex((x, i) => !inRange(x, [LIMITS.w_lo[i], LIMITS.w_hi[i]]));
    return bad < 0 ? '' : 'w[' + bad + '] outside ' + LIMITS.w_lo[bad] + '–' + LIMITS.w_hi[bad];
  }
  return 'unknown key';
}
