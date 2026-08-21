#!/usr/bin/env node
/**
 * Acceptance for the `values` param on gf_submit_form_data and gf_update_entry
 * (TICKET items #2 and #3).
 *
 * Root cause, proven before writing any code: the values DO reach the server
 * over stdio, so the server was never at fault — an MCP client strips the loose
 * top-level input_N / numeric keys, and additionalProperties:true does not stop
 * it. The fix is a DECLARED object param.
 *
 * Submission is tested against a scratch form, not the live waitlist (form 21),
 * because a submission is a real entry and the waitlist is client-facing.
 * Entry-update is tested against entry 2357, the blank row the ticket left.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = resolve(HERE, '../src/index.js');
const SITE = process.env.PROBE_SITE || 'aaru65';
const UPDATE_ENTRY_ID = Number(process.env.PROBE_ENTRY || 2357);

 // NOTE: not @example.com — aaru65 rejects it ("The email address entered is
// invalid"), which on first run looked like the values param failing when it was
// only the fixture. Use a real domain.
const client = new Client({ name: 'values-verify', version: '1.0.0' }, { capabilities: {} });
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

// ---- scratch form for the submission test --------------------------------
const made = await call('gf_create_form', {
  site: SITE,
  title: 'ZZ values-param verify — safe to delete',
  fields: [
    { type: 'text', label: 'Full Name', isRequired: true },
    { type: 'email', label: 'Email', isRequired: true },
  ],
});
const formId = made.parsed?.form?.id;
const fieldIds = (made.parsed?.form?.fields ?? []).map(f => f.id);
console.log(`\nscratch form ${formId}, field ids ${JSON.stringify(fieldIds)}\n`);

// ---- 1. submit via `values` ----------------------------------------------
const marker = `ZZ-${Date.now().toString().slice(-6)}`;
const sub = await call('gf_submit_form_data', {
  site: SITE, form_id: formId,
  values: { [fieldIds[0]]: marker, [fieldIds[1]]: 'zz-verify@jumbo.live' },
});
check('submit succeeds with values', sub.parsed?.success === true,
      `success=${sub.parsed?.success} msgs=${JSON.stringify(sub.parsed?.validation_messages ?? {})}`);
const newEntryId = sub.parsed?.entry_id;
check('an entry id came back', Boolean(newEntryId), `entry_id=${newEntryId}`);

if (newEntryId) {
  const got = await call('gf_get_entry', { site: SITE, id: Number(newEntryId) });
  const e = got.parsed?.entry ?? got.parsed;
  check('the submitted value actually landed', e?.[String(fieldIds[0])] === marker,
        `field ${fieldIds[0]} = ${JSON.stringify(e?.[String(fieldIds[0])])}`);
}

// ---- 2. input_-prefixed keys normalise the same way -----------------------
const marker2 = `ZZ-pre-${Date.now().toString().slice(-5)}`;
const sub2 = await call('gf_submit_form_data', {
  site: SITE, form_id: formId,
  values: { [`input_${fieldIds[0]}`]: marker2, [`input_${fieldIds[1]}`]: 'zz-verify2@jumbo.live' },
});
check('input_-prefixed keys are accepted too', sub2.parsed?.success === true,
      `success=${sub2.parsed?.success}`);

// ---- 3. entry update via `values` ----------------------------------------
const upd = await call('gf_update_entry', {
  site: SITE, id: UPDATE_ENTRY_ID, values: { '1': marker },
});
check('update_entry succeeds with values', !upd.isError, upd.text.slice(0, 80));
const after = await call('gf_get_entry', { site: SITE, id: UPDATE_ENTRY_ID });
const a = after.parsed?.entry ?? after.parsed;
check('the updated value landed', a?.['1'] === marker, `field "1" = ${JSON.stringify(a?.['1'])}`);

// ---- 4. the silent no-op is now loud -------------------------------------
const empty = await call('gf_update_entry', { site: SITE, id: UPDATE_ENTRY_ID });
check('an update carrying no values REFUSES instead of returning 200',
      empty.isError || /would do nothing/.test(empty.text), empty.text.slice(0, 90));

// ---- 5. status-only updates must still work ------------------------------
const statusOnly = await call('gf_update_entry', {
  site: SITE, id: UPDATE_ENTRY_ID, status: 'active',
});
check('a status-only update is still allowed', !statusOnly.isError, statusOnly.text.slice(0, 80));

console.log(`\n${pass} passed, ${fail} failed`);
console.log(`\nscratch form ${formId} — trash with: python3 <outputs>/gf-trash-scratch.py ${formId}`);
await client.close();
process.exit(fail ? 1 : 0);
