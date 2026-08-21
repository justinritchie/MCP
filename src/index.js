#!/usr/bin/env node

/**
 * Gravity MCP Server
 * Model Context Protocol server for Gravity Forms
 * Tools for forms, entries, and add-ons
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import GravityFormsClient from './gravity-forms-client.js';
import { createFieldOperations, fieldOperationHandlers, fieldOperationTools } from './field-operations/index.js';
import { confirmationOperationHandlers, confirmationOperationTools } from './confirmation-operations/index.js';
import { normalizeSiloSettings } from './gravityview/silo-settings.js';
import fieldRegistry from './field-definitions/field-registry.js';
import FieldAwareValidator from './config/field-validation.js';
import logger from './utils/logger.js';
import { sanitize } from './utils/sanitize.js';
import { stripEmpty, stripEntryMetaFromResponse } from './utils/compact.js';
import { WordPressClient } from './wp-client.js';
import { loadAbilitiesAsTools } from './abilities/loader.js';
import { runPlaneInit, buildToolList, classifyAbilityCall, resolveAbilitiesListTimeoutMs } from './server-runtime.js';
// Local fork: multi-site fanout for BOTH planes — gf_* (Gravity Forms) and
// gv_* (GravityKit abilities). All the machinery lives in ./multisite.js so
// this stays a few small hooks that survive upstream rewrites of index.js.
// See that file for the sites-config format and scope.
import {
  multisiteActive, resolveSite, withSite, toolTakesSite, DEFAULT_SITE,
  abilitiesDefinitionsForList, resolveAbilityCall, reloadAbilitiesForSite,
} from './multisite.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables:
// 	1. Current working directory first
dotenv.config({ path: join(process.cwd(), '.env') });
// 	2. Gravity MCP project directory
dotenv.config({ path: join(__dirname, '..', '.env') });

// Initialize the MCP server
const server = new Server(
  {
    name: 'gravitykit-mcp',
    version: '2.1.0'
  },
  {
    capabilities: {
      tools: { listChanged: true }
    },
    instructions: 'GravityKit MCP server. Tools come from two independent planes.\n\ngf_* are always-on Gravity Forms tools (forms, entries, feeds, notifications, fields), present on any site with working Gravity Forms REST credentials.\n\ngv_* (and other GravityKit product prefixes) are generated from the connected site\'s GravityKit Foundation abilities catalog. They are present only when Foundation and the product (GravityView for gv_*) are active, so the available set varies per site.\n\nEach tool is self-describing: its description and inputSchema document its parameters and behavior. The GravityView surface is discoverable through the gv_*_list tools (gv_views_list, gv_layouts_list, gv_widgets_list, gv_available_fields_get) and gv_field_type_schema_get for field, widget, and search-field shapes. To add or configure a search bar, prefer gv_search_bar_add — one call with a View id plus fields[] of {field_id, input?} creates the search_bar and its fields; use the low-level gv_search_field_* tools only for surgical slot edits after gv_view_config_get. gk_reload_abilities refreshes the catalog when product tools are missing or stale.\n\nTWO THINGS THE CATALOG DOES NOT TELL YOU about View template_settings, both measured on a live View:\n\n1. Namespaced ("silo") settings such as DataTables. gv_template_settings_schema_get advertises these as dotted paths and says writes route to the correct meta key. Dotted DOES now work — this server converts it — but the UNDERSCORE spelling (datatables_save_state) does NOT: it lands as a top-level key nothing reads, while still returning 200 with the value echoed. That is how an entire DataTables configuration can appear to apply and be inert. Use the dotted form (datatables.save_state) or the nested form ({datatables: {save_state: …}}). Never the underscore form.\n\n2. gv_view_settings_patch is documented as merge-only, but passing null as a value REMOVES that key. It is the only way to delete a setting written by mistake.'
  }
);

// Global client instance
let gravityFormsClient = null;
let fieldOperations = null;
let fieldValidator = null;
let wpClient = null;
// Auto-generated from the WordPress Abilities API (Foundation catalog
// first, WP core fallback). Populated by initializeClient(). This is
// the ONLY source of gv_* tools — when no catalog is reachable (older
// WP, plugin off), these stay null, gv_* tools are absent from
// tools/list, and every gv_* call retries the load (self-healing).
let abilityToolDefinitions = null;
let abilityToolHandlers = null;
// In-flight catalog fetch. Single-flight: concurrent callers share the
// same promise. On rejection it's cleared so a later call retries —
// covers transient cert / network / WP-not-yet-booted failures without
// requiring an MCP process restart. Retries are bounded by a cooldown
// so Foundation-less sites (gf_* only) don't pay two failed requests
// on every tools/list forever; gk_reload_abilities bypasses it.
let abilitiesLoadPromise = null;
let abilitiesFailedAt = 0;
const ABILITIES_RETRY_COOLDOWN_MS = 60_000;

// --- Local fork: multi-site fanout -----------------------------------------
// This deployment sets no GRAVITY_FORMS_* env; every site's creds come from the
// sites config file (see multisite.js). So instead of upstream's env-driven GF
// plane init, the GF client is (re)pointed at a site here — from DEFAULT_SITE
// for tools/list, and per-call from the `site` arg for gf_* dispatch. Seeding
// gravityFormsClient this way makes runPlaneInit's GF plane "usable" so it never
// throws for the missing WP plane, and buildToolList advertises the gf_* tools.
const MULTISITE_DEPS = { GravityFormsClient, createFieldOperations, fieldRegistry, FieldAwareValidator };
async function pointGravityPlaneAtSite(siteLabel) {
  const { client, fieldOps } = await resolveSite(siteLabel, MULTISITE_DEPS);
  gravityFormsClient = client;
  fieldOperations = fieldOps;
}
// Same idea for plane B. multisite.js owns one WordPressClient + one abilities
// catalog PER SITE (lazy, cached), so the module-global wpClient / abilities
// state below is simply unused in the sites-file deployment. Heavy classes are
// injected so multisite.js stays decoupled from upstream's file layout.
const ABILITIES_DEPS = {
  WordPressClient,
  loadAbilitiesAsTools,
  logger,
  get reservedNames() { return RESERVED_TOOL_NAMES; },
  onCatalogChanged: () => {
    server.sendToolListChanged().catch((err) => {
      logger.warn(`tools/list_changed notification failed: ${err.message}`);
    });
  },
};

/**
 * Initialize the two independent capability planes.
 *
 * Plane A — Gravity Forms: static gf_* tools over GF REST v2. Works on
 * any Gravity Forms site; requires only GRAVITY_FORMS_* credentials.
 *
 * Plane B — GravityKit abilities: dynamic tools from the Foundation
 * catalog (all GravityKit products) with WP-core fallback. Requires a
 * WordPress app password (or the GF credential fallback) and lights up
 * only when Foundation is active on the site.
 *
 * Each plane initializes independently and degrades independently —
 * a GF-only site gets the full gf_* surface with no abilities, and a
 * GravityKit site without GF REST keys still gets abilities. Failed
 * planes retry on later calls, bounded by a cooldown.
 *
 * @throws when NEITHER plane has usable credentials.
 */
