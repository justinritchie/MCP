#!/usr/bin/env node
/**
 * TICKET-gpi-resource-property-map-fatal.md — the five-point test plan, live.
 *
 * The bug: a choice field with gpiInventory and no gpiResourcePropertyMap is a
 * PHP fatal on every front-end render of the whole page. The API gives no hint —
 * 200, clean field object, readable inventory numbers.
 *
 * Creates its own scratch form. Does NOT embed anything on a page; render
 * verification is the one step that still needs a human (or a draft page), and
 * the ticket already did six of those.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = resolve(HERE, '../src/index.js');
const SITE = process.env.PROBE_SITE || 'aaru65';

const client = new Client({ name: 'gpi-verify', version: '1.0.0' }, { capabilities: {} });
const call = async (n, a) => {
  const r = await client.callTool({ name: n, arguments: a });
  const t = r?.content?.[0]?.text ?? '';
  let parsed; try { parsed = JSON.parse(t); } catch { parsed = t; }
  return { isError: r?.isError === true, parsed, text: t };
};

let pass = 0, fail = 0;
const check = (n, ok, d = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? `  — ${d}` : ''}`);
  ok ? pass++ : fail++;
};
const mapOf = (f) => (f && Object.prototype.hasOwnProperty.call(f, 'gpiResourcePropertyMap'))
  ? JSON.stringify(f.gpiResourcePropertyMap) : '(ABSENT)';

await client.connect(new StdioClientTransport({ command: process.execPath, args: [ENTRY] }));

// ---- 1. gf_create_form with gpiInventory, no gpiResourcePropertyMap --------
const made = await call('gf_create_form', {
  site: SITE,
  title: 'ZZ GPI resource-map fix verify — safe to delete',
  fields: [
    {
      id: 1, type: 'radio', label: 'Probe', enableChoiceValue: true,
      gpiInventory: 'simple',
      choices: [
        { text: 'Full choice', value: 'TestFull', isSelected: false, inventory_limit: 0 },
        { text: 'Open choice', value: 'TestOpen', isSelected: false, inventory_limit: 100 },
      ],
    },
    // Control: a field with NO gpiInventory must be left alone (test plan #4).
    { id: 2, type: 'text', label: 'Plain text control' },
  ],
});
const formId = made.parsed?.form?.id;
const fields = made.parsed?.form?.fields ?? [];
console.log(`\nscratch form ${formId}\n`);

const invField = fields.find(f => String(f.id) === '1');
const plainField = fields.find(f => String(f.id) === '2');

check('1. create response carries gpiResourcePropertyMap: []',
      JSON.stringify(invField?.gpiResourcePropertyMap) === '[]', mapOf(invField));
check('4. a field WITHOUT gpiInventory does NOT get the property',
      !Object.prototype.hasOwnProperty.call(plainField ?? {}, 'gpiResourcePropertyMap'),
      mapOf(plainField));

// Read it back off the server — the response echo is not proof it persisted.
const reread = await call('gf_get_form', { site: SITE, id: formId, compact: false });
const rf = (reread.parsed?.form?.fields ?? []).find(f => String(f.id) === '1');
check('1b. persisted — re-read from the server still shows []',
      JSON.stringify(rf?.gpiResourcePropertyMap) === '[]', mapOf(rf));

// ---- 3. same for gf_add_field onto an existing form ------------------------
const added = await call('gf_add_field', {
  site: SITE, form_id: formId, field_type: 'radio',
  properties: {
    label: 'Added inventory probe', enableChoiceValue: true, gpiInventory: 'simple',
    choices: [{ text: 'A', value: 'A', inventory_limit: 5 }],
  },
});
check('3. gf_add_field supplies it too',
      JSON.stringify(added.parsed?.field?.gpiResourcePropertyMap) === '[]',
      mapOf(added.parsed?.field));
const addedId = added.parsed?.field?.id;

// ---- 5. gf_update_field with an explicit null must not leave it null -------
const nulled = await call('gf_update_field', {
  site: SITE, form_id: formId, field_id: addedId,
  properties: { gpiResourcePropertyMap: null },
});
check('5. an explicit null is coerced back to [] rather than persisted',
      JSON.stringify(nulled.parsed?.field?.gpiResourcePropertyMap) === '[]',
      mapOf(nulled.parsed?.field));

const after = await call('gf_get_form', { site: SITE, id: formId, compact: false });
const af = (after.parsed?.form?.fields ?? []).find(f => String(f.id) === String(addedId));
check('5b. and the server agrees on re-read',
      JSON.stringify(af?.gpiResourcePropertyMap) === '[]', mapOf(af));

// ---- regression: the dry-run path must preview the fix, not a false shape --
const dry = await call('gf_update_field', {
  site: SITE, form_id: formId, field_id: addedId,
  properties: { gpiResourcePropertyMap: null }, test_mode: true,
});
check('dry run previews the coerced value, not null',
      JSON.stringify(dry.parsed?.field?.gpiResourcePropertyMap) === '[]',
      mapOf(dry.parsed?.field));
check('dry run wrote nothing', dry.parsed?.persisted === false,
      `persisted=${dry.parsed?.persisted}`);

console.log(`\n${pass} passed, ${fail} failed`);
console.log(`\nscratch form ${formId} — trash with: python3 <outputs>/gf-trash-scratch.py ${formId}`);
await client.close();
process.exit(fail ? 1 : 0);
