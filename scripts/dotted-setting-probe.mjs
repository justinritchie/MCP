#!/usr/bin/env node
/**
 * Which write form actually routes a namespaced (silo) View setting?
 *
 * TICKET item #1 says dotted paths have the dot STRIPPED and a junk top-level
 * key invented, that nested objects also fail, and that only the underscore
 * form works.
 *
 * Reading the raw meta on View 4839 first showed something the ticket did not:
 * DataTables settings do NOT live in _gravityview_template_settings at all.
 * They live in a SEPARATE silo meta key, _gravityview_datatables_settings, and
 * that silo is currently clean and correct — none of the reported junk keys
 * exist in the database. So the premise needs re-testing rather than fixing.
 *
 * Writes one inert setting three ways and reads the silo back after each.
 * `scrolly` is chosen deliberately: scroller is "0", so this value changes
 * nothing a visitor sees. Restored at the end.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = resolve(HERE, '../src/index.js');
const SITE = 'aaru65';
const VIEW = 4839;
const ORIGINAL = '500';

const client = new Client({ name: 'dotted-probe', version: '1.0.0' }, { capabilities: {} });
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  const t = r?.content?.[0]?.text ?? '';
  let parsed; try { parsed = JSON.parse(t); } catch { parsed = t; }
  return { isError: r?.isError === true, parsed, text: t };
};

await client.connect(new StdioClientTransport({ command: process.execPath, args: [ENTRY] }));

/** Read the silo + look for junk, straight from the config tree. */
async function readState() {
  const c = await call('gv_view_config_get', { site: SITE, id: VIEW, include: ['template_settings'] });
  const ts = c.parsed?.template_settings ?? {};
  const silo = ts.datatables ?? {};
  const junk = Object.keys(ts).filter(k => /^datatables[^_]/.test(k) && k !== 'datatables');
  return { scrolly: silo.scrolly, junk, topLevelUnderscore: ts.datatables_scrolly };
}

const forms = [
  ['dotted      "datatables.scrolly"', { 'datatables.scrolly': '501' }, '501'],
  ['underscore  "datatables_scrolly"', { datatables_scrolly: '502' }, '502'],
  ['nested      {datatables:{...}}  ', { datatables: { scrolly: '503' } }, '503'],
];

console.log(`\nView ${VIEW} on ${SITE} — silo key _gravityview_datatables_settings`);
const start = await readState();
console.log(`baseline: scrolly=${JSON.stringify(start.scrolly)}  junk=${JSON.stringify(start.junk)}\n`);

for (const [label, payload, expect] of forms) {
  const r = await call('gv_view_settings_patch', { site: SITE, id: VIEW, template_settings: payload });
  const after = await readState();
  const landed = String(after.scrolly) === expect;
  console.log(`${label}  ->  scrolly=${JSON.stringify(after.scrolly)}  ` +
              `${landed ? 'ROUTED' : 'did NOT route'}` +
              `${after.junk.length ? `   JUNK CREATED: ${JSON.stringify(after.junk)}` : ''}` +
              `${after.topLevelUnderscore !== undefined ? `   top-level datatables_scrolly=${JSON.stringify(after.topLevelUnderscore)}` : ''}` +
              `${r.isError ? `   (tool error: ${r.text.slice(0, 60)})` : ''}`);
}

// Restore.
await call('gv_view_settings_patch', {
  site: SITE, id: VIEW, template_settings: { datatables: { scrolly: ORIGINAL } },
});
const end = await readState();
console.log(`\nrestored: scrolly=${JSON.stringify(end.scrolly)}  junk=${JSON.stringify(end.junk)}`);
console.log(end.scrolly === ORIGINAL ? 'restore OK' : '*** RESTORE FAILED — fix by hand ***');

await client.close();