const INIT_RETRY_COOLDOWN_MS = 60_000;
let gfPlaneFailedAt = 0;
let wpPlaneFailedAt = 0;

async function initializeClient() {
  // WP plane starts first (synchronous) so the GF REST probe can't gate it;
  // runPlaneInit throws only when neither plane has usable credentials.
  await runPlaneInit({
    initGravityFormsPlane: initializeGravityFormsPlane,
    initWordPressPlane: initializeWordPressPlane,
  });
  return true;
}

async function initializeGravityFormsPlane() {
  if (gravityFormsClient) return true;
  if (Date.now() - gfPlaneFailedAt < INIT_RETRY_COOLDOWN_MS) return false;

  try {
    const client = new GravityFormsClient(process.env);
    const validation = await client.initialize();

    if (!validation.available) {
      throw new Error(validation.error);
    }

    gravityFormsClient = client;
    fieldValidator = new FieldAwareValidator();
    fieldOperations = createFieldOperations(
      gravityFormsClient,
      fieldRegistry,
      fieldValidator
    );

    logger.info('✅ Gravity Forms client initialized — gf_* tools available');
    return true;
  } catch (gfError) {
    gfPlaneFailedAt = Date.now();
    logger.warn(`⚠️  Gravity Forms client unavailable: ${gfError.message} — gf_* tools disabled (will retry)`);
    return false;
  }
}

function initializeWordPressPlane() {
  if (wpClient) return true;
  if (Date.now() - wpPlaneFailedAt < INIT_RETRY_COOLDOWN_MS) return false;

  try {
    // WordPress client — the authenticated transport to the WP root
    // (Foundation catalog + WP core Abilities API). Credentials and
    // base URL are resolved independently of the GF REST endpoint,
    // with fallback to GRAVITY_FORMS_* so single-WP-install setups
    // don't need to mint two separate credentials.
    wpClient = new WordPressClient(process.env);
    logger.info('✅ WordPress client initialized — loading GravityKit abilities');

    // Fire-and-forget: kick off the abilities catalog fetch in the
    // background so MCP startup is fast. ListTools awaits up to 2s
    // for it; per-call self-heal and gk_reload_abilities retry later.
    ensureAbilitiesLoaded();
    return true;
  } catch (wpError) {
    wpPlaneFailedAt = Date.now();
    wpClient = null;
    logger.warn(`⚠️  WordPress client unavailable: ${wpError.message} — abilities tools disabled (will retry)`);
    return false;
  }
}

/**
 * Idempotent + self-healing loader for the WordPress Abilities API
 * catalog. Single-flight (concurrent callers share a promise), with
 * a per-call optional timeout (used by ListTools so a slow / down WP
 * doesn't hang the tool list at startup). On rejection the cached
 * promise is cleared so the NEXT call retries — sleep/wake, cert
 * mid-fix, valet still booting all self-heal on the next gv_* call.
 *
 * Side effects on success:
 *   - populates `abilityToolDefinitions` + `abilityToolHandlers`
 *   - emits `notifications/tools/list_changed` so MCP clients refetch
 *
 * @param {Object}   [opts]
 * @param {boolean}  [opts.force]      Discard cached state and reload.
 * @param {number}   [opts.timeoutMs]  Cap the await; the load itself
 *                                     keeps running in the background
 *                                     after the timeout fires.
 */
