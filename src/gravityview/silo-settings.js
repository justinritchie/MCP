/**
 * Route namespaced ("silo") View settings to the shape that actually persists.
 *
 * WHAT THE CATALOG CLAIMS
 *   gv_template_settings_schema_get advertises namespaced settings as dotted
 *   paths and says "writes route to the correct meta key".
 *
 * WHAT ACTUALLY HAPPENS — measured on View 4839 (aaru65), 2026-08-21, one inert
 * setting written three ways with a read-back after each:
 *
 *   datatables.scrolly     -> did NOT route. WordPress sanitize_key() strips the
 *                             dot (it keeps only a-z0-9_-), so the write lands
 *                             on an invented top-level key `datatablesscrolly`
 *                             that nothing reads.
 *   datatables_scrolly     -> did NOT route either. Lands as a real top-level
 *                             key of that name, which nothing reads.
 *   {datatables:{scrolly}} -> ROUTED. Nested is the only form that reaches the
 *                             silo meta key (_gravityview_datatables_settings).
 *
 * The originating ticket had this backwards: it reported underscore as the form
 * that works and nested as broken. Both dotted and underscore writes return 200
 * with the value echoed, which is why an entire DataTables configuration could
 * appear to apply while being inert.
 *
 * WHAT THIS DOES
 *   Converts a dotted key into the nested object that persists, so the
 *   documented spelling finally means what it says. Deliberately does NOT touch
 *   underscore keys: `page_size`, `no_results_text` and `sort_columns` are all
 *   legitimate top-level settings, so `a_b` is genuinely ambiguous and guessing
 *   would silently relocate real settings. Callers wanting a silo write should
 *   use dotted or nested; both now work.
 */

/** Tools whose params carry a template_settings map worth normalising. */
const SETTINGS_TOOLS = new Set(['gv_view_settings_patch', 'gv_view_config_apply', 'gv_view_create']);

/**
 * @param {string} name   Tool name.
 * @param {object} params Caller params (not mutated).
 * @returns {{params: object, converted: Array<{from: string, to: string}>}}
 */
export function normalizeSiloSettings(name, params) {
  if (!SETTINGS_TOOLS.has(name) || !params || typeof params !== 'object') {
    return { params, converted: [] };
  }
  const ts = params.template_settings;
  if (!ts || typeof ts !== 'object' || Array.isArray(ts)) {
    return { params, converted: [] };
  }

  const converted = [];
  const out = {};
  for (const [key, value] of Object.entries(ts)) {
    const dot = key.indexOf('.');
    if (dot <= 0 || dot === key.length - 1) {
      out[key] = value;
      continue;
    }
    // Only the FIRST dot separates silo from setting. A deeper path
    // (a.b.c) nests further, which matches how the silos are stored.
    const prefix = key.slice(0, dot);
    const rest = key.slice(dot + 1);
    const existing = (out[prefix] && typeof out[prefix] === 'object' && !Array.isArray(out[prefix]))
      ? out[prefix]
      : {};
    // Recurse through remaining dots so a.b.c becomes {a:{b:{c:…}}}.
    const nested = rest.includes('.')
      ? normalizeSiloSettings(name, { template_settings: { [rest]: value } }).params.template_settings
      : { [rest]: value };
    out[prefix] = { ...existing, ...nested };
    converted.push({ from: key, to: `${prefix}.${rest}` });
  }

  if (!converted.length) return { params, converted: [] };
  return { params: { ...params, template_settings: out }, converted };
}

/**
 * Keys that look like a failed silo write from before this fix — a top-level
 * key beginning with a known silo prefix and no separator, e.g.
 * `datatablesscrolly`. Reported so a caller can clean them up; never removed
 * automatically, because removal is a write the caller did not ask for.
 *
 * Removal, when wanted, is `gv_view_settings_patch` with the key set to null —
 * which works and is undocumented.
 */
export function findOrphanSiloKeys(templateSettings) {
  if (!templateSettings || typeof templateSettings !== 'object') return [];
  const silos = Object.keys(templateSettings).filter(
    (k) => templateSettings[k] && typeof templateSettings[k] === 'object'
      && !Array.isArray(templateSettings[k]));
  return Object.keys(templateSettings).filter((k) =>
    silos.some((s) => k !== s && k.startsWith(s) && !k.startsWith(`${s}_`)));
}
