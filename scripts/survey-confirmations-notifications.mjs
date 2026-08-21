#!/usr/bin/env node
/**
 * READ-ONLY survey: how much multi-entry confirmation/notification branching
 * actually exists across the live sites?
 *
 * The audit established that gf_update_form replaces these maps wholesale, and
 * that multi-entry maps form conditional if/else chains. What it could NOT say
 * is whether any real form depends on that — the two forms sampled each had a
 * single entry. That distinction decides how hard the new per-entry tools have
 * to push back: if branching is everywhere, a whole-map write is a live
 * data-loss risk today and the guardrails should be loud.
 *
 * Reads only. gf_list_forms + gf_get_form.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = resolve(HERE, '../src/index.js');
const SITES = process.argv.slice(2).length ? process.argv.slice(2)
                                           : ['aaru65', 'aarlocal', 'bestofblue', 'cbrcsummit'];

const client = new Client({ name: 'cn-survey', version: '1.0.0' }, { capabilities: {} });
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  const t = r?.content?.[0]?.text ?? '';
  try { return JSON.parse(t); } catch { return null; }
};

await client.connect(new StdioClientTransport({ command: process.execPath, args: [ENTRY] }));

const totals = { forms: 0, multiConf: 0, multiNotif: 0, condConf: 0, condNotif: 0 };
const notable = [];

for (const site of SITES) {
  const list = await call('gf_list_forms', { site });
  const forms = Array.isArray(list?.forms) ? list.forms
              : Array.isArray(list) ? list
              : Object.values(list?.forms ?? list ?? {});
  if (!forms?.length) { console.log(`\n${site}: no forms readable`); continue; }

  console.log(`\n=== ${site} — ${forms.length} forms ===`);
  for (const f of forms) {
    const id = f.id ?? f.form_id;
    if (id == null) continue;
    const got = await call('gf_get_form', { site, id: Number(id) });
    const form = got?.form ?? got;
    if (!form) continue;
    totals.forms++;

    const conf = form.confirmations ?? {};
    const notif = form.notifications ?? {};
    const nConf = Object.keys(conf).length;
    const nNotif = Object.keys(notif).length;
    const condConf = Object.values(conf)
      .filter(c => Array.isArray(c?.conditionalLogic?.rules) ||
                   (c?.conditionalLogic && c.conditionalLogic.enabled)).length;
    const condNotif = Object.values(notif)
      .filter(n => Array.isArray(n?.conditionalLogic?.rules) ||
                   (n?.conditionalLogic && n.conditionalLogic.enabled)).length;

    if (nConf > 1) totals.multiConf++;
    if (nNotif > 1) totals.multiNotif++;
    totals.condConf += condConf;
    totals.condNotif += condNotif;

    const risky = nConf > 1 || nNotif > 1 || condConf || condNotif;
    if (risky) {
      notable.push({ site, id, title: form.title, nConf, nNotif, condConf, condNotif });
    }
    console.log(
      `  form ${String(id).padStart(3)}  conf=${nConf}${condConf ? `(${condConf} conditional)` : ''}` +
      `  notif=${nNotif}${condNotif ? `(${condNotif} conditional)` : ''}` +
      `${risky ? '   <-- whole-map write would be DESTRUCTIVE here' : ''}  ${String(form.title ?? '').slice(0, 42)}`
    );
  }
}

console.log(`\n${'='.repeat(70)}`);
console.log(`forms inspected            ${totals.forms}`);
console.log(`forms with >1 confirmation ${totals.multiConf}`);
console.log(`forms with >1 notification ${totals.multiNotif}`);
console.log(`conditional confirmations  ${totals.condConf}`);
console.log(`conditional notifications  ${totals.condNotif}`);
if (notable.length) {
  console.log(`\nForms where a whole-map write TODAY would silently delete entries:`);
  for (const n of notable) {
    console.log(`  ${n.site} form ${n.id} — ${n.title} (conf=${n.nConf}, notif=${n.nNotif})`);
  }
} else {
  console.log('\nNo multi-entry maps found — the risk is real but not yet realised.');
}

await client.close();
