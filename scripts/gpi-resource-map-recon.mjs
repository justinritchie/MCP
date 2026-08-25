#!/usr/bin/env node
/**
 * Verify the claims in TICKET-gpi-resource-property-map-fatal.md before fixing.
 *
 * The ticket asserts:
 *   a) UI-built inventory fields carry gpiResourcePropertyMap: []
 *   b) MCP-built ones do not
 *   c) inventory_limit: 0 is a normal stored value on non-inventory choices
 *
 * (a) is the whole basis for defaulting to [] rather than something else, so it
 * is worth confirming against the real form rather than trusting the report.
 *
 * Read-only.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = resolve(HERE, '../src/index.js');
const SITE = 'aaru65';

const client = new Client({ name: 'gpi-recon', version: '1.0.0' }, { capabilities: {} });
const call = async (n, a) => {
  const r = await client.callTool({ name: n, arguments: a });
  const t = r?.content?.[0]?.text ?? '';
  try { return JSON.parse(t); } catch { return null; }
};

await client.connect(new StdioClientTransport({ command: process.execPath, args: [ENTRY] }));

const describe = (f) => ({
  id: f.id, type: f.type, label: String(f.label ?? '').slice(0, 30),
  gpiInventory: f.gpiInventory ?? '(absent)',
  hasResourceMap: Object.prototype.hasOwnProperty.call(f, 'gpiResourcePropertyMap'),
  resourceMap: JSON.stringify(f.gpiResourcePropertyMap ?? null),
  validateState: f.validateState ?? '(absent)',
  inputType: f.inputType ?? '(absent)',
  choices: Array.isArray(f.choices) ? f.choices.length : 0,
  limitsSeen: Array.isArray(f.choices)
    ? [...new Set(f.choices.map(c => c.inventory_limit).filter(v => v !== undefined))].slice(0, 6)
    : [],
});

for (const formId of [1, 29, 30]) {
  const got = await call('gf_get_form', { site: SITE, id: formId, compact: false });
  const form = got?.form;
  if (!form) { console.log(`\nform ${formId}: NOT READABLE`); continue; }
  console.log(`\n=== form ${formId} — ${String(form.title).slice(0, 46)} ===`);
  const inv = (form.fields || []).filter(f =>
    f.gpiInventory || Object.prototype.hasOwnProperty.call(f, 'gpiResourcePropertyMap'));
  if (!inv.length) {
    console.log('  no inventory-enabled fields');
    // Still show a choice field to check claim (c)
    const anyChoice = (form.fields || []).find(f => Array.isArray(f.choices) && f.choices.length);
    if (anyChoice) console.log('  sample choice field:', JSON.stringify(describe(anyChoice)));
    continue;
  }
  for (const f of inv) console.log('  ', JSON.stringify(describe(f)));
}

// Claim (c): inventory_limit 0 on ordinary non-inventory choice fields.
const f1 = (await call('gf_get_form', { site: SITE, id: 1, compact: false }))?.form;
if (f1) {
  console.log('\n=== claim (c): inventory_limit on NON-inventory choice fields, form 1 ===');
  for (const f of (f1.fields || [])) {
    if (!Array.isArray(f.choices) || !f.choices.length) continue;
    if (f.gpiInventory) continue;
    const limits = [...new Set(f.choices.map(c => c.inventory_limit))];
    if (limits.some(v => v !== undefined)) {
      console.log(`   field ${f.id} (${String(f.label).slice(0,26)}): limits=${JSON.stringify(limits.slice(0,5))}`);
    }
  }
}

await client.close();
