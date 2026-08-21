#!/usr/bin/env node
/**
 * Live smoke test for the multi-site abilities plane, driven through a REAL
 * MCP client over stdio (not the Claude Desktop tool surface, which sits
 * behind a schema-flattening proxy).
 *
 * STRICTLY READ-ONLY. Every call is a list / catalog operation. It never
 * creates, modifies or deletes a View, form, entry, feed or post, and it
 * never touches Gravity Forms entries.
 *
 *   node scripts/multisite-abilities-smoke.mjs
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dirname, '..', 'src', 'index.js');

const READ_ONLY_TOOLS = new Set(['gv_views_list', 'gf_list_forms', 'gk_reload_abilities']);

let pass = 0;
let fail = 0;
const timings = [];

function ok(label, detail = '') { pass++; console.log(`  ✅ ${label}${detail ? ' — ' + detail : ''}`); }
function bad(label, detail = '') { fail++; console.log(`  ❌ ${label}${detail ? ' — ' + detail : ''}`); }

async function timed(label, fn) {
  const t0 = Date.now();
  const out = await fn();
  const ms = Date.now() - t0;
  timings.push([label, ms]);
  return { out, ms };
}

function text(res) {
  return (res?.content || []).map((c) => c.text || '').join('\n');
}

async function call(client, name, args) {
  if (!READ_ONLY_TOOLS.has(name)) throw new Error(`refusing to call non-read-only tool ${name}`);
  try {
    return await client.callTool({ name, arguments: args });
  } catch (e) {
    return { content: [{ type: 'text', text: `THREW: ${e.message}` }], isError: true };
  }
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [SERVER],
  // Deliberately no GRAVITY_FORMS_* / GRAVITYKIT_WP_* — mirrors the deployed
  // config, where every credential comes from the sites file.
  env: { PATH: process.env.PATH, HOME: process.env.HOME },
  stderr: 'pipe',
});
const client = new Client({ name: 'multisite-abilities-smoke', version: '1.0.0' }, { capabilities: {} });

const serverLog = [];
transport.stderr?.on('data', (d) => serverLog.push(d.toString()));

const { ms: connectMs } = await timed('connect (handshake)', () => client.connect(transport));
console.log(`\nconnected in ${connectMs}ms\n`);

// ---------------------------------------------------------------- tools/list
console.log('── tools/list (cold) ────────────────────────────────────────');
const { out: list1, ms: listMs } = await timed('tools/list (cold, includes catalog fetch)', () => client.listTools());
const names1 = list1.tools.map((t) => t.name);
const gf1 = names1.filter((n) => n.startsWith('gf_'));
const gv1 = names1.filter((n) => n.startsWith('gv_'));
console.log(`  ${listMs}ms — ${names1.length} tools: ${gf1.length} gf_*, ${gv1.length} gv_*, gk_reload_abilities=${names1.includes('gk_reload_abilities')}`);
const missingSite = list1.tools.filter((t) => !t.inputSchema?.properties?.site).map((t) => t.name);
if (missingSite.length === 0) ok('every advertised tool carries a `site` param');
else bad('tools missing a `site` param', missingSite.slice(0, 8).join(', '));

// ------------------------------------------------------------------- TEST 1
console.log('\n── TEST 1: gk_reload_abilities(site="aarlocal") ─────────────');
const { out: r1, ms: r1ms } = await timed('gk_reload_abilities aarlocal', () => call(client, 'gk_reload_abilities', { site: 'aarlocal' }));
const t1 = text(r1);
console.log(`  ${r1ms}ms  ${t1.slice(0, 420)}`);
let j1 = {};
try { j1 = JSON.parse(t1); } catch { /* not JSON */ }
if (j1.loaded === true && j1.site === 'aarlocal' && j1.ability_tool_count > 0) ok(`catalog loaded: ${j1.ability_tool_count} tools from ${j1.source}`);
else bad('catalog did not load for aarlocal');

const list2 = await client.listTools();
const gv2 = list2.tools.map((t) => t.name).filter((n) => n.startsWith('gv_'));
if (gv2.length > 0) ok(`gv_* tools now advertised in tools/list (${gv2.length})`);
else bad('no gv_* tools in tools/list after reload');

// ------------------------------------------------------------------- TEST 2
console.log('\n── TEST 2: gv_views_list(site="aarlocal") ───────────────────');
const { out: r2, ms: r2ms } = await timed('gv_views_list aarlocal', () => call(client, 'gv_views_list', { site: 'aarlocal' }));
const t2 = text(r2);
console.log(`  ${r2ms}ms  ${t2.slice(0, 500)}`);
if (!r2.isError && !/^Error:/.test(t2)) ok('gv_views_list succeeded on aarlocal');
else bad('gv_views_list failed on aarlocal', t2.slice(0, 200));