async function ensureAbilitiesLoaded({ force = false, timeoutMs } = {}) {
  if (!wpClient) return;
  if (force) {
    abilityToolDefinitions = null;
    abilityToolHandlers = null;
    abilitiesLoadPromise = null;
    abilitiesFailedAt = 0;
  }
  if (abilityToolDefinitions) return;
  if (!abilitiesLoadPromise && Date.now() - abilitiesFailedAt < ABILITIES_RETRY_COOLDOWN_MS) return;
  if (!abilitiesLoadPromise) {
    abilitiesLoadPromise = loadAbilitiesAsTools(wpClient, { reservedNames: RESERVED_TOOL_NAMES })
      .then(({ definitions, handlers, count, source }) => {
        abilityToolDefinitions = definitions;
        abilityToolHandlers = handlers;
        const sourceLabel = source === 'foundation-catalog' ? 'gravitykit/v1 catalog' : '/wp-abilities/v1';
        logger.info(`✅ Loaded ${count} GravityKit abilities from ${sourceLabel}`);
        // Tell connected MCP clients to refetch the tool list so the
        // freshly loaded ability tools and their schemas land in the
        // client's cached catalogue.
        server.sendToolListChanged().catch((err) => {
          logger.warn(`tools/list_changed notification failed: ${err.message}`);
        });
      })
      .catch((err) => {
        logger.warn(`⚠️  Abilities API catalog unavailable: ${err.message} — abilities tools unavailable until a catalog is reachable (next retry after cooldown, or gk_reload_abilities)`);
        abilitiesFailedAt = Date.now();
        abilitiesLoadPromise = null; // clear so a later call retries
        throw err;
      });
  }
  if (timeoutMs) {
    await Promise.race([
      abilitiesLoadPromise.catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  } else {
    await abilitiesLoadPromise.catch(() => {});
  }
}

/**
 * Recursively strip null, empty string, and false values from objects/arrays.
 * Reduces token usage by removing noise like empty field values and absent meta keys.
 */
/**
 * Create standard error response
 */
function createErrorResponse(message, details = null) {
  return {
    content: [
      {
        type: "text",
        text: `Error: ${message}${details ? `\nDetails: ${JSON.stringify(details)}` : ''}`
      }
    ],
    isError: true
  };
}

/**
 * Wrap async handler with error handling and response compaction.
 * @param {Function} handler - async function returning result object
 * @param {object} params - tool params; if compact !== false, strips null/empty/false values
 */
function wrapHandler(handler, params = {}) {
  return async () => {
    if (!gravityFormsClient) {
      return createErrorResponse('Gravity Forms client not initialized');
    }

    try {
      const result = await handler();
      const output = params.compact !== false ? stripEmpty(result) : result;

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(output)
          }
        ]
      };
    } catch (error) {
      const safeDetails = error.details ? sanitize(error.details) : undefined;
      logger.error(`Tool error: ${error.message}`);
      return createErrorResponse(error.message, safeDetails);
    }
  };
}

/**
 * Variant of wrapHandler for gv_* tools. Differs in two ways:
 *   - Checks wpClient (not gravityFormsClient).
 *   - Surfaces the inspector REST envelope (`{ code, message, data }`)
 *     so the agent sees `gv_rest_invalid_template` etc. instead of a
 *     generic "Request failed with status code 400". The inspector's
 *     errors are designed for AI consumption — preserve them.
 *
 * Local fork: `ready` overrides the readiness gate. In the multi-site
 * deployment the WordPress client is per-site and owned by multisite.js, so
 * the process-global `wpClient` is legitimately null while an ability call is
 * perfectly runnable — see the abilities hook in CallTool.
 */
function wrapViewHandler(handler, params = {}, { ready = undefined } = {}) {
  return async () => {
    if (!(ready ?? !!wpClient)) {
      return createErrorResponse('GravityView client not initialized');
    }
    try {
      const result = await handler();
      const output = params.compact !== false ? stripEmpty(result) : result;
      return {
        content: [{ type: 'text', text: JSON.stringify(output) }],
      };
    } catch (error) {
      // Axios errors carry response.data — when the server speaks
      // the inspector REST envelope, that's the most useful payload.
      const restBody = error?.response?.data;
      const status = error?.response?.status;
      const message = restBody?.message || error.message;
      const details = restBody
        ? { status, code: restBody.code, data: restBody.data }
        : undefined;
      logger.error(`gv_* tool error: ${message}${status ? ` (HTTP ${status})` : ''}`);
      return createErrorResponse(message, details);
    }
  };
}

// =================================
// FORMS MANAGEMENT TOOLS (6)
// =================================

