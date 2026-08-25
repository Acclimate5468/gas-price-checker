'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
//  STATE & CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

const K = {
  profiles:      'gasp_profiles',
  activeProfile: 'gasp_activeProfile',
  fillLog:       'gasp_fillLog',
  inputs:        'gasp_inputs',
};

// Expected weekly price change % by calendar month (Jan=0 … Dec=11).
// Used when no EIA API key is present — stable, seasonal, non-random.
const SEASONAL_TREND = [-0.10, 0.05, 0.23, 0.18, 0.10, -0.02, -0.07, -0.15, -0.20, -0.12, -0.07, -0.05];

// Phase 3: travel comparison thresholds (tunable constants)
const ALT_MARGINAL_THRESHOLD  = 0.50;   // net savings below this → "marginal"
const ALT_WORTHIT_THRESHOLD   = 1.00;   // net savings at or above → "worth the drive"
const ALT_RANGE_RESERVE_MILES = 10;     // min miles of range remaining on arrival

let sparkChart      = null;   // Chart.js instance
let lastCoords      = null;   // { lat, lon } from GPS or geocoding
let editingProfileId = null;
let suggestedPrice  = null;   // pre-fill fill-up log after checking

// ═══════════════════════════════════════════════════════════════════════════════
//  STORAGE HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

const store = {
  get: key => { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } },
  set: (key, val) => localStorage.setItem(key, JSON.stringify(val)),
};

// ═══════════════════════════════════════════════════════════════════════════════
//  FEATURE 1 — INPUT PERSISTENCE
// ═══════════════════════════════════════════════════════════════════════════════

function loadInputs() {
  const saved = store.get(K.inputs) || {};
  if (saved.tank_size)        el('tank_size').value         = saved.tank_size;
  if (saved.mpg)              el('mpg').value               = saved.mpg;
  if (saved.miles_per_week)   el('miles_per_week').value    = saved.miles_per_week;
  if (saved.zip_code)         el('zip_code').value          = saved.zip_code;
  if (saved.local_price)      el('local_price').value       = saved.local_price;
  if (saved.gasbuddy_savings)  el('gasbuddy_savings').value  = saved.gasbuddy_savings;
  if (saved.upside_cashback)   el('upside_cashback').value   = saved.upside_cashback;
  if (saved.stackability)      el('stackability').value      = saved.stackability;
  if (saved.alt_name)          el('alt_name').value          = saved.alt_name;
  if (saved.alt_distance)      el('alt_distance').value      = saved.alt_distance;
  if (saved.alt_distance_type) el('alt_distance_type').value = saved.alt_distance_type;
  if (saved.alt_price)         el('alt_price').value         = saved.alt_price;
  if (saved.alt_gasbuddy)      el('alt_gasbuddy').value      = saved.alt_gasbuddy;
  if (saved.alt_upside)        el('alt_upside').value        = saved.alt_upside;
  if (saved.alt_stackability)  el('alt_stackability').value  = saved.alt_stackability;
  const pct = saved.fuel_level_percent != null ? saved.fuel_level_percent : 50;
  el('fuel_level_range').value   = pct;
  el('fuel_level_percent').value = pct;
  syncGauge(pct);
  syncStackabilityRow();
  syncAltStackabilityRow();
  // Auto-expand alt station fieldset when previously saved data exists
  if (saved.alt_price) {
    el('altStationFieldset').classList.remove('hidden');
    el('altStationToggle').classList.add('hidden');
  }
}