// ------------------------------------------------------------------- TEST 3
console.log('\n── TEST 3: same for aaru65 ──────────────────────────────────');
const { out: r3a, ms: r3ams } = await timed('gk_reload_abilities aaru65', () => call(client, 'gk_reload_abilities', { site: 'aaru65' }));
const t3a = text(r3a);
console.log(`  reload ${r3ams}ms  ${t3a.slice(0, 600)}`);
const { out: r3b, ms: r3bms } = await timed('gv_views_list aaru65', () => call(client, 'gv_views_list', { site: 'aaru65' }));
const t3b = text(r3b);
console.log(`  views  ${r3bms}ms  ${t3b.slice(0, 600)}`);
if (/GravityView is not active on 'aaru65'/.test(t3b)) ok('aaru65 reports GravityView-not-active (loud, specific, names the site)');
else if (!r3b.isError && !/^Error:/.test(t3b)) ok('gv_views_list succeeded on aaru65');
else bad('aaru65 produced an unexpected failure', t3b.slice(0, 300));
if (/404|rest_no_route/.test(t3b)) bad('aaru65 leaked a bare 404 / rest_no_route to the caller');
else ok('no bare 404 / rest_no_route leaked for aaru65');

// ------------------------------------------------------------------- TEST 4
console.log('\n── TEST 4 (negative): gv_views_list(site="bestofblue") ──────');
const { out: r4, ms: r4ms } = await timed('gv_views_list bestofblue', () => call(client, 'gv_views_list', { site: 'bestofblue' }));
const t4 = text(r4);
console.log(`  ${r4ms}ms  ${t4.slice(0, 700)}`);
if (/404|rest_no_route/.test(t4)) bad('bestofblue leaked a bare 404 / rest_no_route');
else if (/No WordPress credentials configured for GravityKit site 'bestofblue'/.test(t4) && /gravitykit-sites\.json/.test(t4)) ok('bestofblue: distinct no-WP-credentials error that names the file to edit');
else if (/GravityView is not active on 'bestofblue'/.test(t4)) ok('bestofblue: GravityView-not-active error');
else bad('bestofblue error was neither of the two expected messages', t4.slice(0, 300));

// ------------------------------------------------------------------- TEST 5
console.log('\n── TEST 5 (REGRESSION): gf_* across multiple sites ──────────');
// Only sites that actually carry GF key/secret in the sites file. As of
// 2026-08 opusadvisors / lcatt / uchicago / jumbo-live have EMPTY key+secret
// there — a pre-existing data gap, asserted separately below.
for (const site of ['cbrcsummit', 'aarlocal', 'aaru65', 'bestofblue']) {
  const { out, ms } = await timed(`gf_list_forms ${site}`, () => call(client, 'gf_list_forms', { site }));
  const t = text(out);
  let n = null;
  try {
    const parsed = JSON.parse(t);
    const forms = parsed?.data ?? parsed;
    n = Array.isArray(forms) ? forms.length : Object.keys(forms || {}).length;
  } catch { /* not JSON */ }
  if (!out.isError && n !== null && n >= 0) ok(`gf_list_forms(site="${site}") → ${n} forms`, `${ms}ms`);
  else bad(`gf_list_forms(site="${site}") failed`, t.slice(0, 200));
}
// Routing check: two sites must not return the same form set by accident.
const a = text(await call(client, 'gf_list_forms', { site: 'cbrcsummit' }));
const b = text(await call(client, 'gf_list_forms', { site: 'aarlocal' }));
if (a !== b) ok('`site` genuinely routes — cbrcsummit and aarlocal return different form sets');
else bad('cbrcsummit and aarlocal returned identical payloads — site routing may be broken');
// Default (no site) must still work.
const dflt = text(await call(client, 'gf_list_forms', {}));
if (!/^Error:/.test(dflt)) ok('gf_list_forms with no `site` still resolves the default site');
else bad('gf_list_forms with no `site` broke', dflt.slice(0, 200));
// Pre-existing data gap: a site listed with empty GF key/secret must still
// produce the actionable message it always did (unchanged by this work).
const noKeys = text(await call(client, 'gf_list_forms', { site: 'uchicago' }));
if (/Unknown or incomplete GravityKit site 'uchicago'/.test(noKeys)) ok("uchicago (empty GF key/secret in the sites file) still returns the actionable 'incomplete site' message");
else bad('uchicago behaved unexpectedly', noKeys.slice(0, 200));

// ------------------------------------------------------------------- timings
console.log('\n── timings ─────────────────────────────────────────────────');
for (const [l, ms] of timings) console.log(`  ${String(ms).padStart(6)}ms  ${l}`);

console.log(`\n═══ ${pass} passed, ${fail} failed ═══`);
if (serverLog.length) {
  console.log('\n── server stderr ───────────────────────────────────────────');
  console.log(serverLog.join('').split('\n').filter(Boolean).slice(-25).join('\n'));
}

await client.close();
process.exit(fail === 0 ? 0 : 1);