// Static Gravity Forms tool definitions (Plane A — works on any GF site,
// no Foundation required). These names are the released contract; the
// abilities loader treats them as reserved so a future catalog-served
// gk-gravity-forms ability can never shadow them.
const GF_TOOL_DEFINITIONS = [
  // Forms Management (6 tools)
  {
    name: 'gf_list_forms',
    description: 'List all forms with optional search and pagination.',
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        include: {
          type: 'array',
          items: { type: 'number' },
          description: 'Form IDs to include'
        },
        compact: { type: 'boolean', description: 'Return raw uncompacted data', default: true }
      }
    }
  },
  {
    name: 'gf_get_form',
    description: 'Get a form by ID with full field configuration.',
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Form ID' },
        compact: { type: 'boolean', description: 'Return raw uncompacted data', default: true }
      },
      required: ['id']
    }
  },
  {
    name: 'gf_create_form',
    description: 'Create a new form',
    annotations: { idempotentHint: false, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Form title' },
        description: { type: 'string', description: 'Form description' },
        fields: {
          type: 'array',
          description: 'Array of field objects',
          items: { type: 'object' }
        },
        button: { type: 'object', description: 'Submit button settings' },
        confirmations: { type: 'object', description: 'Confirmation settings' },
        notifications: { type: 'object', description: 'Notification settings' },
        is_active: { type: 'boolean', description: 'Form active state' },
        // MUST stay declared. An MCP client drops arguments absent from this
        // schema BEFORE the request reaches the server, so an undeclared key is
        // not "passed through loosely" — it is silently deleted, and the tool
        // returns 200 having done nothing. Verified 2026-08-21: identical calls
        // succeed over stdio and no-op through the connector.
        markupVersion: {
          type: 'number',
          enum: [1, 2],
          description: 'Form HTML structure. 2 = modern div-based (GF 2.5+ default). '
            + '1 = legacy ul/li markup, needed when an older stylesheet targets '
            + '"ul.gform_fields li.gfield". GF removed the wp-admin toggle for this '
            + 'in 2.10.x, so this parameter is the only remaining way to set it.'
        }
      },
      required: ['title']
    }
  },
  {
    name: 'gf_update_form',
    description: 'Update a form',
    annotations: { idempotentHint: false, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Form ID' },
        title: { type: 'string', description: 'Form title' },
        description: { type: 'string', description: 'Form description' },
        fields: {
          type: 'array',
          description: 'Array of field objects',
          items: { type: 'object' }
        },
        button: { type: 'object', description: 'Submit button settings' },
        confirmations: {
          type: 'object',
          description: 'WHOLE-MAP REPLACE — passing this REPLACES every confirmation '
            + 'on the form. Any entry you omit is DELETED. To change one and leave '
            + 'the rest alone, use gf_update_confirmation / gf_add_confirmation / '
            + 'gf_delete_confirmation instead. A write that would drop entries is '
            + 'refused unless replace_map:true.',
        },
        notifications: {
          type: 'object',
          description: 'WHOLE-MAP REPLACE — passing this REPLACES every notification '
            + 'on the form. Any entry you omit is DELETED, and several live forms '
            + 'carry two. Use gf_update_notification / gf_add_notification / '
            + 'gf_delete_notification instead. A write that would drop entries is '
            + 'refused unless replace_map:true.',
        },
        replace_map: {
          type: 'boolean',
          default: false,
          description: 'Confirms you INTEND a whole-map replace of confirmations or '
            + 'notifications, dropping entries you omitted. Only needed when the '
            + 'supplied map omits entries that currently exist — the normal case '
            + 'needs no flag. Removing an entry by omission is the legitimate use.',
        },
        is_active: { type: 'boolean', description: 'Form active state' },
        // See the note on gf_create_form.markupVersion — undeclared keys are
        // dropped by the client, not merely unvalidated by the server.
        markupVersion: {
          type: 'number',
          enum: [1, 2],
          description: 'Form HTML structure. 2 = modern div-based (GF 2.5+ default). '
            + '1 = legacy ul/li markup, needed when an older stylesheet targets '
            + '"ul.gform_fields li.gfield". Changing this alters the rendered HTML '
            + 'of a live form — check the stylesheet before flipping it.'
        }
      },
      required: ['id']
    }
  },
  {
    name: 'gf_delete_form',
    description: 'Delete a form. Defaults to Trash (recoverable) — proceed with the default; do NOT pause to ask the user trash-vs-permanent. Set force=true only if the user explicitly asks to permanently delete. (Requires ALLOW_DELETE=true.)',
    annotations: { destructiveHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Form ID' },
        force: { type: 'boolean', description: 'Permanently delete instead of moving to Trash. Default false (Trash, recoverable).' }
      },
      required: ['id']
    }
  },
  {
    name: 'gf_validate_form',
    description: 'Validate form input. Pass field values as top-level input_N keys (e.g. input_1, input_2; sub-inputs input_1_3). `field_values` is GF dynamic-population data, not the submitted values.',
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        form_id: { type: 'number', description: 'Form ID' },
        field_values: { type: ['string', 'array'], description: 'GF dynamic-population values — a query string ("p1=a&p2=b") or array. NOT submission values; pass those as input_N keys.' }
      },
      additionalProperties: true,
      required: ['form_id']
    }
  },

  // Entries Management (5 tools)
  {
    name: 'gf_list_entries',
    description: 'List/search entries with filtering, sorting, and pagination.',
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        form_ids: {
          type: 'array',
          items: { type: 'number' },
          description: 'Filter by form IDs'
        },
        include: {
          type: 'array',
          items: { type: 'number' },
          description: 'Entry IDs to include'
        },
        exclude: {
          type: 'array',
          items: { type: 'number' },
          description: 'Entry IDs to exclude'
        },
        status: {
          type: 'string',
          enum: ['active', 'spam', 'trash'],
          description: 'Entry status'
        },
        search: {
          type: 'object',
          properties: {
            field_filters: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  key: { type: 'string' },
                  value: { type: 'string' },
                  operator: {
                    type: 'string',
                    enum: ['=', 'IS', 'CONTAINS', 'IS NOT', 'ISNOT', '<>', 'LIKE', 'NOT IN', 'NOTIN', 'IN', '>', '<', '>=', '<=']
                  }
                }
              }
            },
            mode: {
              type: 'string',
              enum: ['any', 'all'],
              description: 'Search mode'
            }
          }
        },
        sorting: {
          type: 'object',
          properties: {
            key: { type: 'string' },
            direction: {
              type: 'string',
              enum: ['asc', 'desc', 'ASC', 'DESC']
            },
            is_numeric: { type: 'boolean', description: 'Sort key numerically' }
          }
        },
        paging: {
          type: 'object',
          properties: {
            page_size: { type: 'number' },
            current_page: { type: 'number' },
            offset: { type: 'integer', description: 'Entry offset' }
          }
        },
        compact: { type: 'boolean', description: 'Return raw uncompacted data', default: true }
      }
    }
  },
  {
    name: 'gf_get_entry',
    description: 'Get an entry by ID with field labels.',
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Entry ID' },
        compact: { type: 'boolean', description: 'Return raw uncompacted data', default: true }
      },
      required: ['id']
    }
  },
  {
    name: 'gf_create_entry',
    description: 'Create an entry. Checkbox/multiselect arrays auto-normalized.',
    annotations: { idempotentHint: false, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        form_id: { type: 'number', description: 'Form ID' },
        created_by: { type: 'number', description: 'Creator user ID' },
        status: {
          type: 'string',
          enum: ['active', 'spam', 'trash'],
          description: 'Entry status'
        },
        date_created: { type: 'string', description: 'ISO date' }
      },
      additionalProperties: true,
      required: ['form_id']
    }
  },
  {
    name: 'gf_update_entry',
    description: 'Update an entry. Pass field values in the `values` object. Checkbox/multiselect arrays auto-normalized; unmentioned fields preserved.',
    annotations: { idempotentHint: false, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Entry ID' },
        values: {
          type: 'object',
          additionalProperties: true,
          description: 'Field values keyed by field id ("1", "2") or sub-input ("1.3").\n'
            + 'USE THIS RATHER THAN loose top-level numeric keys. An MCP client strips '
            + 'arguments not declared in this schema before the request is sent, and '
            + 'additionalProperties:true does NOT protect them — verified 2026-08-21: '
            + 'the same call lands over stdio and arrives empty through a connector, '
            + 'which is why this tool returned a clean 200 over a no-op. Loose keys '
            + 'still work for direct/stdio callers.',
        },
        status: {
          type: 'string',
          enum: ['active', 'spam', 'trash'],
          description: 'Entry status'
        }
      },
      additionalProperties: true,
      required: ['id']
    }
  },
  {
    name: 'gf_delete_entry',
    description: 'Delete an entry. Defaults to Trash (recoverable) — proceed with the default; do NOT pause to ask the user trash-vs-permanent. Set force=true only if the user explicitly asks to permanently delete. (Requires ALLOW_DELETE=true.)',
    annotations: { destructiveHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Entry ID' },
        force: { type: 'boolean', description: 'Permanently delete instead of moving to Trash. Default false (Trash, recoverable).' }
      },
      required: ['id']
    }
  },

  // Form Submissions (2 tools)
  {
    name: 'gf_submit_form_data',
    description: 'Submit form data — runs the full pipeline (validation, notifications, confirmations, feeds/payment). Pass field values in the `values` object.',
    annotations: { idempotentHint: false, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        form_id: { type: 'number', description: 'Form ID' },
        values: {
          type: 'object',
          additionalProperties: true,
          description: 'Field values keyed by field id ("1", "2") or sub-input ("1.3"). '
            + 'Bare and input_-prefixed keys are both accepted and normalised.\n'
            + 'USE THIS RATHER THAN loose top-level input_N keys. An MCP client strips '
            + 'arguments not declared in this schema before the request is sent, and '
            + 'additionalProperties:true does NOT protect them — verified 2026-08-21: '
            + 'the same call lands over stdio and arrives empty through a connector, '
            + 'which is why submissions came back "This field is required" for every '
            + 'field. Loose keys still work for direct/stdio callers.',
        },
        field_values: { type: ['string', 'array'], description: 'GF dynamic-population values — a query string ("p1=a&p2=b") or array. NOT submission values; pass those in `values`.' }
      },
      additionalProperties: true,
      required: ['form_id']
    }
  },
  {
    name: 'gf_validate_submission',
    description: 'Validate submission without processing',
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        form_id: { type: 'number', description: 'Form ID' }
      },
      additionalProperties: true,
      required: ['form_id']
    }
  },

  // Notifications (1 tool)
  {
    name: 'gf_send_notifications',
    description: 'Send notifications for entry',
    annotations: { idempotentHint: false, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        entry_id: { type: 'number', description: 'Entry ID' },
        notification_ids: {
          type: 'array',
          items: { type: 'string', description: 'A non-empty notification id' },
          description: 'Notification IDs to send (omit to send all for the event)'
        },
        event: {
          type: 'string',
          description: 'Notification event (default: form_submission)'
        }
      },
      required: ['entry_id']
    }
  },

  // Add-on Feeds (7 tools)
  {
    name: 'gf_list_feeds',
    description: 'List feeds. Filter by form_id and/or addon slug.',
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        addon: { type: 'string', description: 'Addon slug' },
        form_id: { type: 'number', description: 'Form ID' },
        compact: { type: 'boolean', description: 'Return raw uncompacted data', default: true }
      }
    }
  },
  {
    name: 'gf_get_feed',
    description: 'Get a feed by ID.',
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Feed ID' },
        compact: { type: 'boolean', description: 'Return raw uncompacted data', default: true }
      },
      required: ['id']
    }
  },
  // gf_list_form_feeds removed — gf_list_feeds with form_id does the same thing
  // and also supports addon filtering. Kept listFormFeeds() client method for
  // backwards compatibility but no longer exposed as a tool.
  {
    name: 'gf_create_feed',
    description: 'Create a feed',
    annotations: { idempotentHint: false, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        addon_slug: { type: 'string', description: 'Add-on slug' },
        form_id: { type: 'number', description: 'Form ID' },
        is_active: { type: 'boolean', description: 'Feed active state' },
        meta: { type: 'object', description: 'Feed config' }
      },
      required: ['addon_slug', 'form_id', 'meta']
    }
  },
  {
    name: 'gf_update_feed',
    description: 'Update a feed (full replace)',
    annotations: { idempotentHint: false, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Feed ID' },
        is_active: { type: 'boolean', description: 'Feed active state' },
        meta: { type: 'object', description: 'Feed config' }
      },
      required: ['id']
    }
  },
  {
    name: 'gf_patch_feed',
    description: 'Patch a feed (partial update)',
    annotations: { idempotentHint: false, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Feed ID' },
        is_active: { type: 'boolean', description: 'Feed active state' },
        meta: { type: 'object', description: 'Feed config' }
      },
      required: ['id']
    }
  },
  {
    name: 'gf_delete_feed',
    description: 'Delete a feed (requires ALLOW_DELETE=true)',
    annotations: { destructiveHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Feed ID' }
      },
      required: ['id']
    }
  },

  // Field Filters (1 tool)
  {
    name: 'gf_get_field_filters',
    description: 'Get field filters for form',
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        form_id: { type: 'number', description: 'Form ID' }
      },
      required: ['form_id']
    }
  },

  // Results (1 tool)
  {
    name: 'gf_get_results',
    description: 'Get quiz/poll/survey results',
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        form_id: { type: 'number', description: 'Form ID' }
      },
      required: ['form_id']
    }
  },
];

