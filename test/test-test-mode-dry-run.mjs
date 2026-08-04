#!/usr/bin/env node
/**
 * Regression test for the test_mode phantom-parameter bug (Aug 3 2026).
 *
 * test_mode was declared in the inputSchema of gf_add_field, gf_update_field
 * and gf_delete_field but never destructured in any handler. Passing
 * test_mode:true returned an accurate-looking `changes` block AND performed the
 * write. Reproduced on aarlocal form 1 field 17 with the two-call sequence
 * below: the second call's `changes.before` came back already showing the
 * "previewed" values.
 *
 * This test runs against a fake API so it needs no live site and can run in CI.
 * The assertion that matters is not the response shape — it is that
 * replaceForm() is NEVER called when test_mode is true.
 *
 *   node test/test-test-mode-dry-run.mjs
 */
import assert from 'node:assert';

import { FieldManager } from '../src/field-operations/field-manager.js';
import { fieldOperationHandlers } from '../src/field-operations/index.js';

const FORM = () => ({
  id: 1,
  title: 'REGISTRATION: Open',
  fields: [
    {
      id: 17,
      type: 'radio',
      label: 'Which location do you plan to attend?',
      choices: [
        { text: '<span>Concord</span>', value: 'Concord', inventory_limit: 225 },
        { text: '<span>Raleigh</span>', value: 'Raleigh', inventory_limit: 140 }
      ]
    }
  ]
});

function makeApi() {
  const calls = { replaceForm: 0, lastForm: null };
  return {
    calls,
    async getForm() { return { form: FORM() }; },
    async replaceForm(formId, form) {
      calls.replaceForm += 1;
      calls.lastForm = form;
      return { form };
    }
  };
}

function makeManager(api) {
  // Positional: (apiClient, fieldRegistry, validator). dependencyTracker and
  // positionEngine are injected after construction by createFieldOperations().
  const fm = new FieldManager(api, {}, { getWarnings: () => [] });
  fm.dependencyTracker = {
    scanFormDependencies: () => ({}),
    hasBreakingDependencies: () => false
  };
  return fm;
}

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  [PASS] ${name}`); }
  catch (e) { failures++; console.log(`  [FAIL] ${name}\n         ${e.message}`); }
};

console.log('=== gf_update_field ===');
{
  const api = makeApi();
  const fieldManager = makeManager(api);

  // Call 1 — dry run. The bug: this wrote.
  const dry = await fieldOperationHandlers.gf_update_field(
    { form_id: 1, field_id: 17, test_mode: true,
      properties: { gpiInventory: 'simple',
                    choices: [{ text: '<span>Concord</span>', value: 'Concord', inventory_limit: 1 }] } },
    { fieldManager }
  );

  check('dry run does NOT call replaceForm', () =>
    assert.strictEqual(api.calls.replaceForm, 0));
  check('dry run reports persisted:false', () =>
    assert.strictEqual(dry.persisted, false));
  check('dry run still returns a real before/after', () => {
    assert.strictEqual(dry.changes.before.choices[0].inventory_limit, 225);
    assert.strictEqual(dry.changes.after.choices[0].inventory_limit, 1);
  });

  // Call 2 — the ticket's tell. After a dry run, a fresh read must still show
  // the ORIGINAL value. If the dry run wrote, before === 1 here.
  const real = await fieldOperationHandlers.gf_update_field(
    { form_id: 1, field_id: 17,
      properties: { choices: [{ text: '<span>Concord</span>', value: 'Concord', inventory_limit: 1 }] } },
    { fieldManager }
  );

  check('second call still sees the ORIGINAL 225 (the actual bug)', () =>
    assert.strictEqual(real.changes.before.choices[0].inventory_limit, 225));
  check('real write DOES call replaceForm', () =>
    assert.strictEqual(api.calls.replaceForm, 1));
  check('real write reports persisted:true', () =>
    assert.strictEqual(real.persisted, true));
}

console.log('=== gf_delete_field ===');
{
  const api = makeApi();
  const fieldManager = makeManager(api);

  const dry = await fieldOperationHandlers.gf_delete_field(
    { form_id: 1, field_id: 17, test_mode: true }, { fieldManager });

  check('dry run does NOT call replaceForm', () =>
    assert.strictEqual(api.calls.replaceForm, 0));
  check('dry run reports would_delete_field, not deleted_field', () => {
    assert.ok(dry.would_delete_field, 'expected would_delete_field');
    assert.ok(!dry.deleted_field, 'deleted_field must not be present on a dry run');
  });

  await fieldOperationHandlers.gf_delete_field({ form_id: 1, field_id: 17 }, { fieldManager });
  check('real delete DOES call replaceForm', () =>
    assert.strictEqual(api.calls.replaceForm, 1));
}

console.log('=== gf_add_field ===');
{
  const api = makeApi();
  const fieldManager = makeManager(api);

  const dry = await fieldOperationHandlers.gf_add_field(
    { form_id: 1, field_type: 'text', properties: { label: 'X' }, test_mode: true },
    { fieldManager });

  check('dry run does NOT call replaceForm', () =>
    assert.strictEqual(api.calls.replaceForm, 0));
  check('dry run reports persisted:false', () =>
    assert.strictEqual(dry.persisted, false));
  check('dry run still returns the constructed field', () =>
    assert.ok(dry.field && dry.field.type === 'text'));

  await fieldOperationHandlers.gf_add_field(
    { form_id: 1, field_type: 'text', properties: { label: 'X' } }, { fieldManager });
  check('real add DOES call replaceForm', () =>
    assert.strictEqual(api.calls.replaceForm, 1));
}

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILED'}`);
process.exit(failures ? 1 : 0);
