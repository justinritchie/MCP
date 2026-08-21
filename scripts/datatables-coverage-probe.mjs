#!/usr/bin/env node
/**
 * Coverage probe — does the GravityKit Abilities catalog expose the DataTables
 * layout, or only the core Table layout?
 *
 * WHY THIS EXISTS
 *   The AAR waitlist View is specced as DataTables with CSV/Excel export
 *   buttons. gv_* tools are generated from whatever the site's Abilities API
 *   advertises, so if DataTables settings are not in the catalog the View has
 *   to be hand-built and the MCP path waits for Live Well & Learn. That is a
 *   go/no-go answer, and it is cheaper to ask the catalog than to discover it
 *   halfway through building.
 *
 * STRICTLY READ-ONLY. Allow-list enforced below: this script cannot call a
 * tool that creates or modifies anything, even by mistake.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = resolve(HERE, '../src/index.js');
const SITE = 'aarlocal';

// Read-only allow-list. Anything not here is refused before it reaches the wire.
const ALLOWED = new Set([
  'gk_reload_abilities',
  'gv_views_list',
  'gv_layouts_list',
  'gv_widgets_list',
  'gv_field_type_schema_get',
  'gv_available_fields_get',
  'gv_view_config_get',
]);

const client = new Client({ name: 'datatables-coverage-probe', version: '1.0.0' },
                          { capabilities: {} });

async function call(name, args = {}) {
  if (!ALLOWED.has(name)) throw new Error(`refused non-read tool: ${name}`);
  const r = await client.callTool({ name, arguments: args });
  const text = r?.content?.[0]?.text ?? '';
  try { return JSON.parse(text); } catch { return text; }
}

const t0 = Date.now();
await client.connect(new StdioClientTransport({ command: process.execPath, args: [ENTRY] }));

console.log('=== load abilities for', SITE, '===');
const reload = await call('gk_reload_abilities', { site: SITE });
console.log('  ', JSON.stringify(reload).slice(0, 200));

const tools = (await client.listTools()).tools;
const gv = tools.filter(t => t.name.startsWith('gv_')).map(t => t.name);
console.log(`\n=== gv_* tools: ${gv.length} ===`);

// 1. Is there a layouts tool at all, and does it name DataTables?
console.log('\n=== layouts advertised by the catalog ===');
if (gv.includes('gv_layouts_list')) {
  const layouts = await call('gv_layouts_list', { site: SITE });
  console.log('  ', JSON.stringify((layouts.layouts||layouts).map ? (layouts.layouts||layouts).map(l=>({id:l.id,label:l.label})) : layouts, null, 1));
} else {
  console.log('   gv_layouts_list NOT PRESENT');
}

// 2. Does any tool schema mention datatables / export? The catalog is generated,
//    so the honest signal is what the schemas actually enumerate — not whether a
//    tool name sounds right.
console.log('\n=== schema-level mentions across all gv_* tools ===');
const NEEDLES = ['datatable', 'export', 'csv', 'excel', 'tsv', 'print', 'buttons'];
const hits = {};
for (const t of tools.filter(x => x.name.startsWith('gv_'))) {
  const blob = JSON.stringify({ d: t.description, s: t.inputSchema }).toLowerCase();
  for (const n of NEEDLES) if (blob.includes(n)) (hits[n] ||= []).push(t.name);
}
for (const n of NEEDLES) {
  const h = hits[n];
  console.log(`   ${n.padEnd(10)} ${h ? h.slice(0, 4).join(', ') + (h.length > 4 ? ` (+${h.length - 4})` : '') : '— not mentioned'}`);
}

// 3. If a template/layout enum exists anywhere, print it verbatim. This is the
//    decisive artifact: an enum that lists only the core table layout is a no.
console.log('\n=== any enum naming a template/layout ===');
for (const t of tools.filter(x => x.name.startsWith('gv_'))) {
  const props = t.inputSchema?.properties ?? {};
  for (const [k, v] of Object.entries(props)) {
    if (/template|layout|type/i.test(k) && Array.isArray(v?.enum)) {
      console.log(`   ${t.name}.${k}: ${JSON.stringify(v.enum)}`);
    }
  }
}

console.log(`\ndone in ${((Date.now() - t0) / 1000).toFixed(1)}s — nothing was written`);
await client.close();
