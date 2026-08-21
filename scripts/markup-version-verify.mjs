#!/usr/bin/env node
/**
 * Acceptance run for the markupVersion fix (TICKET-gf-markup-version-passthrough).
 *
 * Covers the ticket's test plan:
 *   1. gf_create_form(markupVersion:1)  -> reads back 1
 *   2. gf_update_form(markupVersion:1)  -> reads back 1 on a v2 form
 *   3. gf_update_form(markupVersion:9)  -> rejected, no write
 *   4. regression: title-only update leaves fields/notifications/confirmations
 *      intact AND does not disturb markupVersion
 *   5. the read-back verifier reports `unapplied` when GF ignores a value
 *
 * Creates its own scratch form and trashes it. Pass --keep to leave it behind.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = resolve(HERE, '../src/index.js');
const SITE = process.env.PROBE_SITE || 'aaru65';

const client = new Client({ name: 'markup-verify', version: '1.0.0' }, { capabilities: {} });
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  const text = r?.content?.[0]?.text ?? '';
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { isError: r?.isError === true, parsed, text };
};
const mv = (r) => r?.parsed?.form?.markupVersion ?? r?.parsed?.markupVersion;

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  ok ? pass++ : fail++;
};

await client.connect(new StdioClientTransport({ command: process.execPath, args: [ENTRY] }));

// 1 — create with legacy markup
const created = await call('gf_create_form', {
  site: SITE,
  title: 'ZZ markupVersion verify — safe to delete',
  description: 'Acceptance run. Not embedded anywhere.',
  fields: [{ type: 'text', label: 'Scratch' }],
  markupVersion: 1,
});
const id = created.parsed?.form?.id;
console.log(`\nscratch form id=${id}`);
check('create honours markupVersion:1', String(mv(created)) === '1', `got ${mv(created)}`);

// 2 — flip an existing form to legacy
await call('gf_update_form', { site: SITE, id, markupVersion: 2 });
const flipped = await call('gf_update_form', { site: SITE, id, markupVersion: 1 });
check('update honours markupVersion:1', String(mv(flipped)) === '1', `got ${mv(flipped)}`);
check('no spurious unapplied warning on a good write',
      !flipped.parsed?.unapplied, JSON.stringify(flipped.parsed?.unapplied ?? null));

// 3 — invalid value must be refused, and must not write
const bad = await call('gf_update_form', { site: SITE, id, markupVersion: 9 });
const after = await call('gf_get_form', { site: SITE, id });
check('markupVersion:9 rejected', bad.isError || /must be 1/.test(bad.text),
      bad.text.slice(0, 80));
check('rejected call wrote nothing', String(mv(after)) === '1', `still ${mv(after)}`);

// 4 — regression: a title-only update must not disturb anything else
const beforeForm = after.parsed?.form ?? after.parsed;
const titled = await call('gf_update_form', { site: SITE, id, title: 'ZZ renamed' });
const t = titled.parsed?.form ?? {};
check('title-only update leaves markupVersion alone', String(t.markupVersion) === '1',
      `got ${t.markupVersion}`);
check('title-only update preserves fields',
      (t.fields?.length ?? 0) === (beforeForm?.fields?.length ?? 0),
      `${beforeForm?.fields?.length} -> ${t.fields?.length}`);
check('title-only update preserves confirmations',
      Object.keys(t.confirmations ?? {}).length ===
      Object.keys(beforeForm?.confirmations ?? {}).length);

// 5 — the verifier must SPEAK UP when GF ignores a value. `date_created` is
//     read-only in GF, so it is a reliable way to provoke a genuine no-op.
const ignored = await call('gf_update_form', {
  site: SITE, id, date_created: '2001-01-01 00:00:00',
});
check('read-back verifier flags a value GF ignored',
      Array.isArray(ignored.parsed?.unapplied) &&
      ignored.parsed.unapplied.some(u => u.key === 'date_created'),
      JSON.stringify(ignored.parsed?.unapplied ?? null));

// cleanup
if (!process.argv.includes('--keep')) {
  const del = await call('gf_delete_form', { site: SITE, id });
  console.log(`\ncleanup: ${del.isError ? 'FAILED (ALLOW_DELETE off?) — trash form ' + id + ' by hand' : 'form ' + id + ' trashed'}`);
} else {
  console.log(`\n--keep: form ${id} left in place`);
}

console.log(`\n${pass} passed, ${fail} failed`);
await client.close();
process.exit(fail ? 1 : 0);
