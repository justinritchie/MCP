#!/usr/bin/env node
/**
 * Acceptance run for the per-entry confirmation / notification tools.
 *
 * The headline case is #4: edit ONE entry on a form that has two, and prove the
 * other one is still there afterwards. That is the exact scenario that silently
 * destroys data through gf_update_form's whole-map path, and it is live on six
 * real AAR forms today.
 *
 * Builds its own scratch form and trashes it. Pass --keep to leave it.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = resolve(HERE, '../src/index.js');
const SITE = process.env.PROBE_SITE || 'aaru65';

const client = new Client({ name: 'cn-verify', version: '1.0.0' }, { capabilities: {} });
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  const text = r?.content?.[0]?.text ?? '';
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { isError: r?.isError === true, parsed, text };
};

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  ok ? pass++ : fail++;
};

await client.connect(new StdioClientTransport({ command: process.execPath, args: [ENTRY] }));

// ---- scratch form ---------------------------------------------------------
const created = await call('gf_create_form', {
  site: SITE,
  title: 'ZZ confirmation/notification verify — safe to delete',
  fields: [{ type: 'email', label: 'Email' }],
});
const id = created.parsed?.form?.id;
console.log(`\nscratch form id=${id} on ${SITE}\n`);
if (!id) { console.log('could not create scratch form:', created.text.slice(0, 300)); process.exit(2); }

// ---- 1. build the two-notification case ourselves --------------------------
//
// A freshly created GF form has ZERO notifications (gf_create_form returns
// "notifications": []). An earlier version of this script assumed it started
// with one and therefore never actually exercised the sibling case — the
// headline assertion was passing over a single-entry map, which is exactly the
// situation that cannot fail. Both entries are now created explicitly.
const firstId = 'zz_first_notify';
const addN0 = await call('gf_add_notification', {
  site: SITE, form_id: id, notification_id: firstId,
  properties: {
    name: 'ZZ First Notification', event: 'form_submission', toType: 'email',
    to: 'first@example.com', subject: 'ZZ first', message: '{all_fields}',
  },
});
check('add first notification', addN0.parsed?.success === true, addN0.text.slice(0, 90));

const addN = await call('gf_add_notification', {
  site: SITE, form_id: id, notification_id: 'zz_second_notify',
  properties: {
    name: 'ZZ Second Notification', event: 'form_submission', toType: 'email',
    to: '{admin_email}', subject: 'ZZ second', message: '{all_fields}',
  },
});
check('add_notification succeeds', addN.parsed?.success === true, addN.text.slice(0, 90));
check('adding the second PRESERVED the first', addN.parsed?.preserved_count === 1,
      `preserved_count=${addN.parsed?.preserved_count}`);

const listN1 = await call('gf_list_notifications', { site: SITE, form_id: id });
check('form now has 2 notifications', listN1.parsed?.count === 2, `count=${listN1.parsed?.count}`);
check('list warns about the whole-map trap when >1 entry',
      typeof listN1.parsed?.note === 'string' && /DELETE/.test(listN1.parsed.note));

// ---- 2. dry run writes nothing --------------------------------------------
const dry = await call('gf_update_notification', {
  site: SITE, form_id: id, notification_id: 'zz_second_notify',
  properties: { subject: 'SHOULD NOT PERSIST' }, dry_run: true,
});
check('dry_run reports db_write_attempted=false', dry.parsed?.db_write_attempted === false);
const afterDry = await call('gf_list_notifications', { site: SITE, form_id: id });
check('dry_run really wrote nothing',
      afterDry.parsed?.notifications?.find(n => n.id === 'zz_second_notify')?.subject === 'ZZ second');

// ---- 3. unknown property is refused, not written --------------------------
const bogus = await call('gf_update_notification', {
  site: SITE, form_id: id, notification_id: 'zz_second_notify',
  properties: { nonsenseKey: 'x' },
});
check('unknown property refused', bogus.isError || /Unknown notification propert/.test(bogus.text),
      bogus.text.slice(0, 70));

// ---- 4. THE HEADLINE: edit one, the sibling survives -----------------------
const upd = await call('gf_update_notification', {
  site: SITE, form_id: id, notification_id: 'zz_second_notify',
  properties: { subject: 'ZZ second EDITED' },
});
check('update_notification succeeds', upd.parsed?.success === true, upd.text.slice(0, 90));
check('response reports the preserved sibling', upd.parsed?.preserved_count === 1,
      `preserved_count=${upd.parsed?.preserved_count}`);

const listN2 = await call('gf_list_notifications', { site: SITE, form_id: id });
const names = (listN2.parsed?.notifications ?? []).map(n => n.id);
check('*** SIBLING NOTIFICATION SURVIVED THE EDIT ***',
      listN2.parsed?.count === 2 && names.includes(firstId),
      `count=${listN2.parsed?.count} ids=[${names.join(', ')}]`);
check('the edit actually landed',
      listN2.parsed?.notifications?.find(n => n.id === 'zz_second_notify')?.subject === 'ZZ second EDITED');

// ---- 5. partial patch preserves untouched fields on the SAME entry ---------
const patched = listN2.parsed?.notifications?.find(n => n.id === 'zz_second_notify');
check('untouched field on the same entry preserved', patched?.to === '{admin_email}',
      `to=${patched?.to}`);

// ---- 6. confirmation guardrails -------------------------------------------
const listC = await call('gf_list_confirmations', { site: SITE, form_id: id });
const defaultConfId = listC.parsed?.confirmations?.[0]?.id;
const delOnly = await call('gf_delete_confirmation', {
  site: SITE, form_id: id, confirmation_id: defaultConfId,
});
check('refuses to delete the ONLY confirmation',
      delOnly.isError || /only confirmation/.test(delOnly.text), delOnly.text.slice(0, 70));

const addC = await call('gf_add_confirmation', {
  site: SITE, form_id: id, confirmation_id: 'zz_branch',
  properties: { name: 'ZZ Branch', type: 'message', message: '<p>branch</p>',
                disableAutoformat: true },
});
check('add_confirmation succeeds', addC.parsed?.success === true, addC.text.slice(0, 90));

const delDefault = await call('gf_delete_confirmation', {
  site: SITE, form_id: id, confirmation_id: defaultConfId,
});
check('refuses to delete the DEFAULT confirmation',
      delDefault.isError || /DEFAULT confirmation/.test(delDefault.text),
      delDefault.text.slice(0, 70));

// ---- 7. type validation ---------------------------------------------------
const badType = await call('gf_add_confirmation', {
  site: SITE, form_id: id,
  properties: { name: 'ZZ bad', type: 'page' },   // no pageId
});
check("type 'page' without pageId refused",
      badType.isError || /requires pageId/.test(badType.text), badType.text.slice(0, 70));

// ---- 8. isDefault promotion demotes the previous default ------------------
await call('gf_update_confirmation', {
  site: SITE, form_id: id, confirmation_id: 'zz_branch', properties: { isDefault: true },
});
const listC2 = await call('gf_list_confirmations', { site: SITE, form_id: id });
const defaults = (listC2.parsed?.confirmations ?? []).filter(c => c.isDefault);
check('exactly one default confirmation after promotion', defaults.length === 1,
      `defaults=[${defaults.map(d => d.id).join(', ')}]`);
check('the promoted entry is the new default', defaults[0]?.id === 'zz_branch');

// ---- 9. delete a non-default entry now works, siblings intact -------------
const delOk = await call('gf_delete_confirmation', {
  site: SITE, form_id: id, confirmation_id: defaultConfId,
});
check('deleting a non-default confirmation succeeds', delOk.parsed?.success === true,
      delOk.text.slice(0, 90));
const listC3 = await call('gf_list_confirmations', { site: SITE, form_id: id });
check('one confirmation remains', listC3.parsed?.count === 1, `count=${listC3.parsed?.count}`);

console.log(`\n${pass} passed, ${fail} failed`);
console.log(`\nscratch form ${id} — trash it with:`);
console.log(`  python3 <outputs>/gf-trash-scratch.py ${id}`);
await client.close();
process.exit(fail ? 1 : 0);
