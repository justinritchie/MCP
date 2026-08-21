/**
 * Multi-site fanout for the Gravity Forms plane — LOCAL fork feature.
 *
 * Kept in its own module ON PURPOSE: the integration points in index.js are a
 * handful of tiny hooks, and everything substantive lives here, so upstream
 * rewrites of index.js merge cleanly instead of conflicting on this feature
 * every sync. (The 2026-07 upstream restructure is exactly why this exists.)
 *
 * How it works
 * ------------
 * Credentials for every GravityKit site live in a sites config file:
 *   ~/.mcp-credentials/gravitykit-sites.json
 *   {
 *     "cbrcsummit": { "base": "https://cbrcsummit.net", "key": "ck_…", "secret": "cs_…" },
 *     "aarlocal":   { "base": "https://…", "key": "ck_…", "secret": "cs_…",
 *                     "wpUsername": "justin", "wpAppPassword": "xxxx xxxx …" },
 *     ...
 *   }
 * `base`/`key`/`secret` (Gravity Forms consumer credentials) drive the gf_*
 * plane. `wpUsername`/`wpAppPassword` (a WordPress Application Password) are
 * OPTIONAL and drive the gv_* abilities plane — a site with GF keys but no WP
 * credentials keeps working exactly as before, with the abilities plane dark
 * for that site alone.
 *
 * The file is re-read on every call (mtime-cached), so a new site can be
 * HOT-SWAPPED mid-session — add it to the JSON and use it immediately, no
 * restart. Each gf_* tool takes an optional `site` param; default is
 * GRAVITY_DEFAULT_SITE or 'cbrcsummit'.
 *
 * Scope
 * -----
 * BOTH planes are now site-scoped.
 *
 *   Plane A — Gravity Forms (gf_* + field operations). One GF client per site,
 *   built on first use and cached. `site` selects it per call.
 *
 *   Plane B — GravityKit abilities (gv_* and any other product prefix). One
 *   WordPress client + one abilities catalog per site, loaded LAZILY on first
 *   use and cached, so nothing fans out across all sites at startup. `site`
 *   selects it per call; tools/list advertises one site's catalog (the
 *   "advertised" site — GRAVITYKIT_ABILITIES_SITE, else the first site in the
 *   file carrying WP credentials), and gk_reload_abilities(site=…) re-points
 *   and force-refreshes it. Calls still dispatch against the CALLER's site,
 *   whether or not it is the advertised one.
 *
 * Failures on the abilities plane are loud and specific by design — a bare 404
 * or silence was the thing this replaced. See describeAbilitiesFailure().
 *
 * index.js wires this in with a handful of small hooks:
 *   1. import { multisiteActive, resolveSite, withSite, toolTakesSite,
 *               DEFAULT_SITE, abilitiesDefinitionsForList, resolveAbilityCall,
 *               reloadAbilitiesForSite }
 *   2. ListTools — seed the GF plane from DEFAULT_SITE so gf_* tools advertise,
 *      source the ability defs from abilitiesDefinitionsForList(), then
 *      `.map(withSite)` to expose the `site` param on everything
 *   3. CallTool  — capture the requested site, point the GF client at it, strip
 *      the `site` arg before dispatch, and route gv_* / gk_reload_abilities
 *      through resolveAbilityCall() / reloadAbilitiesForSite()
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

const SITES_FILE = process.env.GRAVITY_SITES_FILE
  || path.join(os.homedir(), '.mcp-credentials/gravitykit-sites.json');

/** Default site used when a call omits `site` (and for seeding tools/list). */
export const DEFAULT_SITE = process.env.GRAVITY_DEFAULT_SITE || 'cbrcsummit';

let _sitesCache = null;
let _sitesMtime = -1;
let _clients = {};       // site label -> { client, fieldOps }            (GF plane)
let _wpClients = {};     // site label -> WordPressClient                 (abilities plane)
let _abilities = {};     // site label -> catalog cache entry             (abilities plane)
let _abilitiesInFlight = {}; // site label -> Promise (single-flight per site)
let _advertisedSite = null;  // which site's catalog tools/list shows

/** How long a failed catalog load is remembered before the next attempt.
 *  Mirrors index.js's ABILITIES_RETRY_COOLDOWN_MS so a Foundation-less site
 *  doesn't pay a failed round-trip on every single call. */