// Tool names the dynamic abilities pipeline must never claim.
const RESERVED_TOOL_NAMES = new Set([
  ...GF_TOOL_DEFINITIONS.map((tool) => tool.name),
  ...fieldOperationTools.map((tool) => tool.name),
  ...confirmationOperationTools.map((tool) => tool.name),
  'gk_reload_abilities',
]);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  // Local fork: start the per-site abilities catalog fetch FIRST, without
  // awaiting, so it overlaps the Gravity Forms seed probe below instead of
  // queueing behind it. Both are bounded; awaited together at the end. Exactly
  // ONE site is contacted for abilities (the advertised one) — never a fan-out
  // across the whole sites file.
  const multisiteAbilityDefsPromise = multisiteActive()
    ? abilitiesDefinitionsForList(ABILITIES_DEPS, { timeoutMs: resolveAbilitiesListTimeoutMs() })
    : null;
  // Local fork: seed the GF plane from the default site so gf_* tools are
  // advertised (there is no GRAVITY_FORMS_* env for upstream's probe to use).
  if (multisiteActive() && !gravityFormsClient) {
    try { await pointGravityPlaneAtSite(DEFAULT_SITE); }
    catch (e) { logger.warn(`multi-site GF seed failed for '${DEFAULT_SITE}': ${e.message}`); }
  }
  // ListTools is the FIRST request Claude fires after the MCP
  // handshake, so we lazily initialise here too — otherwise the
  // tool list goes out before initializeClient() has had a chance
  // to construct the GravityView client + start the abilities load.
  if (!gravityFormsClient || !wpClient) {
    try { await initializeClient(); } catch (_) { /* serve whatever planes are up */ }
  }
  // Best-effort wait for the abilities catalog. The default 2s covers a warm
  // cold-start (~800ms) plus headroom; if WP is genuinely unreachable the list
  // ships without gv_* tools and the next gv_* call (or gk_reload_abilities)
  // retries. Clients that read tools/list only once (no list_changed support,
  // e.g. `claude -p`) can raise GRAVITYKIT_MCP_LIST_TIMEOUT_MS so this first
  // list blocks long enough to return the complete catalog.
  // Local fork: in the sites-file deployment the catalog is per-site, so the
  // advertised ability tools come from multisite.js (one site, same time
  // budget, already in flight since the top of this handler). Upstream's
  // process-wide loader is a no-op there — it returns immediately because
  // there is no env-configured wpClient.
  const multisiteAbilityDefs = multisiteAbilityDefsPromise ? await multisiteAbilityDefsPromise : null;
  await ensureAbilitiesLoaded({ timeoutMs: resolveAbilitiesListTimeoutMs() });

  // Gravity Forms tools are advertised only when that plane is live, so a
  // WP-only install never lists gf_* tools that can't run. gk_reload_abilities
  // is always present (the manual escape hatch after fixing a WP/cert issue);
  // ability tools appear once the background catalog load succeeds.
  const gkReloadDef = {
    name: 'gk_reload_abilities',
    description: 'Force a re-fetch of the WordPress Abilities API catalog and refresh the GravityKit product tool list. Use after fixing a WP / network / cert issue that prevented the eager background load from succeeding at MCP startup.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  };
  const toolList = buildToolList({
    gfReady: !!gravityFormsClient,
    gfToolDefs: GF_TOOL_DEFINITIONS,
    // Confirmation/notification tools ride the same gate as the field tools:
    // both need a working Gravity Forms plane and nothing else.
    fieldOpTools: [...fieldOperationTools, ...confirmationOperationTools],
    abilityDefs: multisiteAbilityDefs ?? abilityToolDefinitions,
    gkReloadDef,
  });
  // Local fork: expose the `site` param on every tool when multi-site is active
  // (gf_* selects a Gravity Forms client, gv_* and gk_* an abilities catalog).
  return { tools: multisiteActive() ? toolList.map(withSite) : toolList };
});

