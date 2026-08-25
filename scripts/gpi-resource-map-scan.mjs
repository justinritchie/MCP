#!/usr/bin/env node
/**
 * The one risk the fix could actually create.
 *
 * applyAddonPropertyDefaults only supplies [] when the key is absent or null,
 * so it can never overwrite a populated map that is present in the payload.
 * But gf_update_form takes a whole fields array from the caller. If a caller
 * hand-builds a field rather than read-modify-write, a populated map would be
 * dropped from the payload — and the fix would then fill [] behind it. That
 * turns a loud fatal into a quiet emptying.
 *
 * That risk is only real if populated maps EXIST. Scan every form on every
 * configured site and find out, rather than reasoning about it.
 *
 * Read-only.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ENTRY = '/Users/justinritchie/justinritchie-mcp-servers/gravitykit-mcp/src/index.js';
const SITES = process.argv.slice(2);

const client = new Client({ name: 'gpi-scan', version: '1.0.0' }, { capabilities: {} });
const call = async (n, a) => {
  const r = await client.callTool({ name: n, arguments: a });
  const t = r?.content?.[0]?.text ?? '';
  if (r?.isError) return { __error: t.slice(0, 120) };
  try { return JSON.parse(t); } catch { return null; }
};

// A site that could not be read is NOT a site with nothing wrong in it. Keep the
// two apart in the output, because a silent "no forms" reads exactly like a
// clean bill of health and that is how a partial scan gets mistaken for a full one.
const unscanned = [];

await client.connect(new StdioClientTransport({ command: process.execPath, args: [ENTRY] }));

let populated = 0, empty = 0, absentWithInv = 0, scanned = 0;

for (const site of SITES) {
  const list = await call('gf_list_forms', { site });
  // gf_list_forms returns `forms` as an OBJECT keyed by form id, not an array.
  // Treating it as an array yields length undefined and a silent "no forms",
  // which reads exactly like a clean all-clear. Normalize before counting.
  if (list?.__error) {
    unscanned.push([site, list.__error]);
    console.log(`\n### ${site}: NOT SCANNED — ${list.__error}`);
    continue;
  }
  const raw = list?.forms;
  const forms = Array.isArray(raw) ? raw : (raw && typeof raw === 'object' ? Object.values(raw) : []);
  if (!forms.length) {
    unscanned.push([site, 'returned no forms']);
    console.log(`\n### ${site}: NOT SCANNED — returned no forms`);
    continue;
  }
  console.log(`\n### ${site} — ${forms.length} forms`);
  for (const f of forms) {
    const got = await call('gf_get_form', { site, id: f.id, compact: false });
    const fields = got?.form?.fields || [];
    if (!fields.length) continue;
    scanned++;
    for (const fl of fields) {
      const has = Object.prototype.hasOwnProperty.call(fl, 'gpiResourcePropertyMap');
      const map = fl.gpiResourcePropertyMap;
      const isPopulated = has && map != null
        && !(Array.isArray(map) && map.length === 0)
        && !(typeof map === 'object' && !Array.isArray(map) && Object.keys(map).length === 0);
      if (isPopulated) {
        populated++;
        console.log(`  !! POPULATED  form ${f.id} field ${fl.id} (${fl.type}) `
          + `inv=${fl.gpiInventory ?? '-'}  map=${JSON.stringify(map).slice(0, 200)}`);
      } else if (has) {
        empty++;
      } else if (fl.gpiInventory) {
        absentWithInv++;
        console.log(`  ** FATAL-SHAPED  form ${f.id} (${String(f.title).slice(0,34)}) `
          + `field ${fl.id} (${fl.type}) inv=${fl.gpiInventory} — key ABSENT`);
      }
    }
  }
}

console.log(`\n=== ${scanned} forms scanned across ${SITES.length - unscanned.length}/${SITES.length} sites ===`);
console.log(`populated maps ....... ${populated}   <- the only shape the fix could flatten`);
console.log(`empty maps ........... ${empty}`);
console.log(`inventory + no key ... ${absentWithInv}   <- currently fatal on render`);
if (unscanned.length) {
  console.log(`\nCOVERAGE IS PARTIAL — ${unscanned.length} site(s) were never read, so the`);
  console.log('counts above say nothing about them:');
  for (const [s, why] of unscanned) console.log(`  - ${s}: ${why}`);
}
await client.close();
