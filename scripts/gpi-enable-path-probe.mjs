#!/usr/bin/env node
/**
 * Does the mu-plugin's inventory ENABLE path create the fatal state?
 *
 * jumbo-qa-rest.php:3414 —  if (!empty($enable)) { $target->gpiInventory = $enable; }
 *
 * Setting gpiInventory on a field that carries no gpiResourcePropertyMap is
 * exactly the shape that white-screens the page. The gravitykit-side fix cannot
 * help here: the field starts WITHOUT gpiInventory, so nothing fills the map,
 * and the mu-plugin turns inventory on afterwards through a different process.
 *
 * This is the everyday path — the first time anyone enables inventory on a field.
 *
 * Creates its own scratch form. Prints the id to trash afterwards.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

const SITE = 'aaru65';
const BASE = 'https://aar-u65.bluecrossnc.events';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)';

const env = readFileSync(`${homedir()}/.mcp-credentials/jumbo-qa-aar-u65-bluecrossnc-events.env`, 'utf8');
const appPass = env.match(/JUMBO_QA_WPADMIN_[A-Z0-9_]+="([^"]+)"/)[1];
const basic = 'Basic ' + Buffer.from(`justin@jumbo.live:${appPass}`).toString('base64');

const client = new Client({ name: 'gpi-enable-probe', version: '1.0.0' }, { capabilities: {} });
const call = async (n, a) => {
  const r = await client.callTool({ name: n, arguments: a });
  const t = r?.content?.[0]?.text ?? '';
  try { return JSON.parse(t); } catch { return t; }
};
const mapOf = (f) => (f && Object.prototype.hasOwnProperty.call(f, 'gpiResourcePropertyMap'))
  ? JSON.stringify(f.gpiResourcePropertyMap) : '(ABSENT)';

await client.connect(new StdioClientTransport({ command: process.execPath, args: ['src/index.js'] }));

// 1. A choice field with NO gpiInventory. The gravitykit fix deliberately leaves
//    these alone, so it arrives with no gpiResourcePropertyMap — correctly.
const made = await call('gf_create_form', {
  site: SITE,
  title: 'ZZ GPI enable-path probe — safe to delete',
  fields: [{
    id: 1, type: 'radio', label: 'Enable-path probe', enableChoiceValue: true,
    choices: [
      { text: 'Alpha', value: 'Alpha' },
      { text: 'Beta', value: 'Beta' },
    ],
  }],
});
const formId = made?.form?.id;
const f0 = (made?.form?.fields || [])[0];
console.log(`\nscratch form ${formId}`);
console.log(`  before:  gpiInventory=${f0?.gpiInventory ?? '(absent)'}  map=${mapOf(f0)}`);

// 2. Turn inventory ON through the mu-plugin — the everyday operator action.
const res = await fetch(`${BASE}/wp-json/jumbo-qa/v1/inventory/limits`, {
  method: 'POST',
  headers: { Authorization: basic, 'User-Agent': UA, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    form_id: formId, field_id: 1,
    limits: { Alpha: 10, Beta: null },   // every choice governed, so the 0-guard passes
    enable: 'simple',
    dry_run: false,
  }),
});
const body = await res.json();
console.log(`  enable:  HTTP ${res.status}  ok=${body.ok}  gpiInventory ${JSON.stringify(body.gpiInventory)}`);

// 3. Read the field back off the server.
const after = await call('gf_get_form', { site: SITE, id: formId, compact: false });
const f1 = (after?.form?.fields || [])[0];
console.log(`  after:   gpiInventory=${f1?.gpiInventory ?? '(absent)'}  map=${mapOf(f1)}`);

const fatalShape = !!f1?.gpiInventory
  && !Object.prototype.hasOwnProperty.call(f1 || {}, 'gpiResourcePropertyMap');
console.log(`\n  FATAL SHAPE CREATED: ${fatalShape ? 'YES' : 'no'}`);

// 4. NO RENDER CHECK HERE, on purpose. An earlier version of this script fetched
//    /?gf_page=preview&id=N with the WP Application Password and reported
//    "gform_wrapper=false" as proof the render was broken. That was WRONG and it
//    produced a confident false positive.
//
//    WP Application Passwords authenticate API requests ONLY — core bails out of
//    wp_authenticate_application_password for non-API requests — so that URL
//    returns the wp-login page no matter what. Proven by using form 1, the
//    healthy live registration form, as a control: it returned the identical
//    14475-byte login page. A check that reports "broken" for a form known to be
//    fine is not a check.
//
//    The self-check below is the lesson: any render assertion must first be shown
//    to PASS on a known-good form, or it is measuring nothing.
//
//    To actually render-test a scratch form, it has to be embedded on a
//    publicly-reachable page (which is what the original ticket did, publishing a
//    probe page for about a minute). That is a site write, so it is deliberately
//    not automated here.
const control = await fetch(`${BASE}/?gf_page=preview&id=1`, {
  headers: { Authorization: basic, 'User-Agent': UA },
});
const controlHtml = await control.text();
const controlUsable = controlHtml.includes('gform_wrapper');
console.log(`\n  render check: SKIPPED — not available over Application Password auth`);
console.log(`  self-check: known-good form 1 via this URL yields gform_wrapper=${controlUsable}`);
console.log(`              (false confirms the URL cannot see forms at all, so any`);
console.log(`               "broken" verdict from it would be meaningless)`);
console.log(`\n  VERDICT (data level only): ${fatalShape
  ? 'FATAL SHAPE PRESENT — gpiInventory set with no gpiResourcePropertyMap'
  : 'shape is correct — matches UI-built field 17, which renders fine on /access/start/'}`);
console.log(`\ntrash with: python3 <outputs>/gf-trash-scratch.py ${formId}`);
await client.close();