const ABILITIES_RETRY_COOLDOWN_MS = 60_000;

/**
 * True only when a sites config file is present. When false, every index.js
 * hook is a no-op and the server behaves exactly like upstream (single site
 * from GRAVITY_FORMS_* env).
 */
export function multisiteActive() {
  try {
    fs.statSync(SITES_FILE);
    return true;
  } catch {
    return false;
  }
}

/** Read + mtime-cache the sites file. Config edits drop the client cache so a
 *  hot-swapped credential takes effect on the next call. */
function loadSites() {
  try {
    const st = fs.statSync(SITES_FILE);
    if (_sitesCache === null || st.mtimeMs !== _sitesMtime) {
      _sitesCache = JSON.parse(fs.readFileSync(SITES_FILE, 'utf8'));
      _sitesMtime = st.mtimeMs;
      // Config changed -> drop every derived client/catalog so edits take
      // effect on the next call (adding wpUsername/wpAppPassword to a site
      // lights up its abilities plane without a restart, same as GF creds).
      _clients = {};
      _wpClients = {};
      _abilities = {};
      _abilitiesInFlight = {};
    }
  } catch {
    if (_sitesCache === null) _sitesCache = {};
  }
  return _sitesCache;
}

/** Which tools the `site` param applies to: the Gravity Forms plane. The
 *  static gf_* tools and the field-operation tools all use the gf_ prefix;
 *  gv_* abilities and gk_* control tools are excluded. */
export function toolTakesSite(name) {
  return typeof name === 'string' && name.startsWith('gf_');
}

/**
 * Resolve a site label to a live GF client + field ops, building and caching it
 * on first use. The heavy client classes are injected via `deps` so this module
 * stays decoupled from upstream file layout:
 *   deps = { GravityFormsClient, createFieldOperations, fieldRegistry, FieldAwareValidator }
 * @returns {Promise<{client: object, fieldOps: object}>}
 */
export async function resolveSite(siteLabel, deps) {
  const sites = loadSites();
  const label = siteLabel || DEFAULT_SITE;
  const cfg = sites[label];
  if (!cfg || !cfg.base || !cfg.key || !cfg.secret) {
    const valid = Object.keys(sites).join(', ') || '(none configured)';
    throw new Error(
      `Unknown or incomplete GravityKit site '${label}'. Configured: ${valid}. `
      + `Add base/key/secret for it to ${SITES_FILE}.`
    );
  }
  if (!_clients[label]) {
    const fieldValidator = new deps.FieldAwareValidator();
    const client = new deps.GravityFormsClient({
      ...process.env,
      GRAVITY_FORMS_BASE_URL: cfg.base,
      GRAVITY_FORMS_CONSUMER_KEY: cfg.key,
      GRAVITY_FORMS_CONSUMER_SECRET: cfg.secret,
    });
    const validation = await client.initialize();
    if (!validation.available) {
      throw new Error(`GravityKit site '${label}' (${cfg.base}) failed to initialize: ${validation.error}`);
    }
    const fieldOps = deps.createFieldOperations(client, deps.fieldRegistry, fieldValidator);
    _clients[label] = { client, fieldOps };
  }
  return _clients[label];
}

/**
 * Inject an optional `site` param into a tool's input schema.
 *
 * Every tool in a multi-site deployment is site-scoped: gf_* selects a Gravity
 * Forms client, gv_* and gk_reload_abilities select an abilities catalog. The
 * description differs per plane because the defaults differ — the GF plane
 * falls back to DEFAULT_SITE, the abilities plane to the advertised site.
 */
export function withSite(tool) {
  if (!tool || typeof tool.name !== 'string') return tool;
  const props = { ...((tool.inputSchema && tool.inputSchema.properties) || {}) };
  if (!props.site) {
    props.site = {
      type: 'string',
      description: toolTakesSite(tool.name)
        ? `Target GravityKit site (default '${DEFAULT_SITE}'). Sites are configured in the gravitykit-sites.json credentials file — add one there and it's usable immediately (hot-swap, no restart).`
        : `Target GravityKit site (default '${advertisedAbilitiesSite() || DEFAULT_SITE}'). Only sites carrying wpUsername/wpAppPassword in the gravitykit-sites.json credentials file expose GravityKit product tools; the rest return a message saying so.`,
    };
  }
  return { ...tool, inputSchema: { type: 'object', ...(tool.inputSchema || {}), properties: props } };
}