function saveInputs() {
  store.set(K.inputs, {
    tank_size:          el('tank_size').value,
    mpg:                el('mpg').value,
    miles_per_week:     el('miles_per_week').value,
    zip_code:           el('zip_code').value,
    fuel_level_percent: el('fuel_level_percent').value,
    local_price:        el('local_price').value,
    gasbuddy_savings:   el('gasbuddy_savings').value,
    upside_cashback:    el('upside_cashback').value,
    stackability:       el('stackability').value,
    alt_name:           el('alt_name').value,
    alt_distance:       el('alt_distance').value,
    alt_distance_type:  el('alt_distance_type').value,
    alt_price:          el('alt_price').value,
    alt_gasbuddy:       el('alt_gasbuddy').value,
    alt_upside:         el('alt_upside').value,
    alt_stackability:   el('alt_stackability').value,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
//  PHASE 2A — REWARD INPUTS & DEAL COMPARISON
// ═══════════════════════════════════════════════════════════════════════════════

// Show/hide the stackability selector based on whether both reward fields > 0.
function syncStackabilityRow() {
  const gbVal = parseFloat(el('gasbuddy_savings').value);
  const upVal = parseFloat(el('upside_cashback').value);
  el('stackabilityRow').classList.toggle('hidden', !(gbVal > 0 && upVal > 0));
}

function syncAltStackabilityRow() {
  const gbVal = parseFloat(el('alt_gasbuddy').value);
  const upVal = parseFloat(el('alt_upside').value);
  el('altStackabilityRow').classList.toggle('hidden', !(gbVal > 0 && upVal > 0));
}

// Validate a single reward input field.
// Returns { blocked, warning, val }
// - blocked: true → submit must be prevented
// - warning: non-null string → show inline warning but allow submit
// - val: parsed float or null (null means "no savings")
function validateRewardField(rawValue) {
  if (rawValue === '' || rawValue == null) return { blocked: false, warning: null, val: null };
  const v = parseFloat(rawValue);
  if (!Number.isFinite(v)) return { blocked: true,  warning: 'Not a valid number.',                                                    val: null };
  if (v < 0)               return { blocked: true,  warning: 'Reward savings cannot be negative.',                                      val: null };
  if (v > 2.00)            return { blocked: true,  warning: 'Value above $2.00/gal — likely a typo. Maximum allowed is $2.00/gal.',    val: null };
  if (v > 1.00)            return { blocked: false, warning: 'This reward amount is unusually high. Check for a typo or confirm the offer.', val: v };
  return { blocked: false, warning: null, val: v > 0 ? v : null };
}

// Show or hide an inline reward warning div.
function updateRewardWarning(elId, message) {
  const div = el(elId);
  if (!div) return;
  if (!message) {
    div.textContent = '';
    div.classList.add('hidden');
  } else {
    div.textContent = message;
    div.classList.remove('hidden');
  }
}

// Calculate effective prices based on local price and manual reward inputs.
// Returns { effectivePrice, savingsPerGal, breakdown[] }
// breakdown entries: { label, price, infoOnly? }
// infoOnly rows are shown for reference in the comparison table but are never
// used in calculations and never marked [BEST].
function calculateEffectivePrice(base, gasBuddy, upside, stackability) {
  const hasGB = gasBuddy != null && gasBuddy > 0;
  const hasUp = upside   != null && upside   > 0;

  const breakdown = [{ label: 'Posted local price', price: base }];
  let effectivePrice = base;

  if (hasGB && !hasUp) {
    effectivePrice = Math.max(0, base - gasBuddy);
    breakdown.push({ label: 'With GasBuddy discount', price: effectivePrice });
  } else if (hasUp && !hasGB) {
    effectivePrice = Math.max(0, base - upside);
    breakdown.push({ label: 'With Upside cash back', price: effectivePrice });
  } else if (hasGB && hasUp) {
    const gbPrice  = Math.max(0, base - gasBuddy);
    const upPrice  = Math.max(0, base - upside);
    const combined = Math.max(0, base - gasBuddy - upside);
    breakdown.push({ label: 'GasBuddy only', price: gbPrice });
    breakdown.push({ label: 'Upside only',   price: upPrice });
    if (stackability === 'yes') {
      breakdown.push({ label: 'Both (confirmed stackable)', price: combined });
      effectivePrice = combined;
    } else if (stackability === 'unknown') {
      // Conservative: use best single reward; show combined as informational only
      effectivePrice = Math.max(0, base - Math.max(gasBuddy, upside));
      breakdown.push({ label: 'If both stack (unconfirmed)', price: combined, infoOnly: true });
    } else {
      // 'no' — use best single reward, no combined row
      effectivePrice = Math.max(0, base - Math.max(gasBuddy, upside));
    }
  }

  return { effectivePrice, savingsPerGal: base - effectivePrice, breakdown };
}

// Render the deal comparison table in #dealCompareWrap.
function renderDealComparison({ breakdown, localPriceEntered, hasAnyReward, gallonsToFill }) {
  const wrap = el('dealCompareWrap');

  // Hint when rewards were entered but no local price
  if (!localPriceEntered && hasAnyReward) {
    wrap.innerHTML = '<p class="field-hint deal-hint">Enter your station\'s current price above to compare reward-adjusted deals.</p>';
    wrap.classList.remove('hidden');
    return;
  }

  // Hide when conditions aren't met
  if (!localPriceEntered || !hasAnyReward || breakdown.length <= 1) {
    wrap.classList.add('hidden');
    return;
  }

  // Exclude infoOnly rows from best-price calculation and [BEST] eligibility
  const eligiblePrices = breakdown.filter(r => !r.infoOnly).map(r => r.price);
  const bestPrice = Math.min(...eligiblePrices);

  const rows = breakdown.map(row => {
    const isBest   = !row.infoOnly && row.price === bestPrice;
    const fillCost = (row.price * gallonsToFill).toFixed(2);

    if (row.infoOnly) {
      return `<tr class="deal-row-info">
        <td>${escHtml(row.label)}<span class="deal-info-note">Shown for reference only — not counted because stackability is unknown.</span></td>
        <td>$${row.price.toFixed(3)}/gal</td>
        <td>$${fillCost}</td>
      </tr>`;
    }

    const bestTag = isBest ? '&nbsp;<span class="deal-best-tag">[BEST]</span>' : '';
    return `<tr${isBest ? ' class="deal-row-best"' : ''}>
      <td>${escHtml(row.label)}${bestTag}</td>
      <td>$${row.price.toFixed(3)}/gal</td>
      <td>$${fillCost}</td>
    </tr>`;
  }).join('');

  wrap.innerHTML = `
    <div class="deal-compare-title">Deal Comparison</div>
    <table class="deal-compare-table">
      <thead><tr><th>Option</th><th>Price/gal</th><th>Fill cost (~${gallonsToFill.toFixed(1)} gal)</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="deal-disclaimer">Activate all offers in the GasBuddy or Upside app before fueling. Stacking is not guaranteed unless you have confirmed it at this station. This app does not connect to GasBuddy or Upside accounts.</p>
  `;
  wrap.classList.remove('hidden');
}

// ═══════════════════════════════════════════════════════════════════════════════
//  PHASE 3 — TRAVEL-ADJUSTED DEAL COMPARISON
// ═══════════════════════════════════════════════════════════════════════════════

// Pure function — no DOM access.
// Returns a result object used by renderTravelComparison and the details table.
function calculateAltTravelComparison({
  tankSize, fuelLevelPct, mpg,
  currentEffectivePrice,
  altPrice, altGasBuddy, altUpside, altStackability,
  altDistance, altDistanceType, altName,
}) {
  const altEffResult      = calculateEffectivePrice(altPrice, altGasBuddy, altUpside, altStackability);
  const altEffectivePrice = altEffResult.effectivePrice;
  const altBreakdown      = altEffResult.breakdown;

  // Travel miles: one-way trips are driven both ways; detour and round-trip are already total
  const travelMiles = altDistanceType === 'one-way' ? altDistance * 2 : altDistance;

  // One-way miles for the range check — conservative: detour treated as one-way bound
  const oneWayMiles = altDistanceType === 'one-way'    ? altDistance
                    : altDistanceType === 'round-trip' ? altDistance / 2
                    :                                    altDistance;

  const currentFuelGallons = tankSize * (fuelLevelPct / 100);
  const fuelUsedToReach    = oneWayMiles / mpg;
  const fuelAfterTrip      = currentFuelGallons - fuelUsedToReach;
  const rangeAfterTrip     = Math.max(0, fuelAfterTrip * mpg);

  const base = { altEffectivePrice, altBreakdown, altName, travelMiles, altDistance, altDistanceType, mpg };

  if (fuelAfterTrip <= 0) {
    return {
      ...base,
      verdict:        'no-fuel',
      verdictText:    "You don't have enough fuel to reach this station safely.",
      fuelAfterTrip,
      rangeAfterTrip: 0,
      fuelMarginWarn: false,
    };
  }

  const fuelMarginWarn     = rangeAfterTrip < ALT_RANGE_RESERVE_MILES;
  const gallonsToFill      = tankSize * (1 - fuelLevelPct / 100);
  const travelFuelGallons  = travelMiles / mpg;
  const travelFuelCost     = travelFuelGallons * altEffectivePrice;
  const savingsPerGal      = currentEffectivePrice - altEffectivePrice;
  const fillSavings        = savingsPerGal * gallonsToFill;
  const netSavings         = fillSavings - travelFuelCost;

  // Unconfirmed combined variant — only when stackability is unknown and both rewards present
  let unconfirmedNetSavings = null;
  const altGBVal = altGasBuddy != null && altGasBuddy > 0 ? altGasBuddy : 0;
  const altUpVal = altUpside   != null && altUpside   > 0 ? altUpside   : 0;
  if (altGBVal > 0 && altUpVal > 0 && altStackability === 'unknown') {
    const combinedAltPrice      = Math.max(0, altPrice - altGBVal - altUpVal);
    const combinedSavPerGal     = currentEffectivePrice - combinedAltPrice;
    const combinedFill          = combinedSavPerGal * gallonsToFill;
    const combinedTravelCost    = travelFuelGallons * combinedAltPrice;
    unconfirmedNetSavings       = combinedFill - combinedTravelCost;
  }

  let verdict, verdictText;
  if (savingsPerGal <= 0) {
    verdict     = 'not-worth-it';
    verdictText = 'Not worth the drive — the alternate station is not cheaper after available rewards.';
  } else if (netSavings < 0) {
    verdict     = 'not-worth-it';
    verdictText = `Not worth the drive — travel fuel cost ($${travelFuelCost.toFixed(2)}) exceeds the fill savings ($${fillSavings.toFixed(2)}).`;
  } else if (netSavings < ALT_MARGINAL_THRESHOLD) {
    verdict     = 'marginal';
    verdictText = 'Marginal — only worth it if this station is already on your route.';
  } else if (netSavings < ALT_WORTHIT_THRESHOLD) {
    verdict     = 'marginal';
    verdictText = 'Marginal — small savings; only worth it if this station is already convenient.';
  } else {
    verdict     = 'worth-it';
    verdictText = `Worth the drive — estimated net savings: $${netSavings.toFixed(2)}.`;
  }

  return {
    ...base,
    verdict, verdictText,
    currentEffectivePrice,
    savingsPerGal, gallonsToFill,
    fillSavings, travelFuelGallons, travelFuelCost, netSavings,
    fuelAfterTrip, rangeAfterTrip, fuelMarginWarn,
    unconfirmedNetSavings,
  };
}

function renderTravelComparison(result) {
  const wrap = el('travelCompareWrap');
  if (!result) { wrap.classList.add('hidden'); return; }

  if (result.verdict === 'hint') {
    wrap.innerHTML = '<p class="field-hint deal-hint">Enter your station\'s current price and the alternate station details above to compare travel value.</p>';
    wrap.classList.remove('hidden');
    return;
  }

  const stationLabel = result.altName || 'Alternate station';
  let html = `<div class="deal-compare-title">Travel Comparison — ${escHtml(stationLabel)}</div>`;

  if (result.fuelMarginWarn) {
    html += `<div class="travel-margin-warn">⚠ Low fuel margin — about ${result.rangeAfterTrip.toFixed(0)} miles of range remaining when you'd arrive. Consider topping up slightly at your current station first.</div>`;
  }

  const showSavings = result.verdict !== 'no-fuel';
  html += `<div class="travel-verdict ${result.verdict}">
    <div class="travel-verdict-label">${escHtml(stationLabel)}</div>
    <div class="travel-verdict-text">${escHtml(result.verdictText)}</div>
    ${showSavings ? `<div class="travel-savings-primary">${fmtCurrency(result.netSavings, { sign: true })}</div>` : ''}
  </div>`;

  if (showSavings) {
    const distLabel = result.altDistanceType === 'one-way'
      ? `${result.altDistance} mi one-way (×2 = ${result.travelMiles.toFixed(1)} mi total)`
      : result.altDistanceType === 'round-trip'
      ? `${result.altDistance} mi round-trip`
      : `${result.altDistance} mi extra detour`;

    html += `<table class="travel-breakdown-table"><tbody>
      <tr><td>Current effective price</td><td>$${result.currentEffectivePrice.toFixed(3)}/gal</td></tr>
      <tr><td>Alternate effective price</td><td>$${result.altEffectivePrice.toFixed(3)}/gal</td></tr>
      <tr><td>Savings per gallon</td><td>${fmtCurrency(result.savingsPerGal, { decimals: 3 })}/gal</td></tr>
      <tr><td>Gallons to fill</td><td>${result.gallonsToFill.toFixed(1)} gal</td></tr>
      <tr><td>Gross fill savings</td><td>${fmtCurrency(result.fillSavings)}</td></tr>
      <tr><td>Travel distance</td><td>${escHtml(distLabel)}</td></tr>
      <tr><td>Travel fuel used</td><td>${result.travelFuelGallons.toFixed(2)} gal at ${result.mpg} MPG</td></tr>
      <tr><td>Travel fuel cost</td><td>$${result.travelFuelCost.toFixed(2)}</td></tr>
      <tr class="travel-net-row"><td>Net savings</td><td>${fmtCurrency(result.netSavings, { sign: true })}</td></tr>
    </tbody></table>`;

    if (result.unconfirmedNetSavings != null) {
      const diff = result.unconfirmedNetSavings - result.netSavings;
      html += `<div class="travel-info-note">If GasBuddy + Upside stack at the alternate station (unconfirmed): net savings would be ${fmtCurrency(result.unconfirmedNetSavings)} (${fmtCurrency(diff, { sign: true })}). Not counted in the verdict above.</div>`;
    }

    html += `<p class="travel-disclaimer">Based on manually entered prices and distances. Actual savings may vary. Activate all offers in GasBuddy or Upside before fueling.</p>`;
  }

  wrap.innerHTML = html;
  wrap.classList.remove('hidden');
}

function initAltStationInputs() {
  el('altStationToggle').addEventListener('click', () => {
    el('altStationFieldset').classList.remove('hidden');
    el('altStationToggle').classList.add('hidden');
    el('altStationToggle').setAttribute('aria-expanded', 'true');
  });
  el('altStationHide').addEventListener('click', () => {
    el('altStationFieldset').classList.add('hidden');
    el('altStationToggle').classList.remove('hidden');
    el('altStationToggle').setAttribute('aria-expanded', 'false');
  });

  function onAltRewardInput(inputId, warnId) {
    const check = validateRewardField(el(inputId).value.trim());
    updateRewardWarning(warnId, check.warning);
    syncAltStackabilityRow();
    saveInputs();
  }
  el('alt_gasbuddy').addEventListener('input', () => onAltRewardInput('alt_gasbuddy', 'altGasBuddyWarn'));
  el('alt_upside').addEventListener('input',   () => onAltRewardInput('alt_upside',   'altUpsideWarn'));
  el('alt_stackability').addEventListener('change', saveInputs);
  el('alt_distance_type').addEventListener('change', saveInputs);
  ['alt_name', 'alt_distance', 'alt_price'].forEach(id => {
    el(id).addEventListener('input', saveInputs);
  });
}

// Wire up live reward validation + stackability row show/hide.
function initRewardInputs() {
  function onRewardInput(inputId, warnId) {
    const check = validateRewardField(el(inputId).value.trim());
    updateRewardWarning(warnId, check.warning);
    syncStackabilityRow();
    saveInputs();
  }
  el('gasbuddy_savings').addEventListener('input', () => onRewardInput('gasbuddy_savings', 'gasBuddyWarn'));
  el('upside_cashback').addEventListener('input',  () => onRewardInput('upside_cashback',  'upsideWarn'));
  el('stackability').addEventListener('change', saveInputs);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  FEATURE 2 — FUEL GAUGE
// ═══════════════════════════════════════════════════════════════════════════════

function initFuelGauge() {
  const slider = el('fuel_level_range');
  slider.addEventListener('input', () => {
    const pct = parseInt(slider.value, 10);
    el('fuel_level_percent').value = pct;
    syncGauge(pct);
    saveInputs();
  });
  // Also re-sync when tank size changes so gallons display is correct
  el('tank_size').addEventListener('input', () => {
    syncGauge(parseInt(el('fuel_level_range').value, 10));
  });
}

function updateArcGauge(pct) {
  const arc    = document.getElementById('gaugeFillArc');
  const needle = document.getElementById('gaugeNeedle');

  // Needle: 0° at E (left), 180° at F (right). Always updated even at pct=0.
  if (needle) {
    needle.setAttribute('transform', `rotate(${((pct / 100) * 180).toFixed(1)}, 100, 100)`);
  }

  if (!arc) return;

  if (pct <= 0) { arc.setAttribute('d', ''); return; }

  // Angle: π at E (0%), 0 at F (100%). sweep=1 draws the upper (clockwise) arc.
  const angle = Math.PI * (1 - pct / 100);
  const x     = (100 + 80 * Math.cos(angle)).toFixed(2);
  const y     = (100 - 80 * Math.sin(angle)).toFixed(2);
  arc.setAttribute('d', `M 20,100 A 80,80 0 0,1 ${x},${y}`);
  arc.style.stroke = pct < 25  ? 'var(--gauge-low)' :
                     pct <= 50 ? 'var(--gauge-mid)' :
                                 'var(--gauge-high)';
}

function syncGauge(pct) {
  const fill    = el('fuelFill');
  const output  = el('fuelOutput');
  const tankVal = parseFloat(el('tank_size').value) || 0;
  const gallons = tankVal > 0 ? ((pct / 100) * tankVal).toFixed(1) : '—';
  const galLabel = tankVal > 0 ? `${gallons} gal remaining` : 'enter tank size';

  if (fill) {
    fill.style.width = `${pct}%`;
    if (pct < 25)       fill.style.backgroundColor = 'var(--gauge-low)';
    else if (pct <= 50) fill.style.backgroundColor = 'var(--gauge-mid)';
    else                fill.style.backgroundColor = 'var(--gauge-high)';
  }

  output.textContent = `${pct}% · ${galLabel}`;
  updateArcGauge(pct);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  FEATURE 3 — EIA PRICE + REAL TREND (replaces random jitter)
// ═══════════════════════════════════════════════════════════════════════════════

async function fetchPriceAndHistory(zip) {
  try {
    const res  = await fetch('/.netlify/functions/eia-proxy');
    if (res.ok) {
      const json = await res.json();
      const raw  = (json?.response?.data || []).reverse(); // oldest → newest
      if (raw.length > 0) {
        const history = raw.map(r => ({ period: r.period, value: parseFloat(r.value) }));
        return {
          price:     history[history.length - 1].value,
          trendPct:  trendPctFromHistory(history),
          history,
          source:    'EIA weekly benchmark (national avg)',
          simulated: false,
        };
      }
    }
  } catch (err) {
    console.warn('EIA proxy unavailable, using regional estimate:', err.message);
  }

  // Fallback: regional estimate + seasonal trend
  const price   = regionalEstimate(zip);
  const history = simulateHistory(price);
  const month   = new Date().getMonth();
  return {
    price,
    trendPct:  SEASONAL_TREND[month],
    history,
    source:    'Regional benchmark estimate',
    simulated: true,
  };
}

// Compute average weekly % change from oldest→newest using last 4 data points
function trendPctFromHistory(history) {
  const slice = history.slice(-4);
  if (slice.length < 2) return 0;
  const oldest = slice[0].value;
  const newest = slice[slice.length - 1].value;
  const weeks  = slice.length - 1;
  return ((newest - oldest) / oldest / weeks) * 100;
}

// Generate a plausible 8-week history when no API key is available
function simulateHistory(currentPrice) {
  const month     = new Date().getMonth();
  const weeklyChg = SEASONAL_TREND[month] / 100;
  const history   = [];
  for (let i = 7; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i * 7);
    // Work backwards: if price is trending up, earlier weeks were lower
    const age     = i;
    const price   = currentPrice / Math.pow(1 + weeklyChg, age);
    history.push({ period: d.toISOString().slice(0, 10), value: +price.toFixed(3) });
  }
  return history;
}

// Regional estimates by ZIP prefix (2025-2026 averages, $/gallon regular)
function regionalEstimate(zip) {
  const p = parseInt((zip || '00000').slice(0, 3), 10);
  if (p <=  99) return 3.10;  // Southeast / FL
  if (p <= 199) return 3.55;  // Northeast / NY
  if (p <= 299) return 3.35;  // Mid-Atlantic
  if (p <= 399) return 3.05;  // Southeast
  if (p <= 499) return 3.20;  // Midwest / KY-OH
  if (p <= 599) return 3.15;  // Midwest / IA-MN
  if (p <= 699) return 3.40;  // IL / WI
  if (p <= 799) return 2.95;  // South Central
  if (p <= 849) return 3.30;  // Mountain West
  if (p <= 899) return 3.75;  // AZ / NM
  if (p <= 961) return 4.40;  // CA
  if (p <= 979) return 4.05;  // OR
  if (p <= 994) return 4.15;  // WA
  return 3.30;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  CONFIDENCE
// ═══════════════════════════════════════════════════════════════════════════════

function calculateConfidence({ localPriceEntered, hasVehicleData, benchmarkSource, hasGB, hasUpside, stackability }) {
  if (localPriceEntered && hasVehicleData) {
    if (hasGB && hasUpside && stackability === 'unknown') {
      return {
        level:  'medium',
        label:  'Medium confidence',
        reason: 'Local price entered, but reward stacking is unconfirmed — conservative estimate used.',
      };
    }
    const hasRewards = hasGB || hasUpside;
    return {
      level:  'high',
      label:  'High confidence',
      reason: hasRewards
        ? 'Based on your station\'s current price, vehicle data, and entered reward details.'
        : 'Based on your station\'s current price and vehicle data.',
    };
  }
  if (benchmarkSource === 'eia') {
    return {
      level:  'medium',
      label:  'Medium confidence',
      reason: 'Using EIA weekly benchmark — no local price entered. Cost estimates may differ from your actual pump price.',
    };
  }
  return {
    level:  'low',
    label:  'Low confidence',
    reason: 'EIA data unavailable — using regional estimate only. Enter your station\'s current price above for a more accurate recommendation.',
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  DECISION LOGIC
// ═══════════════════════════════════════════════════════════════════════════════

// Score-based decision: combines tank urgency, weekly dollar impact of trend,
// and current price vs 8-week average. Score >= 40 → Yes, <= -20 → No, else → Up to You.
function decidePurchase({ daysRemaining, trendPct, pricePerGal, gallonsToFill, priceHistory, localPriceDeltaPct }) {
  const forReasons  = [];  // reasons to fill up now
  const waitReasons = [];  // reasons to wait
  let score = 0;

  // ── Critical: nearly empty ────────────────────────────────────────────────────
  if (daysRemaining < 2) {
    return {
      recommendation: 'Yes',
      summary: "Fill up now — you're almost out of gas.",
      forReasons: ['Tank is critically low (less than 2 days of fuel left).'],
      waitReasons: [],
    };
  }

  // ── Factor 1: Tank urgency ────────────────────────────────────────────────────
  if (daysRemaining < 4) {
    score += 55;
    forReasons.push(`Only ${daysRemaining.toFixed(1)} days of fuel left — you'll need gas very soon.`);
  } else if (daysRemaining < 7) {
    score += 30;
    forReasons.push(`About ${daysRemaining.toFixed(1)} days of fuel remaining — getting low.`);
  } else if (daysRemaining < 12) {
    score += 10;
    forReasons.push(`Roughly ${daysRemaining.toFixed(1)} days of fuel left.`);
  } else if (daysRemaining === Infinity) {
    score -= 30;
    waitReasons.push('No weekly mileage entered — tank level not a concern.');
  } else {
    score -= 25;
    waitReasons.push(`Tank has ${Math.floor(daysRemaining)}+ days of fuel — no urgency.`);
  }

  // ── Factor 2: Dollar impact of weekly price trend ─────────────────────────────
  // Think in dollars, not percentages — 0.5% on $4/gal × 10 gal = $0.20, barely matters.
  const weeklyDollarImpact = pricePerGal * (trendPct / 100) * gallonsToFill;

  if (weeklyDollarImpact > 2.00) {
    score += 45;
    forReasons.push(`Prices rising fast — waiting a week costs ~$${weeklyDollarImpact.toFixed(2)} more to fill up.`);
  } else if (weeklyDollarImpact > 0.75) {
    score += 20;
    forReasons.push(`Price trending up — waiting will cost ~$${weeklyDollarImpact.toFixed(2)} more per week.`);
  } else if (weeklyDollarImpact > 0.20) {
    score += 8;
    forReasons.push(`Slight upward price trend (+$${weeklyDollarImpact.toFixed(2)}/week impact on your fill-up).`);
  } else if (weeklyDollarImpact < -2.00) {
    score -= 45;
    waitReasons.push(`Prices dropping fast — waiting a week saves ~$${Math.abs(weeklyDollarImpact).toFixed(2)} on your fill-up.`);
  } else if (weeklyDollarImpact < -0.75) {
    score -= 20;
    waitReasons.push(`Price trending down — waiting may save ~$${Math.abs(weeklyDollarImpact).toFixed(2)} this week.`);
  } else if (weeklyDollarImpact < -0.20) {
    score -= 8;
    waitReasons.push(`Slight downward trend (save ~$${Math.abs(weeklyDollarImpact).toFixed(2)}/week if you wait).`);
  } else {
    waitReasons.push('Price is essentially flat week-over-week (less than $0.20 difference either way).');
  }

  // ── Factor 3: Current price vs 8-week average ─────────────────────────────────
  if (priceHistory && priceHistory.length >= 4) {
    const avg    = priceHistory.reduce((s, h) => s + h.value, 0) / priceHistory.length;
    const pctOff = ((pricePerGal - avg) / avg) * 100;
    const dolOff = (pricePerGal - avg) * gallonsToFill;

    if (pctOff < -3) {
      score += 35;
      forReasons.push(`Price is ${Math.abs(pctOff).toFixed(1)}% below the 8-week average — a relative bargain (saves ~$${Math.abs(dolOff).toFixed(2)} vs the average fill-up cost).`);
    } else if (pctOff < -1) {
      score += 15;
      forReasons.push(`Price is slightly below the 8-week average of $${avg.toFixed(3)}/gal.`);
    } else if (pctOff > 3) {
      score -= 30;
      waitReasons.push(`Price is ${pctOff.toFixed(1)}% above the 8-week average ($${avg.toFixed(3)}/gal) — it's been cheaper recently.`);
    } else if (pctOff > 1) {
      score -= 12;
      waitReasons.push(`Price is slightly above the 8-week average of $${avg.toFixed(3)}/gal.`);
    } else {
      waitReasons.push(`Price ($${pricePerGal.toFixed(3)}/gal) is near the 8-week average of $${avg.toFixed(3)}/gal.`);
    }
  }

  // ── Factor 4: Manual local price vs EIA benchmark ────────────────────────────
  if (localPriceDeltaPct != null) {
    if (localPriceDeltaPct <= -8) {
      score += 40;
      forReasons.push(`Your entered local price is ${Math.abs(localPriceDeltaPct).toFixed(1)}% below the EIA weekly benchmark — a favorable price to fill up now.`);
    } else if (localPriceDeltaPct >= 8) {
      if (daysRemaining > 4) {
        score -= 35;
        waitReasons.push(`Your entered local price is ${localPriceDeltaPct.toFixed(1)}% above the EIA weekly benchmark — consider waiting or finding a cheaper station nearby.`);
      } else {
        waitReasons.push(`Your entered local price is ${localPriceDeltaPct.toFixed(1)}% above the EIA weekly benchmark, but your low fuel level may not allow waiting long.`);
      }
    }
  }

  // ── Final recommendation ──────────────────────────────────────────────────────
  let recommendation, summary;
  if (score >= 40) {
    recommendation = 'Yes';
    summary = 'Filling up now makes sense.';
  } else if (score <= -20) {
    recommendation = 'No';
    summary = 'Conditions favor waiting.';
  } else {
    recommendation = 'Up to You';
    summary = 'No strong signal either way — fill up when convenient.';
  }

  return { recommendation, summary, forReasons, waitReasons };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  FEATURE 4 — PRICE SPARKLINE
// ═══════════════════════════════════════════════════════════════════════════════

function renderSparkline(history, isSimulated) {
  const wrap = el('sparklineWrap');
  if (!history || history.length < 2 || typeof Chart === 'undefined') {
    wrap.classList.add('hidden');
    return;
  }

  const isDark       = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const textColor    = isDark ? '#768390' : '#555577';
  const gridColor    = isDark ? '#30363d' : '#e0e4f4';
  const lineColor    = isDark ? '#4f8cc9' : '#2563eb';
  const fillColor    = isDark ? 'rgba(79,140,201,0.12)' : 'rgba(37,99,235,0.08)';

  const labels  = history.map(h => fmtChartDate(h.period));
  const values  = history.map(h => h.value);
  const minVal  = Math.min(...values);
  const maxVal  = Math.max(...values);
  const padding = Math.max(0.05, (maxVal - minVal) * 0.3);

  const ctx = el('sparklineCanvas').getContext('2d');
  if (sparkChart) { sparkChart.destroy(); sparkChart = null; }

  sparkChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        data: values,
        borderColor: lineColor,
        backgroundColor: fillColor,
        borderWidth: 2,
        fill: true,
        tension: 0.35,
        pointRadius: 3,
        pointHoverRadius: 5,
        pointBackgroundColor: lineColor,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: { label: ctx => `$${ctx.raw.toFixed(3)}/gal` },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { color: textColor, font: { size: 11 }, maxRotation: 30 },
        },
        y: {
          min: +(minVal - padding).toFixed(2),
          max: +(maxVal + padding).toFixed(2),
          grid: { color: gridColor },
          ticks: { color: textColor, font: { size: 11 }, callback: v => `$${v.toFixed(2)}` },
        },
      },
    },
  });

  el('chartBadge').textContent = isSimulated ? 'regional estimate' : 'EIA national benchmark';
  wrap.classList.remove('hidden');
}

function fmtChartDate(period) {
  const [, m, d] = period.split('-');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[parseInt(m, 10) - 1]} ${parseInt(d, 10)}`;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  FEATURE 5 — VEHICLE PROFILES
// ═══════════════════════════════════════════════════════════════════════════════

function loadProfiles() {
  const saved = store.get(K.profiles);
  if (saved && saved.length > 0) return saved;
  const defaults = [{ id: uid(), name: 'My Vehicle', tankSize: 15, mpg: 28, milesPerWeek: 200 }];
  store.set(K.profiles, defaults);
  return defaults;
}

function saveProfiles(arr) { store.set(K.profiles, arr); }

function activeProfile() {
  const profiles = loadProfiles();
  const activeId = store.get(K.activeProfile);
  return profiles.find(p => p.id === activeId) || profiles[0];
}

function populateProfileSelect() {
  const sel      = el('profileSelect');
  const profiles = loadProfiles();
  const active   = activeProfile();
  sel.innerHTML  = profiles.map(p =>
    `<option value="${p.id}" ${p.id === active.id ? 'selected' : ''}>${escHtml(p.name)}</option>`
  ).join('');
}

function applyProfile(p) {
  if (!p) return;
  el('tank_size').value      = p.tankSize;
  el('mpg').value             = p.mpg;
  el('miles_per_week').value = p.milesPerWeek;
  syncGauge(parseInt(el('fuel_level_range').value, 10));
  saveInputs();
}

function initProfileUI() {
  populateProfileSelect();
  applyProfile(activeProfile());

  el('profileSelect').addEventListener('change', () => {
    store.set(K.activeProfile, el('profileSelect').value);
    applyProfile(activeProfile());
  });

  el('profileAdd').addEventListener('click', () => openProfileDialog('add'));
  el('profileEdit').addEventListener('click', () => openProfileDialog('edit'));
  el('profileDelete').addEventListener('click', deleteActiveProfile);

  el('profileDlgClose').addEventListener('click',  closeProfileDialog);
  el('profileDlgCancel').addEventListener('click', closeProfileDialog);
  el('profileSave').addEventListener('click', saveProfile);
}

function openProfileDialog(mode) {
  const dlg = el('profileDialog');
  el('profileDialogTitle').textContent = mode === 'edit' ? 'Edit Vehicle' : 'Add Vehicle';

  if (mode === 'edit') {
    const p = activeProfile();
    editingProfileId  = p.id;
    el('pName').value  = p.name;
    el('pTank').value  = p.tankSize;
    el('pMpg').value   = p.mpg;
    el('pMiles').value = p.milesPerWeek;
  } else {
    editingProfileId  = null;
    el('pName').value  = '';
    el('pTank').value  = '';
    el('pMpg').value   = '';
    el('pMiles').value = '';
  }
  dlg.showModal();
}

function closeProfileDialog() { el('profileDialog').close(); }

function saveProfile() {
  const name  = el('pName').value.trim();
  const tank  = parseFloat(el('pTank').value);
  const mpg   = parseFloat(el('pMpg').value);
  const miles = parseFloat(el('pMiles').value);

  if (!name || isNaN(tank) || tank <= 0 || isNaN(mpg) || mpg <= 0 || isNaN(miles) || miles < 0) {
    alert('Please fill in all vehicle fields with valid values.');
    return;
  }

  let profiles = loadProfiles();
  if (editingProfileId) {
    profiles = profiles.map(p =>
      p.id === editingProfileId ? { ...p, name, tankSize: tank, mpg, milesPerWeek: miles } : p
    );
  } else {
    const newProfile = { id: uid(), name, tankSize: tank, mpg, milesPerWeek: miles };
    profiles.push(newProfile);
    store.set(K.activeProfile, newProfile.id);
  }
  saveProfiles(profiles);
  populateProfileSelect();
  applyProfile(activeProfile());
  closeProfileDialog();
}

function deleteActiveProfile() {
  const profiles = loadProfiles();
  if (profiles.length === 1) { alert('You need at least one vehicle profile.'); return; }
  if (!confirm(`Delete "${activeProfile().name}"?`)) return;
  const filtered = profiles.filter(p => p.id !== activeProfile().id);
  saveProfiles(filtered);
  store.set(K.activeProfile, filtered[0].id);
  populateProfileSelect();
  applyProfile(activeProfile());
}

// ═══════════════════════════════════════════════════════════════════════════════
//  FEATURE 6 — FILL-UP LOG
// ═══════════════════════════════════════════════════════════════════════════════

function loadFillLog() { return store.get(K.fillLog) || []; }
function saveFillLog(arr) { store.set(K.fillLog, arr); }

function initFillLogUI() {
  el('openFillLog').addEventListener('click',   () => openFillLogDialog());
  el('logFillupBtn').addEventListener('click',  () => openFillLogDialog(suggestedPrice));
  el('fillLogClose').addEventListener('click',  () => el('fillLogDialog').close());
  el('fillEntryForm').addEventListener('submit', e => { e.preventDefault(); addFillEntry(); });
}

function openFillLogDialog(priceHint = null) {
  el('logDate').value    = new Date().toISOString().slice(0, 10);
  el('logPrice').value   = priceHint ? priceHint.toFixed(3) : '';
  el('logGallons').value = '';
  el('fillEntryError').textContent = '';
  renderFillLog();
  el('fillLogDialog').showModal();
}

function addFillEntry() {
  const date    = el('logDate').value;
  const price   = parseFloat(el('logPrice').value);
  const gallons = parseFloat(el('logGallons').value);

  if (!date || isNaN(price) || price <= 0 || isNaN(gallons) || gallons <= 0) {
    el('fillEntryError').textContent = 'Please enter a valid date, price, and gallons.';
    return;
  }

  const log = loadFillLog();
  log.unshift({ id: uid(), date, price, gallons });
  saveFillLog(log);

  el('logDate').value    = new Date().toISOString().slice(0, 10);
  el('logPrice').value   = '';
  el('logGallons').value = '';
  el('fillEntryError').textContent = '';
  renderFillLog();
}

function renderFillLog() {
  const log    = loadFillLog();
  const tbody  = el('fillLogBody');
  const statsEl = el('fillStats');
  const tableWrap = el('fillTableWrap');
  const emptyEl   = el('emptyLog');

  if (log.length === 0) {
    statsEl.classList.add('hidden');
    tableWrap.classList.add('hidden');
    emptyEl.classList.remove('hidden');
    return;
  }

  emptyEl.classList.add('hidden');

  // Stats
  const avgPrice   = log.reduce((s, e) => s + e.price, 0) / log.length;
  const totalGal   = log.reduce((s, e) => s + e.gallons, 0);
  const totalSpend = log.reduce((s, e) => s + e.price * e.gallons, 0);
  statsEl.innerHTML = `
    <div class="fill-stat"><span class="fill-stat-label">Avg price</span><span class="fill-stat-value">$${avgPrice.toFixed(3)}/gal</span></div>
    <div class="fill-stat"><span class="fill-stat-label">Total gallons</span><span class="fill-stat-value">${totalGal.toFixed(1)}</span></div>
    <div class="fill-stat"><span class="fill-stat-label">Total spent</span><span class="fill-stat-value">$${totalSpend.toFixed(2)}</span></div>
    <div class="fill-stat"><span class="fill-stat-label">Fill-ups</span><span class="fill-stat-value">${log.length}</span></div>
  `;
  statsEl.classList.remove('hidden');

  // Table
  tbody.innerHTML = log.map(entry => `
    <tr>
      <td>${entry.date}</td>
      <td>$${entry.price.toFixed(3)}</td>
      <td>${entry.gallons.toFixed(2)}</td>
      <td>$${(entry.price * entry.gallons).toFixed(2)}</td>
      <td><button class="del-entry-btn" data-id="${entry.id}" title="Delete">✕</button></td>
    </tr>
  `).join('');

  tbody.querySelectorAll('.del-entry-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const updated = loadFillLog().filter(e => e.id !== btn.dataset.id);
      saveFillLog(updated);
      renderFillLog();
    });
  });

  tableWrap.classList.remove('hidden');
}

// ═══════════════════════════════════════════════════════════════════════════════
//  FEATURE 7 — RESULTS DISPLAY (refactored)
// ═══════════════════════════════════════════════════════════════════════════════

function displayResults({
  recommendation, summary, forReasons, waitReasons,
  currentFuelGal, burnPerDay, daysRemaining,
  pricePerGal, priceForCost, localPriceEntered, localPriceDeltaPct, trendPct,
  tankSize, fuelLevelPct,
  inputData, source, confidence,
  effectiveResult, hasAnyReward, gallonsToFill,
  travelResult,
}) {
  const badge = el('confidenceBadge');
  badge.className = `confidence-badge ${confidence.level}`;
  badge.innerHTML = `<span class="confidence-level">${escHtml(confidence.label)}:</span> <span class="confidence-reason">${escHtml(confidence.reason)}</span>`;
  badge.classList.remove('hidden');

  const recBox = el('recommendationBox');
  recBox.textContent = recommendation;
  recBox.className   = 'recommendation';
  if (recommendation === 'Yes')       recBox.classList.add('yes');
  else if (recommendation === 'No')  recBox.classList.add('no');
  else                                recBox.classList.add('uncertain');

  el('reason').textContent = summary;

  // Structured reasons panel
  const detail = el('reasonsDetail');
  let html = '';
  if (forReasons.length) {
    html += `<div class="reasons-col reasons-for">
      <div class="reasons-col-title">✓ Reasons to fill up</div>
      <ul>${forReasons.map(r => `<li>${escHtml(r)}</li>`).join('')}</ul>
    </div>`;
  }
  if (waitReasons.length) {
    html += `<div class="reasons-col reasons-wait">
      <div class="reasons-col-title">○ Reasons to wait</div>
      <ul>${waitReasons.map(r => `<li>${escHtml(r)}</li>`).join('')}</ul>
    </div>`;
  }
  detail.innerHTML = html;
  detail.classList.toggle('hidden', !html);

  showCostCards(pricePerGal, trendPct, tankSize, fuelLevelPct, burnPerDay, priceForCost);
  showDaysBar(daysRemaining);

  // Calculation details table (simplified — no projected ratio)
  const tbody = el('detailsTable').querySelector('tbody');
  tbody.innerHTML = '';
  const rows = [
    ['Current fuel in tank',       `${currentFuelGal.toFixed(2)} gal`],
    ['Daily fuel burn',            `${burnPerDay.toFixed(2)} gal/day`],
    ['Est. days of fuel left',     daysRemaining === Infinity ? '∞' : `${daysRemaining.toFixed(1)} days`],
    ['Benchmark price (national)', `$${pricePerGal.toFixed(3)}/gal`],
  ];
  if (localPriceEntered) {
    rows.push(['Your local price (manual)', `$${priceForCost.toFixed(3)}/gal`]);
    const deltaSign = localPriceDeltaPct >= 0 ? '+' : '';
    const deltaDir  = localPriceDeltaPct < 0 ? 'below' : 'above';
    rows.push(['Local vs benchmark', `${deltaSign}${localPriceDeltaPct.toFixed(1)}% ${deltaDir} benchmark`]);
  }
  if (localPriceEntered && effectiveResult && effectiveResult.savingsPerGal > 0) {
    rows.push(['Effective price (after rewards)', `$${effectiveResult.effectivePrice.toFixed(3)}/gal`]);
    rows.push(['Reward savings per gallon',       `-$${effectiveResult.savingsPerGal.toFixed(3)}`]);
  }
  rows.push(
    ['Weekly price trend',         `${trendPct >= 0 ? '+' : ''}${trendPct.toFixed(2)}%`],
    ['ZIP code',                   inputData.zip_code],
  );
  rows.forEach(([l, v]) => addRow(tbody, l, v));

  if (travelResult && travelResult.verdict !== 'hint' && travelResult.verdict !== 'no-fuel') {
    addRow(tbody, 'Alternate station', travelResult.altName || 'Alternate station');
    addRow(tbody, 'Alternate effective price', `$${travelResult.altEffectivePrice.toFixed(3)}/gal`);
    const distLabel = travelResult.altDistanceType === 'one-way'
      ? `${travelResult.altDistance} mi one-way`
      : travelResult.altDistanceType === 'round-trip'
      ? `${travelResult.altDistance} mi round-trip`
      : `${travelResult.altDistance} mi detour`;
    addRow(tbody, 'Travel distance', distLabel);
    addRow(tbody, 'Net savings (with travel)', `${travelResult.netSavings >= 0 ? '+' : ''}$${travelResult.netSavings.toFixed(2)}`);
  }

  el('dataSourceNote').textContent = `Benchmark source: ${source}`;

  renderDealComparison({
    breakdown:        effectiveResult ? effectiveResult.breakdown : [],
    localPriceEntered,
    hasAnyReward:     hasAnyReward || false,
    gallonsToFill:    gallonsToFill || 0,
  });

  renderTravelComparison(travelResult);

  el('result').classList.remove('hidden');
  el('result').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function showCostCards(pricePerGal, trendPct, tankSize, fuelLevelPct, burnPerDay, priceForCost) {
  const gallonsToFill = tankSize * (1 - fuelLevelPct / 100);
  const costNow       = gallonsToFill * priceForCost;

  // In 7 days: fewer gallons needed (burned some), but price may have changed
  const burnedInWeek       = Math.min(burnPerDay * 7, tankSize * (fuelLevelPct / 100));
  const gallonsToFillWait  = Math.min(tankSize, gallonsToFill + burnedInWeek);
  const priceAfterWeek     = priceForCost * (1 + trendPct / 100);
  const costWait           = gallonsToFillWait * priceAfterWeek;

  el('costNow').textContent     = `$${costNow.toFixed(2)}`;
  el('costWait').textContent    = `$${costWait.toFixed(2)}`;
  el('costNowSub').textContent  = `~${gallonsToFill.toFixed(1)} gal at $${priceForCost.toFixed(3)}/gal`;
  el('costWaitSub').textContent = `~${gallonsToFillWait.toFixed(1)} gal projected at trend-adjusted price`;
  el('costCards').classList.remove('hidden');
}

function showDaysBar(daysRemaining) {
  const wrap  = el('daysBarWrap');
  const fill  = el('daysFill');
  const label = el('daysLabel');

  const capped  = Math.min(daysRemaining === Infinity ? 30 : daysRemaining, 30);
  const pct     = (capped / 30) * 100;

  label.textContent = daysRemaining === Infinity ? '∞ days' :
    daysRemaining < 1 ? `${(daysRemaining * 24).toFixed(0)} hrs` :
    `${daysRemaining.toFixed(1)} days`;

  fill.style.width = `${pct}%`;
  fill.style.backgroundColor =
    daysRemaining < 3  ? 'var(--days-low)' :
    daysRemaining < 7  ? 'var(--days-warn)' :
                          'var(--days-ok)';

  wrap.classList.remove('hidden');
}

// ═══════════════════════════════════════════════════════════════════════════════
//  FEATURE 10 — NEARBY STATIONS
// ═══════════════════════════════════════════════════════════════════════════════

async function resolveCoords(zip) {
  // Prefer GPS coords if already obtained this session
  if (lastCoords) return lastCoords;

  // Cache geocode results for the session so repeated checks don't re-query
  const cacheKey = `gasp_geo_${zip}`;
  const cached   = sessionStorage.getItem(cacheKey);
  if (cached) return JSON.parse(cached);

  // Zippopotam: free, no API key, no special headers required
  const res  = await fetch(`https://api.zippopotam.us/us/${zip}`);
  if (!res.ok) throw new Error(`ZIP lookup failed (${res.status}) — check the ZIP code`);
  const data = await res.json();
  const coords = {
    lat: parseFloat(data.places[0].latitude),
    lon: parseFloat(data.places[0].longitude),
  };
  sessionStorage.setItem(cacheKey, JSON.stringify(coords));
  return coords;
}

async function fetchStations(lat, lon) {
  const radiusM = 16093; // 10 miles
  // Plain `out;` is the default verbosity and always includes node coordinates.
  // `out body N;` was silently dropping geometry in some Overpass versions.
  const query = `[out:json][timeout:15];node["amenity"="fuel"](around:${radiusM},${lat},${lon});out;`;
  const res   = await fetch(
    `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`
  );
  if (!res.ok) throw new Error(`Overpass error ${res.status}`);
  const json = await res.json();
  return (json.elements || [])
    .map(node => ({
      name: node.tags?.name || node.tags?.brand || node.tags?.operator || 'Gas Station',
      lat:  parseFloat(node.lat),
      lon:  parseFloat(node.lon),
    }))
    .filter(s => !isNaN(s.lat) && !isNaN(s.lon))
    .slice(0, 20);
}

function haversine(lat1, lon1, lat2, lon2) {
  const R    = 3958.8; // miles
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a    = Math.sin(dLat / 2) ** 2 +
               Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
               Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function renderStations(stations, lat, lon, zip) {
  const wrap  = el('stationsWrap');
  const list  = el('stationsList');
  const msg   = el('stationsMsg');

  if (!stations.length) {
    list.innerHTML = '';
    msg.textContent = 'No gas stations found within 5 miles.';
    wrap.classList.remove('hidden');
    return;
  }

  const sorted = stations
    .map(s => ({ ...s, dist: haversine(lat, lon, s.lat, s.lon) }))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 10);

  list.innerHTML = sorted.map(s => `
    <li class="station-item">
      <div class="station-info">
        <span class="station-name">${escHtml(s.name)}</span>
        <span class="station-dist">${s.dist.toFixed(1)} mi away</span>
      </div>
      <a class="station-link"
         href="https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lon}"
         target="_blank" rel="noopener">Directions</a>
    </li>
  `).join('');

  msg.innerHTML = `Prices not listed — check <a href="https://www.gasbuddy.com/home?search=${encodeURIComponent(zip)}&fuel=1" target="_blank" rel="noopener">GasBuddy</a> for current station prices.`;
  wrap.classList.remove('hidden');
}

async function loadStations(zip) {
  const wrap = el('stationsWrap');
  wrap.classList.add('hidden');
  try {
    const coords   = await resolveCoords(zip);
    const stations = await fetchStations(coords.lat, coords.lon);
    renderStations(stations, coords.lat, coords.lon, zip);
  } catch (err) {
    el('stationsMsg').textContent = `Could not load nearby stations: ${err.message}`;
    wrap.classList.remove('hidden');
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  GEOLOCATION
// ═══════════════════════════════════════════════════════════════════════════════

async function useCurrentLocation() {
  const zipInput  = el('zip_code');
  const loadingEl = el('loading');
  loadingEl.textContent = 'Finding your location…';
  loadingEl.classList.remove('hidden');

  try {
    const pos = await new Promise((resolve, reject) => {
      if (!navigator.geolocation) { reject(new Error('Geolocation not supported.')); return; }
      navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 10000 });
    });
    const { latitude: lat, longitude: lon } = pos.coords;
    lastCoords = { lat, lon };
    const zip = await reverseGeocodeToZip(lat, lon);
    if (zip) {
      zipInput.value = zip;
      saveInputs();
    } else {
      alert('Could not determine your ZIP code. Please enter it manually.');
    }
  } catch (err) {
    alert('Location error: ' + err.message);
  } finally {
    loadingEl.textContent = 'Fetching data…';
    loadingEl.classList.add('hidden');
  }
}

async function reverseGeocodeToZip(lat, lon) {
  const url  = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`;
  const res  = await fetch(url);
  if (!res.ok) throw new Error(`Geocoding error ${res.status}`);
  const data = await res.json();
  const raw  = data.postcode || '';
  const m    = raw.match(/\d{5}/);
  return m ? m[0] : null;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  FEATURE 8 — PWA SERVICE WORKER
// ═══════════════════════════════════════════════════════════════════════════════

function registerSW() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  navigator.serviceWorker.register('./service-worker.js')
    .then(r => console.log('SW registered, scope:', r.scope))
    .catch(e => console.warn('SW registration failed:', e));
}

// ═══════════════════════════════════════════════════════════════════════════════
//  UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

function el(id) { return document.getElementById(id); }

function uid() { return Math.random().toString(36).slice(2, 10); }

function escHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Format a dollar amount with the sign placed before $, not between $ and digits.
// sign=true → prefix + for non-negative values (e.g. table rows that show gains/losses)
// decimals → number of decimal places (default 2)
// Examples: fmtCurrency(-2.38) → "-$2.38"  fmtCurrency(1.67,{sign:true}) → "+$1.67"
function fmtCurrency(v, { sign = false, decimals = 2 } = {}) {
  const prefix = v < 0 ? '-' : (sign ? '+' : '');
  return `${prefix}$${Math.abs(v).toFixed(decimals)}`;
}

function addRow(tbody, label, value) {
  const tr  = document.createElement('tr');
  const td1 = document.createElement('td'); td1.textContent = label;
  const td2 = document.createElement('td'); td2.textContent = value;
  tr.appendChild(td1); tr.appendChild(td2); tbody.appendChild(tr);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  FORM SUBMISSION
// ═══════════════════════════════════════════════════════════════════════════════

async function handleSubmit(event) {
  event.preventDefault();
  const errorEl  = el('formError');
  const loadEl   = el('loading');
  errorEl.textContent = '';
  el('result').classList.add('hidden');
  loadEl.classList.remove('hidden');

  try {
    const tankSize        = parseFloat(el('tank_size').value);
    const fuelLevelPct    = parseFloat(el('fuel_level_percent').value);
    const mpg             = parseFloat(el('mpg').value);
    const milesPerWeek    = parseFloat(el('miles_per_week').value);
    const zipCode         = el('zip_code').value.trim();

    if (
      isNaN(tankSize)     || tankSize <= 0 ||
      isNaN(fuelLevelPct) || fuelLevelPct < 0 || fuelLevelPct > 100 ||
      isNaN(mpg)          || mpg <= 0 ||
      isNaN(milesPerWeek) || milesPerWeek < 0 ||
      !/^\d{5}$/.test(zipCode)
    ) {
      throw new Error('Please fill in all fields. ZIP code must be 5 digits.');
    }

    const localPriceRaw     = el('local_price').value.trim();
    const localPriceEntered = localPriceRaw !== '';
    const localPrice        = localPriceEntered ? Number(localPriceRaw) : null;

    if (localPriceEntered) {
      if (!Number.isFinite(localPrice)) {
        throw new Error('Local price is not a valid number. Check for a typo.');
      }
      if (localPrice < 0.50) {
        throw new Error('Local price looks too low — minimum is $0.50/gal. Check for a typo.');
      }
      if (localPrice > 15.00) {
        throw new Error('Local price looks too high — maximum is $15.00/gal. Check for a typo.');
      }
    }
    const localPriceHighWarning = localPriceEntered && localPrice > 10.00;

    // Validate reward inputs
    const gbCheck = validateRewardField(el('gasbuddy_savings').value.trim());
    const upCheck = validateRewardField(el('upside_cashback').value.trim());
    updateRewardWarning('gasBuddyWarn', gbCheck.warning);
    updateRewardWarning('upsideWarn',   upCheck.warning);
    if (gbCheck.blocked) throw new Error('GasBuddy discount: ' + gbCheck.warning);
    if (upCheck.blocked) throw new Error('Upside cash back: '  + upCheck.warning);

    const gasBuddy     = gbCheck.val;
    const upside       = upCheck.val;
    const stackVal     = el('stackability').value;
    const hasAnyReward = (gasBuddy != null && gasBuddy > 0) || (upside != null && upside > 0);

    saveInputs();

    // Fetch price + history (+ start station load in parallel)
    const [priceData] = await Promise.all([
      fetchPriceAndHistory(zipCode),
      loadStations(zipCode),        // fires and forgets — stations appear when ready
    ]);

    const priceForCost       = localPriceEntered ? localPrice : priceData.price;
    const localPriceDeltaPct = localPriceEntered
      ? ((localPrice - priceData.price) / priceData.price) * 100
      : null;
    suggestedPrice = priceForCost;

    const burnPerWeek    = milesPerWeek / mpg;
    const burnPerDay     = burnPerWeek / 7;
    const currentFuelGal = (fuelLevelPct / 100) * tankSize;
    const gallonsToFill  = tankSize - currentFuelGal;
    const daysRemaining  = burnPerDay > 0 ? currentFuelGal / burnPerDay : Infinity;

    const { recommendation, summary, forReasons, waitReasons } = decidePurchase({
      daysRemaining,
      trendPct:          priceData.trendPct,
      pricePerGal:       priceForCost,
      gallonsToFill,
      priceHistory:      localPriceEntered ? null : priceData.history,
      localPriceDeltaPct,
    });

    if (localPriceHighWarning) {
      waitReasons.push('This entered price is unusually high. Check for a typo before relying on this recommendation.');
    }

    const effectiveResult = (localPriceEntered && hasAnyReward)
      ? calculateEffectivePrice(localPrice, gasBuddy, upside, stackVal)
      : null;

    // Phase 3: alternate station travel comparison
    let travelResult = null;
    const altFieldset = el('altStationFieldset');
    if (altFieldset && !altFieldset.classList.contains('hidden')) {
      const altDistRaw  = el('alt_distance').value.trim();
      const altPriceRaw = el('alt_price').value.trim();
      if (altDistRaw && altPriceRaw) {
        const altDistance = parseFloat(altDistRaw);
        const altPrice    = parseFloat(altPriceRaw);
        const altGBCheck  = validateRewardField(el('alt_gasbuddy').value.trim());
        const altUpCheck  = validateRewardField(el('alt_upside').value.trim());
        updateRewardWarning('altGasBuddyWarn', altGBCheck.warning);
        updateRewardWarning('altUpsideWarn',   altUpCheck.warning);
        if (altGBCheck.blocked) throw new Error('Alt station GasBuddy: ' + altGBCheck.warning);
        if (altUpCheck.blocked) throw new Error('Alt station Upside: '   + altUpCheck.warning);
        if (!isNaN(altDistance) && altDistance > 0 && !isNaN(altPrice) && altPrice > 0) {
          const currentEffectiveForTravel = effectiveResult ? effectiveResult.effectivePrice : priceForCost;
          travelResult = calculateAltTravelComparison({
            tankSize, fuelLevelPct, mpg,
            currentEffectivePrice: currentEffectiveForTravel,
            altPrice,
            altGasBuddy:     altGBCheck.val,
            altUpside:       altUpCheck.val,
            altStackability: el('alt_stackability').value,
            altDistance,
            altDistanceType: el('alt_distance_type').value,
            altName:         el('alt_name').value.trim() || null,
          });
        }
      }
    }

    const confidence = calculateConfidence({
      localPriceEntered,
      hasVehicleData:  tankSize > 0 && mpg > 0,
      benchmarkSource: priceData.simulated ? 'regional' : 'eia',
      hasGB:           gasBuddy != null && gasBuddy > 0,
      hasUpside:       upside   != null && upside   > 0,
      stackability:    stackVal,
    });

    displayResults({
      recommendation, summary, forReasons, waitReasons,
      currentFuelGal,
      burnPerDay,
      daysRemaining,
      pricePerGal:  priceData.price,
      priceForCost,
      localPriceEntered,
      localPriceDeltaPct,
      trendPct:     priceData.trendPct,
      tankSize,
      fuelLevelPct,
      inputData: { zip_code: zipCode },
      source:    priceData.source,
      confidence,
      effectiveResult,
      hasAnyReward,
      gallonsToFill,
      travelResult,
    });

    renderSparkline(priceData.history, priceData.simulated);

  } catch (err) {
    errorEl.textContent = err.message;
  } finally {
    loadEl.classList.add('hidden');
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  INIT
// ═══════════════════════════════════════════════════════════════════════════════

function init() {
  // Feature 5: load profiles first so tank size is ready for gauge
  initProfileUI();

  // Feature 1: restore saved inputs (may override profile defaults)
  loadInputs();

  // Feature 2: wire up gauge
  initFuelGauge();
  syncGauge(parseInt(el('fuel_level_range').value, 10));

  // Feature 6: fill-up log
  initFillLogUI();

  // Phase 2A: reward inputs + stackability show/hide
  initRewardInputs();

  // Phase 3: alternate station inputs
  initAltStationInputs();

  // Save on every field change
  ['tank_size', 'mpg', 'miles_per_week', 'zip_code', 'local_price'].forEach(id => {
    el(id).addEventListener('input', saveInputs);
  });

  el('useLocation').addEventListener('click', e => { e.preventDefault(); useCurrentLocation(); });
  el('gasForm').addEventListener('submit', handleSubmit);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  BOOT
// ═══════════════════════════════════════════════════════════════════════════════

registerSW();

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
