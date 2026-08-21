/**
 * Dry-run safety: a preview must never write.
 *
 * ORIGIN — the test_mode phantom-parameter bug (Aug 3 2026).
 * `test_mode` was declared in the inputSchema of gf_add_field, gf_update_field
 * and gf_delete_field and never destructured in any handler. Passing
 * test_mode:true returned an accurate-looking `changes` block AND performed the
 * write. Reproduced on aarlocal form 1 field 17 with the two-call sequence
 * below: the second call's `changes.before` came back already showing the
 * "previewed" values. Fixed in 324b6df.
 *
 * WHY THESE ASSERTIONS AND NOT THE RESPONSE BODY.
 * The response *said* preview. Asserting on it would have passed against the
 * bug. So every case here proves the negative two independent ways:
 *   1. the API's replaceForm was never called, and
 *   2. an independent read-back of the form is byte-identical to before.
 * The fake API is STATEFUL for exactly that reason — replaceForm commits, and
 * getForm returns a clone of what was committed. Against a stateless fake the
 * read-back assertion is vacuous: getForm hands back a pristine fixture whether
 * or not the write happened, so the bug survives a green test.
 *
 * Covers `test_mode` on the three field tools and `dry_run` on
 * gf_set_choice_text, plus a structural guard (last block) against the whole
 * phantom-parameter CLASS — any schema-declared param no handler reads. That is
 * the shape a schema-regenerating refactor can silently reintroduce, and these
 * flags are what a caller reaches for precisely when they are nervous about a
 * payload on a live client site.
 *
 *   node --test test/dry-run-safety.test.js
 */
import test from 'node:test';
import assert from 'node:assert';

import { FieldManager } from '../src/field-operations/field-manager.js';
import { fieldOperationHandlers, fieldOperationTools } from '../src/field-operations/index.js';

/** Mirrors the live AAR shape: HTML label text, a routing `value`, GP Inventory. */
const FORM = () => ({
  id: 1,
  title: 'REGISTRATION: Open',
  fields: [
    {
      id: 17,
      type: 'radio',
      inputType: 'radio',
      label: 'Which location do you plan to attend?',
      enableChoiceValue: true,
      gpiInventory: 'simple',
      choices: [
        { text: '<span class="aar-loc">Concord, NC</span>', value: 'Concord', isSelected: false, price: '', inventory_limit: 225 },
        { text: '<span class="aar-loc">Winston-Salem, NC</span>', value: 'Winston-Salem', isSelected: false, price: '', inventory_limit: 225 },
        { text: '<span class="aar-loc">Raleigh, NC</span>', value: 'Raleigh', isSelected: false, price: '', inventory_limit: 140 }
      ]
    },
    { id: 3, type: 'text', label: 'Full name' }
  ]
});

const clone = (v) => structuredClone(v);

/**
 * Stateful fake GF API. replaceForm COMMITS; getForm returns a clone of the
 * committed state. This is what makes the read-back assertions real.
 */
