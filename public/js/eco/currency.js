// Currency picker + amount + exchange rate, used by the finance forms.
// What was paid is kept in its own currency; the rate converts it to the app currency (Settings) for totals.
import { state } from './state.js';
import { esc } from './ui.js';

const TOP = ['PKR', 'USD', 'GBP', 'EUR', 'AED', 'SAR', 'CAD', 'AUD'];
const names = (() => { try { return new Intl.DisplayNames(['en'], { type: 'currency' }); } catch { return null; } })();
export const currencyName = (c) => { try { return names?.of(c) || c; } catch { return c; } };
export const baseCurrency = () => (state.settings?.currency || 'USD').toUpperCase();

let all = null;
export function currencies() {
  if (all) return all;
  let list = [];
  try { list = Intl.supportedValuesOf('currency'); } catch { list = []; }
  if (!list.length) list = ['AED', 'AUD', 'BDT', 'CAD', 'CHF', 'CNY', 'EUR', 'GBP', 'HKD', 'INR', 'JPY', 'MYR', 'NZD', 'OMR', 'PKR', 'QAR', 'SAR', 'SGD', 'TRY', 'USD', 'ZAR'];
  const rest = list.filter((c) => !TOP.includes(c)).sort();
  all = { top: TOP, rest };
  return all;
}

// "PKR 4,500" in the given currency
export function fmtCur(amount, code) {
  const c = (code || baseCurrency()).toUpperCase();
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: c, currencyDisplay: 'code', maximumFractionDigits: Number.isInteger(Number(amount)) ? 0 : 2 }).format(Number(amount) || 0).replace(/ /g, ' '); }
  catch { return `${c} ${Number(amount || 0).toLocaleString()}`; }
}
// Show the original, plus the converted value when it differs
export function fmtPaid(row, money) {
  const cur = (row.currency || baseCurrency()).toUpperCase();
  if (cur === baseCurrency() || row.amount_original == null) return money(row.amount);
  return `${fmtCur(row.amount_original, cur)} <span class="muted small">≈ ${money(row.amount)}</span>`;
}

// Live rate: how many units of the base currency one unit of `from` is worth
const cache = {};
export async function fetchRate(from) {
  const base = baseCurrency();
  if (from === base) return 1;
  if (!cache[base]) {
    cache[base] = fetch(`https://open.er-api.com/v6/latest/${base}`).then((r) => (r.ok ? r.json() : null)).then((j) => (j && j.result === 'success' ? j.rates : null)).catch(() => null);
  }
  const rates = await cache[base];
  const perBase = rates?.[from];
  return perBase ? 1 / perBase : null;
}

const lastKey = 'webnox.lastCurrency';
const lastCurrency = () => { try { return localStorage.getItem(lastKey); } catch { return null; } };

// Fields: currency → amount → (if not the base) exchange rate with a live converted preview
export function moneyFieldsHTML({ id = 'mf', label = 'Amount', currency = null, amount = '', rate = null } = {}) {
  const base = baseCurrency();
  const cur = (currency || lastCurrency() || base).toUpperCase();
  const { top, rest } = currencies();
  const opt = (c) => `<option value="${c}" ${c === cur ? 'selected' : ''}>${c} · ${esc(currencyName(c))}</option>`;
  return `
    <div class="field"><label for="${id}-cur">Currency</label>
      <select id="${id}-cur" class="select">${top.map(opt).join('')}<option disabled>──────────</option>${rest.map(opt).join('')}</select></div>
    <div class="field"><label for="${id}-amt">${esc(label)} (<span data-cur-tag>${esc(cur)}</span>)</label>
      <div class="money-input"><span data-cur-tag>${esc(cur)}</span><input id="${id}-amt" class="input" type="number" min="0" step="0.01" value="${esc(amount)}" placeholder="0"></div></div>
    <div class="field span-2 fx-row ${cur === base ? 'hidden' : ''}" data-fx>
      <label for="${id}-rate">Exchange rate</label>
      <div class="fx-line"><span>1 <b data-cur-tag>${esc(cur)}</b> =</span><input id="${id}-rate" class="input" type="number" min="0" step="any" value="${esc(rate ?? '')}" style="max-width:160px"><span>${esc(base)}</span>
        <span class="fx-eq" data-fx-eq></span></div>
      <span class="hint" data-fx-hint>Totals and reports are in ${esc(base)} (Settings). The live rate is filled in for you; change it to the rate you actually paid.</span></div>`;
}

export function bindMoneyFields(root, { id = 'mf', money } = {}) {
  const base = baseCurrency();
  const cur = root.querySelector(`#${id}-cur`); const amt = root.querySelector(`#${id}-amt`); const rate = root.querySelector(`#${id}-rate`);
  const fx = root.querySelector('[data-fx]'); const eq = root.querySelector('[data-fx-eq]'); const hint = root.querySelector('[data-fx-hint]');
  const preview = () => {
    const a = Number(amt.value); const r = Number(rate.value);
    eq.textContent = cur.value !== base && a >= 0 && r > 0 && amt.value !== '' ? `≈ ${money ? money(a * r) : fmtCur(a * r, base)}` : '';
  };
  const onCur = async (fetchNew) => {
    root.querySelectorAll('[data-cur-tag]').forEach((t) => { t.textContent = cur.value; });
    fx.classList.toggle('hidden', cur.value === base);
    try { localStorage.setItem(lastKey, cur.value); } catch { /* ignore */ }
    if (cur.value !== base && (fetchNew || !rate.value)) {
      rate.value = ''; hint.textContent = 'Getting today\'s rate…';
      const r = await fetchRate(cur.value);
      if (r) { rate.value = Number(r.toPrecision(6)); hint.textContent = `Today's rate filled in. Change it to the rate you actually paid. Totals are in ${base}.`; }
      else hint.textContent = `Couldn't get a live rate. Type how many ${base} one ${cur.value} is.`;
    }
    preview();
  };
  cur.addEventListener('change', () => onCur(true));
  amt.addEventListener('input', preview); rate.addEventListener('input', preview);
  onCur(false);
  return {
    read() {
      const c = cur.value; const a = amt.value === '' ? NaN : Number(amt.value); const r = c === base ? 1 : Number(rate.value);
      if (!(a >= 0)) return { error: 'Enter the amount.' };
      if (c !== base && !(r > 0)) return { error: `Add the exchange rate from ${c} to ${base}.` };
      return { currency: c, amount_original: a, fx_rate: r, amount: Math.round(a * r * 100) / 100 };
    },
  };
}
