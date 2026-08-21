#!/usr/bin/env node
/**
 * Do dynamic field keys survive the trip to the server?
 *
 * TICKET items #2 and #3: gf_submit_form_data(input_1=…) and
 * gf_update_entry("1"=…) both report the values never arrived — one loudly
 * ("This field is required"), one as a clean 200 over a no-op.
 *
 * Both tools declare `additionalProperties: true`, so the SCHEMA permits the
 * extra keys. That is what makes this worth testing rather than assuming: the
 * markupVersion bug this morning involved keys with no schema entry at all, and
 * an explicit additionalProperties:true may well be honoured where absence was
 * not.
 *
 * This runs over stdio — no MCP client in the path. If the values land here,
 * the server is fine and the client is stripping them. If they do not land
 * here, the bug is server-side and the client is innocent.
 *
 * Writes to entry 2357 on form 21 (aaru65) — the blank row the ticket already
 * left behind, so nothing of value is at risk. Read-only against everything else.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = resolve(HERE, '../src/index.js');
const SITE = 'aaru65';
const ENTRY_ID = Number(process.argv[2] || 2357);

const client = new Client({ name: 'dyn-key-probe', version: '1.0.0' }, { capabilities: {} });
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  const t = r?.content?.[0]?.text ?? '';
  let parsed; try { parsed = JSON.parse(t); } catch { parsed = t; }
  return { isError: r?.isError === true, parsed, text: t };
};

await client.connect(new StdioClientTransport({ command: process.execPath, args: [ENTRY] }));

const marker = `ZZ-stdio-${Date.now().toString().slice(-6)}`;

console.log(`\n=== gf_update_entry over stdio, entry ${ENTRY_ID} ===`);
const before = await call('gf_get_entry', { site: SITE, id: ENTRY_ID });
const b = before.parsed?.entry ?? before.parsed;
console.log(`  before  field "1" = ${JSON.stringify(b?.['1'])}`);

const upd = await call('gf_update_entry', { site: SITE, id: ENTRY_ID, '1': marker });
console.log(`  update  isError=${upd.isError}  ${upd.text.slice(0, 120)}`);

const after = await call('gf_get_entry', { site: SITE, id: ENTRY_ID });
const a = after.parsed?.entry ?? after.parsed;
console.log(`  after   field "1" = ${JSON.stringify(a?.['1'])}`);

const landed = a?.['1'] === marker;
console.log();
console.log(landed
  ? 'VERDICT: values DO reach the server over stdio.\n'
    + '         The server is fine; the MCP CLIENT is stripping dynamic keys\n'
    + '         despite additionalProperties:true. Fix = a DECLARED object param.'
  : 'VERDICT: values do NOT land even over stdio.\n'
    + '         The bug is server-side — look at how updateEntry builds its PUT body.');

await client.close();