// ===========================================================================
// Abilities plane (gv_* and any other GravityKit product prefix)
// ===========================================================================
//
// Per site: one WordPressClient + one abilities catalog, both built lazily on
// first use and cached. NOTHING here runs at startup and nothing ever fans out
// across all configured sites — a tools/list on an 8-site file touches exactly
// one site (the advertised one), and only when it has WP credentials.

/** True when this site entry carries the optional WordPress credentials. */
function siteHasWpCreds(cfg) {
  return !!(cfg && cfg.wpUsername && cfg.wpAppPassword);
}

/**
 * Which site's catalog tools/list advertises. Sticky once
 * gk_reload_abilities(site=…) re-points it; otherwise
 * GRAVITYKIT_ABILITIES_SITE, then DEFAULT_SITE if it has WP creds, then the
 * first site in the file that does. Null when no site has WP credentials —
 * the whole abilities plane is dark, exactly as before this existed.
 */
export function advertisedAbilitiesSite() {
  const sites = loadSites();
  if (_advertisedSite && siteHasWpCreds(sites[_advertisedSite])) return _advertisedSite;
  const preferred = process.env.GRAVITYKIT_ABILITIES_SITE;
  if (preferred && siteHasWpCreds(sites[preferred])) return preferred;
  if (siteHasWpCreds(sites[DEFAULT_SITE])) return DEFAULT_SITE;
  for (const [label, cfg] of Object.entries(sites)) {
    if (siteHasWpCreds(cfg)) return label;
  }
  return null;
}

/**
 * Resolve a site label + its config for the abilities plane.
 * @throws with a message that names the file to edit when the site is unknown
 *         or has no WordPress credentials.
 */
function resolveAbilitiesSiteConfig(siteLabel) {
  const sites = loadSites();
  const label = siteLabel || advertisedAbilitiesSite();
  if (!label) {
    throw new Error(
      'No GravityKit site has WordPress credentials, so no GravityKit product tools (gv_*) are available. '
      + `Add "wpUsername" and "wpAppPassword" (a WordPress Application Password — keep its internal spaces exactly as WordPress issued it) to a site entry in ${SITES_FILE}. `
      + 'Gravity Forms consumer key/secret alone cannot reach the abilities catalog.'
    );
  }
  const cfg = sites[label];
  if (!cfg) {
    const valid = Object.keys(sites).join(', ') || '(none configured)';
    throw new Error(`Unknown GravityKit site '${label}'. Configured: ${valid}. Add it to ${SITES_FILE}.`);
  }
  if (!siteHasWpCreds(cfg)) {
    const withCreds = Object.entries(sites).filter(([, c]) => siteHasWpCreds(c)).map(([l]) => l);
    throw new Error(
      `No WordPress credentials configured for GravityKit site '${label}' (${cfg.base}), so its GravityKit product tools (gv_*) are unavailable. `
      + `Add "wpUsername" and "wpAppPassword" to the '${label}' entry in ${SITES_FILE} `
      + '(a WordPress Application Password — keep its internal spaces exactly as WordPress issued it; the Gravity Forms key/secret cannot reach the abilities catalog). '
      + `Sites that currently have WordPress credentials: ${withCreds.join(', ') || '(none)'}.`
    );
  }
  return { label, cfg };
}

/** Build (and cache) the WordPressClient for one site. */
function wpClientFor(label, cfg, deps) {
  if (!_wpClients[label]) {
    _wpClients[label] = new deps.WordPressClient({
      ...process.env,
      GRAVITYKIT_WP_URL: cfg.base,
      GRAVITYKIT_WP_USERNAME: cfg.wpUsername,
      GRAVITYKIT_WP_APP_PASSWORD: cfg.wpAppPassword,
    });
  }
  return _wpClients[label];
}

/**
 * Turn a catalog-load failure into a message a human can act on.
 *
 * Runs ONLY on the failure path, and only once per cooldown window (the result
 * is cached with the failure), so the happy path pays nothing. It probes
 * `/wp-json/` to tell the four cases apart, because "GravityView isn't
 * installed" and "WordPress is down" and "your password is wrong" all surface
 * from the loader as the same generic throw.
 */
