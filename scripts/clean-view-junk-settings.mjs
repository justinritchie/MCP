#!/usr/bin/env node
/**
 * Remove junk top-level keys from a View's template_settings.
 *
 * gv_view_settings_patch is merge-only, so a key written by mistake cannot be
 * removed through it — the gap TICKET item #1 flags. gv_view_config_apply with
 * mode=replace IS the affordance: it replaces the whole template_settings area,
 * so a map that simply omits the junk removes it.
 *
 * Reads the CURRENT settings live, strips keys matching the junk pattern,
 * restores any value this probe changed, and replaces. Dry run by default —
 * pass --apply to write.
 *
 * Junk pattern is deliberately narrow: `datatables` followed by anything other
 * than an underscore-delimited real key, plus the specific top-level
 * `datatables_*` keys that the underscore write invented. It never touches the
 * nested `datatables` object, which is the real silo.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = resolve(HERE, '../src/index.js');
const SITE = process.env.PROBE_SITE || 'aaru65';
const VIEW = Number(process.env.PROBE_VIEW || 4839);
const APPLY = process.argv.includes('--apply');

// Values this probe disturbed, to put back exactly as found.
const RESTORE = { 'datatables.scrolly': '500' };

const client = new Client({ name: 'clean-junk', version: '1.0.0' }, { capabilities: {} });
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  const t = r?.content?.[0]?.text ?? '';
  let parsed; try { parsed = JSON.parse(t); } catch { parsed = t; }
  return { isError: r?.isError === true, parsed, text: t };
};

await client.connect(new StdioClientTransport({ command: process.execPath, args: [ENTRY] }));

const cfg = await call('gv_view_config_get', { site: SITE, id: VIEW, include: ['template_settings'] });
const ts = cfg.parsed?.template_settings;
if (!ts || typeof ts !== 'object') {
  console.error('could not read template_settings:', cfg.text.slice(0, 200));
  process.exit(2);
}

const isJunk = (k) =>
  k !== 'datatables' && /^datatables/.test(k);

const junk = Object.keys(ts).filter(isJunk);
const clean = {};
for (const [k, v] of Object.entries(ts)) if (!isJunk(k)) clean[k] = v;

// Put scrolly back to the string it was before the probe.
if (clean.datatables && typeof clean.datatables === 'object') {
  clean.datatables = { ...clean.datatables, scrolly: RESTORE['datatables.scrolly'] };
}

console.log(`\nView ${VIEW} on ${SITE}`);
console.log(`  keys now:      ${Object.keys(ts).length}`);
console.log(`  junk to drop:  ${junk.length ? junk.join(', ') : '(none)'}`);
console.log(`  keys after:    ${Object.keys(clean).length}`);
console.log(`  scrolly ->     ${JSON.stringify(clean.datatables?.scrolly)}`);

if (!junk.length) {
  console.log('\nNothing to clean.');
  await client.close();
  process.exit(0);
}

if (!APPLY) {
  console.log('\nDRY RUN — nothing written. Re-run with --apply.');
  await client.close();
  process.exit(0);
}

const res = await call('gv_view_config_apply', {
  site: SITE, id: VIEW, mode: 'replace', template_settings: clean,
});
console.log(`\napply: ${res.isError ? 'ERROR ' + res.text.slice(0, 200) : 'ok'}`);
if (res.parsed?.warnings?.length) {
  console.log('warnings:', JSON.stringify(res.parsed.warnings).slice(0, 300));
}

const after = await call('gv_view_config_get', { site: SITE, id: VIEW, include: ['template_settings'] });
const ats = after.parsed?.template_settings ?? {};
const stillJunk = Object.keys(ats).filter(isJunk);
console.log(`\nafter:  keys=${Object.keys(ats).length}  junk=${stillJunk.length ? stillJunk.join(', ') : 'NONE'}`);
console.log(`        scrolly=${JSON.stringify(ats.datatables?.scrolly)}`);
console.log(`        page_size=${JSON.stringify(ats.page_size)}  (spot-check an unrelated setting survived)`);
console.log(stillJunk.length ? '\n*** junk remains ***' : '\nCLEAN');

await client.close();
