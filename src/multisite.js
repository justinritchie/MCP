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
 *     ...
 *   }
 * The file is re-read on every call (mtime-cached), so a new site can be
 * HOT-SWAPPED mid-session — add it to the JSON and use it immediately, no
 * restart. Each gf_* tool takes an optional `site` param; default is
 * GRAVITY_DEFAULT_SITE or 'cbrcsummit'.
 *
 * Scope
 * -----
 * This swaps ONLY the Gravity Forms plane (gf_* tools + field operations), which
 * is all this feature ever covered. The gv_* abilities plane loads from whatever
 * WordPress creds the process booted with; in the sites-file-only deployment
 * (no GRAVITY_FORMS_* / GRAVITYKIT_WP_* env) the abilities plane simply stays
 * dark, exactly as it did before upstream added it.
 *
 * index.js wires this in with three small hooks:
 *   1. import { multisiteActive, resolveSite, withSite, toolTakesSite, DEFAULT_SITE }
 *   2. ListTools — seed the GF plane from DEFAULT_SITE so gf_* tools advertise,
 *      then `.map(withSite)` to expose the `site` param
 *   3. CallTool  — resolve the requested site, point the GF client at it, strip
 *      the `site` arg before dispatch
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
let _clients = {}; // site label -> { client, fieldOps }

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
      _clients = {}; // config changed -> rebuild clients so edits take effect
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

/** Inject an optional `site` param into a gf_* tool's input schema. Non-gf_*
 *  tools pass through unchanged. */
export function withSite(tool) {
  if (!tool || !toolTakesSite(tool.name)) return tool;
  const props = { ...((tool.inputSchema && tool.inputSchema.properties) || {}) };
  if (!props.site) {
    props.site = {
      type: 'string',
      description: `Target GravityKit site (default '${DEFAULT_SITE}'). Sites are configured in the gravitykit-sites.json credentials file — add one there and it's usable immediately (hot-swap, no restart).`,
    };
  }
  return { ...tool, inputSchema: { type: 'object', ...(tool.inputSchema || {}), properties: props } };
}
