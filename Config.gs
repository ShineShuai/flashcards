// ─── General config ────────────────────────────────────────────────────────
// Defaults every deployment starts from (kept in the repository). A user's own
// values live in the "settings" tab of their sheet and win key by key; see
// resolveConfig_ in Code.gs. Keep DEFAULTS equal to the FSRS block of
// index.html: test/config.mjs checks it.

const DEFAULTS = {
  // FSRS-6, py-fsrs 6.3.2 defaults
  w: [
    0.2120, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.0010,
    1.8722, 0.1666, 0.7960, 1.4835, 0.0614, 0.2629, 1.6483, 0.6014,
    1.8729, 0.5425, 0.0912, 0.0658, 0.1542
  ],
  retention: 0.94,      // interval = days until predicted recall falls to this
  max_interval: 365,    // days; caps the scheduled interval only
  new_per_day: 0        // new cards introduced per study day; 0 = no limit
};

// What an override may hold. The w bounds are py-fsrs 6.3.2's parameter bounds
// (also the optimizer's clips), so any fitted weights pass.
const LIMITS = {
  retention: [0.80, 0.97],
  max_interval: [30, 3650],
  new_per_day: [0, 999],
  w_lo: [0.001, 0.001, 0.001, 0.001, 1.0, 0.001, 0.001, 0.001, 0.0, 0.0, 0.001,
         0.001, 0.001, 0.001, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.1],
  w_hi: [100, 100, 100, 100, 10.0, 4.0, 4.0, 0.75, 4.5, 0.8, 3.5,
         5.0, 0.25, 0.9, 4.0, 1.0, 6.0, 2.0, 2.0, 0.8, 0.8]
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
  if (key === 'new_per_day') {
    return inRange(v, LIMITS.new_per_day) && v % 1 === 0
      ? '' : 'expected a whole number in ' + LIMITS.new_per_day.join('–');
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