// =================================
// TOOL HANDLERS
// =================================

// Forms Management Handlers
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: params } = request.params;

  // Local fork: capture the caller's target site, point the GF plane at it
  // (hot-reloads the sites config each call), then drop the `site` arg so it
  // never reaches a Gravity Forms request or an ability input payload. gf_*
  // tools resolve the caller's site here; gv_* / gk_reload_abilities carry
  // `requestedSite` down to the abilities hooks in the default branch below.
  let requestedSite;
  if (multisiteActive()) {
    requestedSite = params && params.site;
    if (toolTakesSite(name)) {
      try { await pointGravityPlaneAtSite(requestedSite); }
      catch (e) { return createErrorResponse(e.message); }
    } else if (!gravityFormsClient) {
      try { await pointGravityPlaneAtSite(DEFAULT_SITE); } catch (_) { /* non-gf tool: GF plane optional */ }
    }
    if (params && 'site' in params) delete params.site;
  }

  // Ensure capability planes are initialized. Per-plane failures
  // surface as per-tool error responses below; throw only when
  // neither plane has usable credentials.
  if (!gravityFormsClient || !wpClient) {
    await initializeClient();
  }

  // Route to appropriate handler
  // The client already validates internally, just pass params directly
  switch (name) {
    // Forms Management
    case 'gf_list_forms':
      return wrapHandler(() => gravityFormsClient.listForms(params), params)();
    case 'gf_get_form':
      return wrapHandler(() => gravityFormsClient.getForm(params), params)();
    case 'gf_create_form':
      return wrapHandler(() => gravityFormsClient.createForm(params), params)();
    case 'gf_update_form':
      return wrapHandler(() => gravityFormsClient.updateForm(params), params)();
    case 'gf_delete_form':
      return wrapHandler(() => gravityFormsClient.deleteForm(params), params)();
    case 'gf_validate_form':
      return wrapHandler(() => gravityFormsClient.validateForm(params), params)();

    // Confirmations & notifications — per-entry, read-modify-write.
    //
    // These take the raw GF client rather than fieldOperations: they patch one
    // key of the form's confirmations/notifications map and PUT the whole form
    // back, which needs getForm + replaceForm and nothing from the field layer.
    case 'gf_list_confirmations':
    case 'gf_update_confirmation':
    case 'gf_add_confirmation':
    case 'gf_delete_confirmation':
    case 'gf_list_notifications':
    case 'gf_update_notification':
    case 'gf_add_notification':
    case 'gf_delete_notification':
      if (!gravityFormsClient) {
        return createErrorResponse(`Gravity Forms client unavailable for ${name}`);
      }
      return wrapHandler(
        () => confirmationOperationHandlers[name](params, gravityFormsClient),
        params,
      )();

    // Entries Management
    case 'gf_list_entries':
      return wrapHandler(async () => {
        const result = await gravityFormsClient.listEntries(params);
        return params.compact !== false ? stripEntryMetaFromResponse(result) : result;
      }, params)();
    case 'gf_get_entry':
      return wrapHandler(async () => {
        const result = await gravityFormsClient.getEntry(params);
        return params.compact !== false ? stripEntryMetaFromResponse(result) : result;
      }, params)();
    case 'gf_create_entry':
      return wrapHandler(async () => {
        const result = await gravityFormsClient.createEntry(params);
        return params.compact !== false ? stripEntryMetaFromResponse(result) : result;
      }, params)();
    case 'gf_update_entry':
      return wrapHandler(async () => {
        const result = await gravityFormsClient.updateEntry(params);
        return params.compact !== false ? stripEntryMetaFromResponse(result) : result;
      }, params)();
    case 'gf_delete_entry':
      return wrapHandler(() => gravityFormsClient.deleteEntry(params), params)();

    // Form Submissions
    case 'gf_submit_form_data':
      return wrapHandler(() => gravityFormsClient.submitFormData(params), params)();
    case 'gf_validate_submission':
      return wrapHandler(() => gravityFormsClient.validateSubmission(params), params)();

    // Notifications
    case 'gf_send_notifications':
      return wrapHandler(() => gravityFormsClient.sendNotifications(params), params)();

    // Add-on Feeds
    case 'gf_list_feeds':
      return wrapHandler(() => gravityFormsClient.listFeeds(params), params)();
    case 'gf_get_feed':
      return wrapHandler(() => gravityFormsClient.getFeed(params), params)();
    case 'gf_create_feed':
      return wrapHandler(() => gravityFormsClient.createFeed(params), params)();
    case 'gf_update_feed':
      return wrapHandler(() => gravityFormsClient.updateFeed(params), params)();
    case 'gf_patch_feed':
      return wrapHandler(() => gravityFormsClient.patchFeed(params), params)();
    case 'gf_delete_feed':
      return wrapHandler(() => gravityFormsClient.deleteFeed(params), params)();

    // Utilities
    case 'gf_get_field_filters':
      return wrapHandler(() => gravityFormsClient.getFieldFilters(params), params)();
    case 'gf_get_results':
      return wrapHandler(() => gravityFormsClient.getResults(params), params)();

    // Field Operations - Intelligent field management
    case 'gf_add_field':
      return wrapHandler(async () => {
        if (!fieldOperations) {
          throw new Error('Field operations not initialized');
        }
        return await fieldOperationHandlers.gf_add_field(params, fieldOperations);
      }, params)();
    case 'gf_update_field':
      return wrapHandler(async () => {
        if (!fieldOperations) {
          throw new Error('Field operations not initialized');
        }
        return await fieldOperationHandlers.gf_update_field(params, fieldOperations);
      }, params)();
    case 'gf_delete_field':
      return wrapHandler(async () => {
        if (!fieldOperations) {
          throw new Error('Field operations not initialized');
        }
        return await fieldOperationHandlers.gf_delete_field(params, fieldOperations);
      }, params)();
    case 'gf_set_choice_text':
      return wrapHandler(async () => {
        if (!fieldOperations) {
          throw new Error('Field operations not initialized');
        }
        return await fieldOperationHandlers.gf_set_choice_text(params, fieldOperations);
      }, params)();
    case 'gf_list_field_types':
      return wrapHandler(async () => {
        if (!fieldOperations) {
          throw new Error('Field operations not initialized');
        }
        return await fieldOperationHandlers.gf_list_field_types(params, fieldOperations);
      }, params)();

    // GravityView Inspector — every gv_* tool routes through the
    // abilities-derived handler map. Single dispatch keeps the switch
    // readable; the map is rebuilt whenever the abilities catalog is
    // (re)fetched.
    default:
      if (name === 'gk_reload_abilities') {
        // Local fork: per-site catalog. Refresh the requested site (default:
        // the advertised one) and make it the site tools/list reflects.
        if (multisiteActive()) {
          const summary = await reloadAbilitiesForSite(requestedSite, ABILITIES_DEPS);
          return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }] };
        }
        if (!wpClient) {
          return createErrorResponse(
            'WordPress client not initialized. Set GRAVITYKIT_WP_URL + GRAVITYKIT_WP_USERNAME + GRAVITYKIT_WP_APP_PASSWORD in .env (or reuse the GRAVITY_FORMS_* credentials).'
          );
        }
        const before = abilityToolDefinitions?.length ?? 0;
        await ensureAbilitiesLoaded({ force: true });
        const after = abilityToolDefinitions?.length ?? 0;
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              loaded: !!abilityToolDefinitions,
              ability_tool_count: after,
              previous_count: before,
              note: abilityToolDefinitions
                ? 'Catalog refreshed. Clients receive `notifications/tools/list_changed` automatically.'
                : 'Catalog still unreachable — check WP logs / cert / credentials. Will retry on next gv_* tool call.',
            }, null, 2),
          }],
        };
      }
      // Dotted silo setting paths (datatables.save_state) are advertised by the
      // catalog but do NOT persist — WordPress sanitize_key() eats the dot and
      // invents a top-level key nothing reads, while still returning 200. Only
      // the nested form reaches the silo meta key. Convert here so the
      // documented spelling behaves as documented. See gravityview/silo-settings.js.
      {
        const normalized = normalizeSiloSettings(name, params);
        if (normalized.converted.length) {
          // Mutate in place rather than rebind: `params` is const here, and the
          // surrounding code already mutates it (delete params.site).
          params.template_settings = normalized.params.template_settings;
          logger.info(
            `[silo-settings] routed ${normalized.converted.length} dotted setting(s) to nested form: `
            + normalized.converted.map((c) => c.from).join(', '));
        }
      }

      // Local fork: route ability calls through the caller's site catalog.
      // Failures come back as a specific, actionable message ("GravityView is
      // not active on 'x'", "no WordPress credentials for 'x' — add them to
      // <file>") rather than a bare 404 or silence.
      if (multisiteActive()) {
        const routed = await resolveAbilityCall(name, requestedSite, ABILITIES_DEPS);
        // `ready: true` — multisite.js already proved this site's WP client and
        // catalog are live; the process-global wpClient is unused here.
        if (routed.status === 'dispatch') return wrapViewHandler(() => routed.handler(params), params, { ready: true })();
        if (routed.status === 'error') return createErrorResponse(routed.message);
        return createErrorResponse(`Unknown tool: ${name}`);
      }
      // Any other name is a dynamic GravityKit ability tool (any product
      // prefix — gv_, gc_, …) or genuinely unknown. Self-heal the catalog
      // when the WP plane is up, then route by handler-map membership so
      // every product's tools dispatch, not just GravityView's.
      if (wpClient) {
        await ensureAbilitiesLoaded();
      }
      switch (classifyAbilityCall({ name, hasWpClient: !!wpClient, handlers: abilityToolHandlers })) {
        case 'dispatch':
          return wrapViewHandler(() => abilityToolHandlers[name](params), params)();
        case 'no-wp-client':
          return createErrorResponse(
            'WordPress client not initialized. Set GRAVITYKIT_WP_URL + GRAVITYKIT_WP_USERNAME + GRAVITYKIT_WP_APP_PASSWORD in .env (or reuse GRAVITY_FORMS_BASE_URL / GRAVITY_FORMS_CONSUMER_KEY / GRAVITY_FORMS_CONSUMER_SECRET when the same WP install hosts both surfaces).'
          );
        case 'catalog-unreachable':
          return createErrorResponse(
            'GravityKit abilities catalog unreachable — no product tools are available. Fix WP connectivity / credentials, then call gk_reload_abilities to refresh.'
          );
        default:
          return createErrorResponse(`Unknown tool: ${name}`);
      }
  }
});

// =================================
// SERVER INITIALIZATION
// =================================

async function main() {
  try {
    // Create stdio transport — client initialization is deferred to first tool call
    // so the MCP handshake completes instantly (live site validation can take 3+ seconds)
    const transport = new StdioServerTransport();

    // Connect server to transport
    await server.connect(transport);

    logger.info('🚀 GravityKit MCP running on stdio');
  } catch (error) {
    logger.error(`Failed to start server: ${error}`);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
  logger.info('👋 Shutting down GravityKit MCP...');
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.info('👋 Shutting down GravityKit MCP...');
  process.exit(0);
});

// Start the server
main().catch((error) => {
  logger.error(`Fatal error: ${error}`);
  process.exit(1);
});