function makeApi(initial = FORM()) {
  const state = { form: clone(initial) };
  const calls = { getForm: 0, replaceForm: 0 };
  return {
    calls,
    /** Independent read — does not go through the code under test. */
    snapshot: () => clone(state.form),
    snapshotField: (id) => clone(state.form.fields.find((f) => f.id == id)),
    async getForm() { calls.getForm += 1; return { form: clone(state.form) }; },
    async replaceForm(formId, form) {
      calls.replaceForm += 1;
      state.form = clone(form);
      return { form: clone(state.form) };
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

/** Byte-identical, with a readable structural diff first when it fails. */
function assertUnchanged(before, after, what) {
  assert.deepStrictEqual(after, before, `${what} changed structurally`);
  assert.strictEqual(JSON.stringify(after), JSON.stringify(before), `${what} is not byte-identical`);
}

// ===========================================================================
// test_mode — the three original offenders
// ===========================================================================

test('gf_update_field test_mode: field is unchanged on an independent read-back', async () => {
  const api = makeApi();
  const fieldManager = makeManager(api);
  const before = api.snapshotField(17);

  const dry = await fieldOperationHandlers.gf_update_field(
    {
      form_id: 1,
      field_id: 17,
      test_mode: true,
      properties: {
        label: 'PREVIEW ONLY — must not land',
        choices: [{ text: 'x', value: 'Concord', isSelected: false, price: '', inventory_limit: 1 }]
      }
    },
    { fieldManager }
  );

  assert.strictEqual(api.calls.replaceForm, 0, 'dry run called replaceForm');
  assertUnchanged(before, api.snapshotField(17), 'field 17 after a dry run');
  assert.strictEqual(dry.persisted, false);
  assert.strictEqual(dry.test_mode, true);
  // A dry run still has to be USEFUL — the preview must be real, not empty.
  assert.strictEqual(dry.changes.before.choices[0].inventory_limit, 225);
  assert.strictEqual(dry.changes.after.choices[0].inventory_limit, 1);
});

test('gf_update_field: a real write persists, and the read-back proves it', async () => {
  const api = makeApi();
  const fieldManager = makeManager(api);

  const real = await fieldOperationHandlers.gf_update_field(
    { form_id: 1, field_id: 17, properties: { label: 'Changed' } },
    { fieldManager }
  );

  assert.strictEqual(api.calls.replaceForm, 1);
  assert.strictEqual(real.persisted, true);
  assert.strictEqual(api.snapshotField(17).label, 'Changed');
});

test('gf_update_field: the ticket sequence — a dry run then a real call still sees the ORIGINAL', async () => {
  // This is the exact two-call sequence that exposed the bug. Under the bug the
  // second call's changes.before came back already showing the previewed value.
  const api = makeApi();
  const fieldManager = makeManager(api);

  await fieldOperationHandlers.gf_update_field(
    { form_id: 1, field_id: 17, test_mode: true, properties: { label: 'previewed' } },
    { fieldManager }
  );
  const real = await fieldOperationHandlers.gf_update_field(
    { form_id: 1, field_id: 17, properties: { label: 'applied' } },
    { fieldManager }
  );

  assert.strictEqual(real.changes.before.label, 'Which location do you plan to attend?');
});

test('gf_delete_field test_mode: the field survives an independent read-back', async () => {
  const api = makeApi();
  const fieldManager = makeManager(api);
  const before = api.snapshot();

  const dry = await fieldOperationHandlers.gf_delete_field(
    { form_id: 1, field_id: 17, test_mode: true }, { fieldManager });

  assert.strictEqual(api.calls.replaceForm, 0, 'dry run called replaceForm');
  assertUnchanged(before, api.snapshot(), 'the form after a dry-run delete');
  assert.ok(dry.would_delete_field, 'expected would_delete_field');
  assert.ok(!dry.deleted_field, 'deleted_field must not be present on a dry run');

  await fieldOperationHandlers.gf_delete_field({ form_id: 1, field_id: 17 }, { fieldManager });
  assert.strictEqual(api.calls.replaceForm, 1);
  assert.strictEqual(api.snapshot().fields.find((f) => f.id === 17), undefined);
});

test('gf_add_field test_mode: no field is appended on an independent read-back', async () => {
  const api = makeApi();
  const fieldManager = makeManager(api);
  const before = api.snapshot();

  const dry = await fieldOperationHandlers.gf_add_field(
    { form_id: 1, field_type: 'text', properties: { label: 'X' }, test_mode: true },
    { fieldManager });

  assert.strictEqual(api.calls.replaceForm, 0, 'dry run called replaceForm');
  assertUnchanged(before, api.snapshot(), 'the form after a dry-run add');
  assert.strictEqual(dry.persisted, false);
  assert.ok(dry.field && dry.field.type === 'text', 'dry run must still return the constructed field');

  await fieldOperationHandlers.gf_add_field(
    { form_id: 1, field_type: 'text', properties: { label: 'X' } }, { fieldManager });
  assert.strictEqual(api.calls.replaceForm, 1);
  assert.strictEqual(api.snapshot().fields.length, before.fields.length + 1);
});

// ===========================================================================
// dry_run — gf_set_choice_text, same treatment
// ===========================================================================

const NEW_LABEL =
  '<span class="aar-loc">Concord, NC</span>'
  + '<a class="aar-waitlist-link" href="/waitlist/?location=Concord">Join the waitlist</a>';

test('gf_set_choice_text dry_run: choices are unchanged on an independent read-back', async () => {
  const api = makeApi();
  const fieldManager = makeManager(api);
  const before = api.snapshotField(17);

  const dry = await fieldOperationHandlers.gf_set_choice_text(
    { form_id: 1, field_id: 17, texts: { Concord: NEW_LABEL }, dry_run: true },
    { fieldManager });

  assert.strictEqual(api.calls.replaceForm, 0, 'dry run called replaceForm');
  assertUnchanged(before, api.snapshotField(17), 'field 17 after a dry run');
  assert.strictEqual(dry.persisted, false);
  assert.strictEqual(dry.dry_run, true);
  // The preview must be real, or the flag is useless and callers stop using it.
  assert.deepStrictEqual(dry.changes, [
    { value: 'Concord', before: '<span class="aar-loc">Concord, NC</span>', after: NEW_LABEL, changed: true }
  ]);
});

test('gf_set_choice_text: a real write changes text ONLY, on the targeted choice only', async () => {
  const api = makeApi();
  const fieldManager = makeManager(api);
  const before = api.snapshotField(17);

  const res = await fieldOperationHandlers.gf_set_choice_text(
    { form_id: 1, field_id: 17, texts: { Concord: NEW_LABEL } }, { fieldManager });

  assert.strictEqual(res.persisted, true);
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.protected_fields_unchanged, true);

  const after = api.snapshotField(17);
  assert.strictEqual(after.choices[0].text, NEW_LABEL);

  // The whole point of the tool: the routing key and the commercial fields on
  // EVERY choice are byte-identical to before, not just the untargeted ones.
  for (let i = 0; i < before.choices.length; i += 1) {
    for (const key of ['value', 'isSelected', 'price', 'inventory_limit']) {
      assert.strictEqual(
        JSON.stringify(after.choices[i][key]), JSON.stringify(before.choices[i][key]),
        `choice ${i} key '${key}' was modified`);
    }
  }
  // Untargeted choices are untouched wholesale, text included.
  assertUnchanged(before.choices[1], after.choices[1], 'the Winston-Salem choice');
  assertUnchanged(before.choices[2], after.choices[2], 'the Raleigh choice');
  // Nothing outside choices moved either.
  assertUnchanged({ ...before, choices: null }, { ...after, choices: null }, 'field 17 outside choices');
});

test('gf_set_choice_text: restoring the original text returns the field byte-identical', async () => {
  const api = makeApi();
  const fieldManager = makeManager(api);
  const original = api.snapshotField(17);

  await fieldOperationHandlers.gf_set_choice_text(
    { form_id: 1, field_id: 17, texts: { Concord: NEW_LABEL } }, { fieldManager });
  await fieldOperationHandlers.gf_set_choice_text(
    { form_id: 1, field_id: 17, texts: { Concord: original.choices[0].text } }, { fieldManager });

  assertUnchanged(original, api.snapshotField(17), 'field 17 after write-then-restore');
});

test('gf_set_choice_text: a key matching no choice value is a loud error and writes nothing', async () => {
  const api = makeApi();
  const fieldManager = makeManager(api);
  const before = api.snapshotField(17);

  await assert.rejects(
    () => fieldOperationHandlers.gf_set_choice_text(
      { form_id: 1, field_id: 17, texts: { Concorde: 'typo' } }, { fieldManager }),
    (err) => {
      // The message has to name the typo AND the valid values, or the caller
      // cannot tell a typo from "this form changed under me".
      assert.match(err.message, /'Concorde'/);
      assert.match(err.message, /'Concord'.*'Winston-Salem'.*'Raleigh'/);
      return true;
    });

  assert.strictEqual(api.calls.replaceForm, 0);
  assertUnchanged(before, api.snapshotField(17), 'field 17 after a rejected call');
});

test('gf_set_choice_text: one bad key rejects the WHOLE batch — no partial write', async () => {
  const api = makeApi();
  const fieldManager = makeManager(api);
  const before = api.snapshotField(17);

  await assert.rejects(() => fieldOperationHandlers.gf_set_choice_text(
    { form_id: 1, field_id: 17, texts: { Concord: NEW_LABEL, Concorde: 'typo' } },
    { fieldManager }), /Concorde/);

  assert.strictEqual(api.calls.replaceForm, 0);
  assertUnchanged(before, api.snapshotField(17), 'field 17 after a partially-bad batch');
});

test('gf_set_choice_text: test_mode is REJECTED, not ignored', async () => {
  // The sibling tools spell the flag test_mode. Ignoring it here would hand a
  // caller a live write while they believed they asked for a preview — the
  // phantom-parameter bug again, just spelled differently.
  const api = makeApi();
  const fieldManager = makeManager(api);
  const before = api.snapshotField(17);

  await assert.rejects(
    () => fieldOperationHandlers.gf_set_choice_text(
      { form_id: 1, field_id: 17, texts: { Concord: NEW_LABEL }, test_mode: true }, { fieldManager }),
    /dry_run.*not.*test_mode/s);

  assert.strictEqual(api.calls.replaceForm, 0, 'a test_mode call wrote');
  assertUnchanged(before, api.snapshotField(17), 'field 17 after a test_mode call');
});

test('gf_set_choice_text: rejects a field with no choices, an empty map, and non-string values', async () => {
  const api = makeApi();
  const fieldManager = makeManager(api);

  await assert.rejects(() => fieldOperationHandlers.gf_set_choice_text(
    { form_id: 1, field_id: 3, texts: { a: 'b' } }, { fieldManager }), /no choices/);
  await assert.rejects(() => fieldOperationHandlers.gf_set_choice_text(
    { form_id: 1, field_id: 17, texts: {} }, { fieldManager }), /empty/);
  await assert.rejects(() => fieldOperationHandlers.gf_set_choice_text(
    { form_id: 1, field_id: 17, texts: { Concord: 42 } }, { fieldManager }), /must be a string/);
  await assert.rejects(() => fieldOperationHandlers.gf_set_choice_text(
    { form_id: 1, field_id: 99, texts: { Concord: 'x' } }, { fieldManager }), /not found/);

  assert.strictEqual(api.calls.replaceForm, 0);
});

test('gf_set_choice_text: duplicate choice values are ambiguous and refused', async () => {
  const fixture = FORM();
  fixture.fields[0].choices.push(
    { text: 'Concord overflow', value: 'Concord', isSelected: false, price: '', inventory_limit: 10 });
  const api = makeApi(fixture);
  const fieldManager = makeManager(api);

  await assert.rejects(() => fieldOperationHandlers.gf_set_choice_text(
    { form_id: 1, field_id: 17, texts: { Concord: 'x' } }, { fieldManager }), /ambiguous/);
  assert.strictEqual(api.calls.replaceForm, 0);
});

test('gf_set_choice_text: an unrelated duplicate value does not block a valid edit', async () => {
  // Only an AMBIGUOUS TARGET should refuse. A duplicate elsewhere on the field
  // is not this call's problem, and blocking on it would make the tool unusable
  // on any form with legacy duplicate values.
  const fixture = FORM();
  fixture.fields[0].choices.push(
    { text: 'Raleigh overflow', value: 'Raleigh', isSelected: false, price: '', inventory_limit: 10 });
  const api = makeApi(fixture);
  const fieldManager = makeManager(api);

  const res = await fieldOperationHandlers.gf_set_choice_text(
    { form_id: 1, field_id: 17, texts: { Concord: NEW_LABEL } }, { fieldManager });
  assert.strictEqual(res.persisted, true);
  assert.strictEqual(api.snapshotField(17).choices[0].text, NEW_LABEL);
});

test('gf_set_choice_text: a no-op text is reported as changed:false, not as an error', async () => {
  const api = makeApi();
  const fieldManager = makeManager(api);
  const same = api.snapshotField(17).choices[0].text;

  const res = await fieldOperationHandlers.gf_set_choice_text(
    { form_id: 1, field_id: 17, texts: { Concord: same } }, { fieldManager });

  assert.strictEqual(res.choices_targeted, 1);
  assert.strictEqual(res.choices_actually_changed, 0);
  assert.strictEqual(res.changes[0].changed, false);
});

test('gf_set_choice_text: carries through add-on keys it has never heard of', async () => {
  const fixture = FORM();
  fixture.fields[0].choices[0].someFutureAddonKey = { nested: [1, 2, 3] };
  const api = makeApi(fixture);
  const fieldManager = makeManager(api);

  await fieldOperationHandlers.gf_set_choice_text(
    { form_id: 1, field_id: 17, texts: { Concord: NEW_LABEL } }, { fieldManager });

  assert.deepStrictEqual(api.snapshotField(17).choices[0].someFutureAddonKey, { nested: [1, 2, 3] });
});

// ===========================================================================
// The phantom-parameter CLASS, not just the instance
// ===========================================================================

test('every schema-declared field-op param is actually read by its handler', () => {
  // The original bug was not "test_mode is broken", it was "a param can be
  // declared and never read". A schema-regenerating refactor can reintroduce
  // that for any param, so assert the general property: each declared property
  // name appears in the handler's source. Crude, but it fails loudly on exactly
  // the drift that shipped, and it costs nothing to run.
  for (const tool of fieldOperationTools) {
    const handler = fieldOperationHandlers[tool.name];
    assert.ok(handler, `${tool.name} is declared in fieldOperationTools but has no handler`);
    const source = handler.toString();
    for (const param of Object.keys(tool.inputSchema?.properties ?? {})) {
      assert.ok(
        new RegExp(`\\b${param}\\b`).test(source),
        `${tool.name} declares '${param}' in its inputSchema but the handler never reads it `
        + '(this is the test_mode phantom-parameter bug — see the file header)');
    }
  }
});
