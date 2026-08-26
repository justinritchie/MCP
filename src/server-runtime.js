/**
 * Pure helpers for the MCP server runtime, extracted from index.js so the
 * two-plane behavior is unit-testable. See test/server-runtime.test.js.
 */

/**
 * Initialize the two capability planes. The WordPress plane must not be gated
 * on the (potentially slow) Gravity Forms REST probe.
 * @returns {Promise<{gfOk: boolean, wpOk: boolean}>}
 */
export async function runPlaneInit({ initGravityFormsPlane, initWordPressPlane }) {
  // WP plane first (synchronous, instant — it fire-and-forgets the abilities
  // load) so a slow GF REST probe never gates it. Then await the GF probe.
  const wpOk = initWordPressPlane();
  const gfOk = await initGravityFormsPlane();
  if (!gfOk && !wpOk) {
    throw new Error('Neither Gravity Forms nor WordPress credentials are usable. Set GRAVITY_FORMS_* and/or GRAVITYKIT_WP_* in .env.');
  }
  return { gfOk, wpOk };
}

/**
 * Assemble the advertised tool list. Gravity Forms tools are only listed when
 * that plane is live (otherwise they'd error on call). gk_reload_abilities is
 * always present; ability tools appear once the catalog loads.
 */
export function buildToolList({ gfReady, gfToolDefs = [], fieldOpTools = [], abilityDefs = [], gkReloadDef }) {
  return [
    ...(gfReady ? [...gfToolDefs, ...fieldOpTools] : []),
    ...(abilityDefs ?? []),
    gkReloadDef,
  ].filter(Boolean);
}

/**
 * Decide how to route a call that wasn't a static Gravity Forms tool or
 * gk_reload_abilities: dispatch to the dynamic ability handler map, or one of
 * the error states.
 * @returns {'dispatch'|'no-wp-client'|'catalog-unreachable'|'unknown'}
 */
export function classifyAbilityCall({ name, hasWpClient, handlers }) {
  // Route by handler-map membership — product-agnostic, so any GravityKit
  // prefix (gv_, gc_, …) dispatches as long as the catalog registered it.
  if (handlers && Object.prototype.hasOwnProperty.call(handlers, name)) return 'dispatch';
  if (!hasWpClient) return 'no-wp-client';
  if (!handlers) return 'catalog-unreachable';
  return 'unknown';
}

/**
 * How long tools/list waits for the abilities catalog before shipping the list.
 *
 * DEFAULT RAISED 2000 -> 10000 (2026-08-26), because 2s was losing the race on
 * real sites and losing it SILENTLY.
 *
 * Measured on the AAR sites, interval between the two tools/list_changed on a
 * single startup: 3.72s, 3.55s, 4.12s. The catalog load genuinely succeeds and
 * logs "Loaded 50 GravityKit abilities" every time — but tools/list had already
 * answered ~1.5s earlier with a gf_*-only surface, and a client that takes the
 * first list for the session never sees gv_*. Restarts, connector toggles and
 * reboots all re-run the same race and lose it the same way, which is exactly
 * why it reads as "the tools disappeared".
 *
 * The old default assumed a warm ~800ms load, and that assumption was the whole
 * bug: it was tuned against a fast site and never revisited against a slow one.
 *
 * 10s is chosen to sit comfortably above the observed 4.1s worst case while
 * still bounding a genuinely hung site. This only costs anything on the FIRST
 * tools/list of a session, and only when the catalog is actually loading — an
 * unreachable WP fails its client init fast and disables abilities without
 * waiting here at all.
 *
 * Clients that honor tools/list_changed do not strictly need this, but there is
 * no way to detect that from here, and being right for the one-shot case costs
 * a few seconds once.
 *
 * GRAVITYKIT_MCP_LIST_TIMEOUT_MS still overrides. Non-positive or non-numeric
 * values fall back to the default.
 *
 * @param {Record<string,string|undefined>} [env]
 * @returns {number} milliseconds
 */
export const ABILITIES_LIST_TIMEOUT_DEFAULT_MS = 10000;

export function resolveAbilitiesListTimeoutMs(env = process.env) {
  const raw = Number(env.GRAVITYKIT_MCP_LIST_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : ABILITIES_LIST_TIMEOUT_DEFAULT_MS;
}
