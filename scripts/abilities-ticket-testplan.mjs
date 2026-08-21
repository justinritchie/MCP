#!/usr/bin/env node
/**
 * Runs the test plan from TICKET-gravitykit-mcp-gravityview-abilities.md verbatim.
 *
 * That ticket asks for the abilities/GravityView layer to be wired per-site.
 * The work appears to have landed earlier today (per-site abilities plane in
 * multisite.js), and the sibling bug ticket written afterwards says gv_* tools
 * "all worked" — but a ticket is not closed because someone remembers closing
 * it. This executes its five checks against the live sites.
 *
 * Read-only throughout: list and reload only, no View is created or modified.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = resolve(HERE, '../src/index.js');

const client = new Client({ name: 'abilities-testplan', version: '1.0.0' }, { capabilities: {} });
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  const t = r?.content?.[0]?.text ?? '';
  let parsed; try { parsed = JSON.parse(t); } catch { parsed = t; }
  return { isError: r?.isError === true, parsed, text: t };
};

let pass = 0, fail = 0;
const check = (n, ok, d = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? `  — ${d}` : ''}`);
  ok ? pass++ : fail++;
};

await client.connect(new StdioClientTransport({ command: process.execPath, args: [ENTRY] }));

// --- 1 & 3. catalog loads per site, gv_* tools appear ----------------------
for (const site of ['aarlocal', 'aaru65']) {
  const rel = await call('gk_reload_abilities', { site });
  check(`gk_reload_abilities(site="${site}") loads a catalog`,
        !rel.isError, rel.text.slice(0, 110));

  const tools = (await client.listTools()).tools.map(t => t.name);
  const gv = tools.filter(t => t.startsWith('gv_'));
  check(`gv_* tools materialise for ${site}`, gv.length > 0, `${gv.length} gv_* tools`);

  // --- 2. views_list works per site --------------------------------------
  //
  // Asserts the CALL succeeds, not that Views exist. aar-local currently has
  // zero Views — confirmed independently against the database, not inferred
  // from this tool — because that deliverable has not been built yet. An
  // earlier version of this check required a non-empty list and reported the
  // unbuilt deliverable as a tool failure.
  const views = await call('gv_views_list', { site });
  const list = views.parsed?.views ?? views.parsed?.data ?? views.parsed;
  const arr = Array.isArray(list) ? list : Object.values(list ?? {});
  check(`gv_views_list(site="${site}") succeeds`,
        !views.isError,
        `${arr.length} view(s)${arr.length ? ': ' + arr.slice(0, 4).map(v => String(v.title ?? v.post_title ?? v.id).slice(0, 30)).join(', ') : ' (none built on this site yet)'}`);
}

// --- 4. NEGATIVE: a site without GravityView must say so, not 404 ---------
const bob = await call('gv_views_list', { site: 'bestofblue' });
const msg = bob.text || '';
const named = /GravityView/i.test(msg) || /not active/i.test(msg) || /no .*catalog/i.test(msg);
check('bestofblue (no GravityView) fails with a NAMED reason, not a bare 404',
      bob.isError && named && !/^\s*404\s*$/.test(msg.trim()),
      msg.slice(0, 140));

// --- 5. regression: gf_* unaffected across sites --------------------------
for (const site of ['aarlocal', 'aaru65', 'bestofblue']) {
  const forms = await call('gf_list_forms', { site });
  const f = forms.parsed?.forms ?? forms.parsed;
  const n = Array.isArray(f) ? f.length : Object.keys(f ?? {}).length;
  check(`gf_list_forms still works on ${site}`, !forms.isError && n > 0, `${n} form(s)`);
}

// --- coverage question the ticket asks to answer -------------------------
const layouts = await call('gv_layouts_list', { site: 'aaru65' });
const lay = layouts.parsed?.layouts ?? layouts.parsed;
const names = (Array.isArray(lay) ? lay : Object.values(lay ?? {}))
  .map(l => l.id ?? l.slug ?? l.template_id ?? l.label).filter(Boolean);
console.log(`\ncoverage — layouts advertised on aaru65: ${JSON.stringify(names)}`);
console.log(`  DataTables present: ${names.some(n => /datatable/i.test(String(n))) ? 'YES' : 'NO'}`);

console.log(`\n${pass} passed, ${fail} failed`);
await client.close();
process.exit(fail ? 1 : 0);