async function describeAbilitiesFailure(label, cfg, wpClient, loadErr) {
  let httpStatus = null;
  let namespaces = null;
  let netError = null;
  try {
    const res = await wpClient.httpClient.request({ method: 'GET', baseURL: wpClient.baseUrl, url: '/wp-json/' });
    httpStatus = res.status;
    namespaces = Array.isArray(res.data && res.data.namespaces) ? res.data.namespaces : [];
  } catch (e) {
    httpStatus = (e.response && e.response.status) || null;
    netError = e.message;
  }

  if (httpStatus === 401 || httpStatus === 403) {
    return `WordPress rejected the credentials for GravityKit site '${label}' (${cfg.base}) with HTTP ${httpStatus}. `
      + `Check "wpUsername" / "wpAppPassword" for '${label}' in ${SITES_FILE} — an Application Password must keep its internal spaces exactly as WordPress issued it.`;
  }
  if (namespaces === null) {
    return `Could not reach WordPress at ${cfg.base} for GravityKit site '${label}': ${netError || loadErr.message}. `
      + `No gv_* tools are available for that site until it is reachable; retry with gk_reload_abilities(site="${label}").`;
  }
  if (!namespaces.includes('gravitykit/v1')) {
    const core = namespaces.includes('wp-abilities/v1')
      ? 'The WordPress core Abilities API is present but nothing on the site registers GravityKit abilities.'
      : 'Neither the GravityKit Foundation abilities catalog nor the WordPress core Abilities API is present.';
    return `GravityView is not active on '${label}' (${cfg.base}), so it has no GravityKit product tools (gv_*). `
      + `${core} Install/activate GravityView (which brings GravityKit Foundation) on that site, then call gk_reload_abilities(site="${label}"). `
      + `Its gf_* Gravity Forms tools are unaffected.`;
  }
  return `GravityKit Foundation is active on '${label}' (${cfg.base}) but returned no usable abilities: ${loadErr.message}. `
    + `Check that GravityView is active and its abilities are enabled in GravityKit settings, then call gk_reload_abilities(site="${label}").`;
}

/**
 * Load (or return the cached) abilities catalog for one site.
 *
 * Single-flight per site; failures are cached with their human-readable
 * explanation for ABILITIES_RETRY_COOLDOWN_MS so a GravityView-less site
 * doesn't re-probe on every call. `force` bypasses both caches.
 *
 * deps = { WordPressClient, loadAbilitiesAsTools, reservedNames?, onCatalogChanged?, logger? }
 * @returns {Promise<{ok: true, definitions: object[], handlers: object, count: number, source: string}
 *                  |{ok: false, message: string}>}
 */
export async function loadAbilitiesForSite(siteLabel, deps, { force = false } = {}) {
  let label, cfg;
  try {
    ({ label, cfg } = resolveAbilitiesSiteConfig(siteLabel));
  } catch (e) {
    return { ok: false, message: e.message };
  }

  if (force) {
    delete _abilities[label];
    delete _abilitiesInFlight[label];
    delete _wpClients[label];
  }

  const cached = _abilities[label];
  if (cached) {
    if (cached.ok) return cached;
    if (Date.now() - cached.failedAt < ABILITIES_RETRY_COOLDOWN_MS) return cached;
    delete _abilities[label]; // cooldown elapsed — try again
  }
  if (_abilitiesInFlight[label]) return _abilitiesInFlight[label];

  const log = deps.logger;
  const promise = (async () => {
    let wpClient;
    try {
      wpClient = wpClientFor(label, cfg, deps);
    } catch (e) {
      // WordPressClient constructor rejects bad/unsafe config (e.g. Basic auth
      // over remote plain HTTP) — surface it verbatim, it already explains itself.
      return { ok: false, message: `WordPress client for GravityKit site '${label}' (${cfg.base}) could not be created: ${e.message}` };
    }
    try {
      const { definitions, handlers, count, source } =
        await deps.loadAbilitiesAsTools(wpClient, { reservedNames: deps.reservedNames });
      if (log) log.info(`✅ Loaded ${count} GravityKit abilities for site '${label}' from ${source}`);
      return { ok: true, site: label, definitions, handlers, count, source };
    } catch (err) {
      delete _wpClients[label]; // rebuild the transport on the next attempt
      const message = await describeAbilitiesFailure(label, cfg, wpClient, err);
      if (log) log.warn(`⚠️  Abilities catalog unavailable for site '${label}': ${message}`);
      return { ok: false, site: label, message, failedAt: Date.now() };
    }
  })()
    .then((result) => {
      _abilities[label] = result;
      delete _abilitiesInFlight[label];
      if (result.ok && deps.onCatalogChanged) deps.onCatalogChanged();
      return result;
    })
    .catch((err) => {
      delete _abilitiesInFlight[label];
      return { ok: false, site: label, message: `Abilities load for site '${label}' threw unexpectedly: ${err.message}`, failedAt: Date.now() };
    });

  _abilitiesInFlight[label] = promise;
  return promise;
}

/**
 * Ability tool definitions for tools/list — the ADVERTISED site's catalog.
 *
 * Bounded by `timeoutMs` (index.js passes the same budget upstream uses) so a
 * slow or unreachable site never hangs the handshake: the list ships without
 * gv_* tools and the load, still running in the background, fires
 * onCatalogChanged when it lands. Exactly one site is contacted.
 *
 * @returns {Promise<object[]>}
 */
export async function abilitiesDefinitionsForList(deps, { timeoutMs } = {}) {
  const label = advertisedAbilitiesSite();
  if (!label) return []; // no site has WP creds — plane stays dark, as before
  const load = loadAbilitiesForSite(label, deps);
  const result = timeoutMs
    ? await Promise.race([load, new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs))])
    : await load;
  return result && result.ok ? result.definitions : [];
}

/**
 * Resolve one ability call to a handler, or to a loud reason why not.
 *
 * @returns {Promise<{status:'dispatch', handler: Function, site: string}
 *                 | {status:'error', message: string}
 *                 | {status:'unknown'}>}
 */
export async function resolveAbilityCall(name, siteLabel, deps) {
  const result = await loadAbilitiesForSite(siteLabel, deps);
  if (!result.ok) return { status: 'error', message: result.message };
  if (Object.prototype.hasOwnProperty.call(result.handlers, name)) {
    return { status: 'dispatch', handler: result.handlers[name], site: result.site };
  }
  // Catalog is healthy but doesn't carry this tool. If it looks like a product
  // tool, say which site was searched — otherwise it's a genuinely unknown name
  // and index.js reports it as such.
  if (/^g[a-z]{1,3}_/.test(name) && name.startsWith('gv_')) {
    return {
      status: 'error',
      message: `'${name}' is not in the GravityKit abilities catalog for site '${result.site}' `
        + `(${result.count} tools from ${result.source}). The catalog varies per site with the installed GravityKit products and versions — `
        + `call gk_reload_abilities(site="${result.site}") to refresh it, or pass a different site.`,
    };
  }
  return { status: 'unknown' };
}

/**
 * gk_reload_abilities for one site: force a re-fetch and make that site the
 * advertised one, so tools/list reflects it afterwards.
 * @returns {Promise<object>} JSON-serialisable summary.
 */
export async function reloadAbilitiesForSite(siteLabel, deps) {
  const requested = siteLabel || advertisedAbilitiesSite();
  const before = (_abilities[requested] && _abilities[requested].ok) ? _abilities[requested].count : 0;
  const result = await loadAbilitiesForSite(siteLabel, deps, { force: true });

  if (result.ok) {
    _advertisedSite = result.site;
    if (deps.onCatalogChanged) deps.onCatalogChanged();
    return {
      loaded: true,
      site: result.site,
      ability_tool_count: result.count,
      previous_count: before,
      source: result.source,
      advertised_site: _advertisedSite,
      note: `Catalog refreshed for '${result.site}' and it is now the site advertised in tools/list. `
        + 'Clients receive `notifications/tools/list_changed` automatically. '
        + 'gv_* calls can still target any other credentialed site with the `site` param.',
    };
  }
  return {
    loaded: false,
    site: requested || null,
    ability_tool_count: 0,
    previous_count: before,
    advertised_site: advertisedAbilitiesSite(),
    error: result.message,
  };
}

/** Test seam: drop every cached client/catalog without touching the sites file. */
export function _resetMultisiteCaches() {
  _clients = {};
  _wpClients = {};
  _abilities = {};
  _abilitiesInFlight = {};
  _advertisedSite = null;
  _sitesCache = null;
  _sitesMtime = -1;
}
