#!/usr/bin/env node
/**
 * Which layer discards `markupVersion` on gf_update_form?
 *
 * Established so far:
 *   - A correctly OAuth1-signed PUT straight to GF sets it and it PERSISTS.
 *     So Gravity Forms accepts the key; GF is not the culprit.
 *   - Nothing in src/ whitelists keys. validateFormData does {...formData} and
 *     updateForm merges {...existingForm, ...updates}. So IF the key reaches the
 *     server, it reaches GF.
 *
 * Those two facts only reconcile if the key is stripped BEFORE the server —
 * i.e. by the MCP client, because markupVersion is absent from the declared
 * inputSchema. This script calls the server over stdio with no such client in
 * the path. If the value lands, that hypothesis is confirmed and the fix is
 * simply to declare the parameter.
 *
 * Scratch form only. Pass the form id as argv[2].
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = resolve(HERE, '../src/index.js');
const SITE = 'aaru65';
const FORM_ID = Number(process.argv[2]);

if (!Number.isInteger(FORM_ID)) {
  console.error('usage: markup-version-probe.mjs <scratch-form-id>');
  process.exit(2);
}

const client = new Client({ name: 'markup-version-probe', version: '1.0.0' },
                          { capabilities: {} });

const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  const text = r?.content?.[0]?.text ?? '';
  try { return JSON.parse(text); } catch { return text; }
};

await client.connect(new StdioClientTransport({ command: process.execPath, args: [ENTRY] }));

const before = await call('gf_get_form', { site: SITE, id: FORM_ID });
const mvBefore = before?.form?.markupVersion ?? before?.markupVersion;
console.log(`before        markupVersion=${mvBefore}`);

// Flip to whichever it currently is not, so a no-op cannot masquerade as success.
const target = String(mvBefore) === '1' ? 2 : 1;
console.log(`sending       markupVersion=${target} via stdio (no MCP client in path)`);
await call('gf_update_form', { site: SITE, id: FORM_ID, markupVersion: target });

const after = await call('gf_get_form', { site: SITE, id: FORM_ID });
const mvAfter = after?.form?.markupVersion ?? after?.markupVersion;
console.log(`after         markupVersion=${mvAfter}`);
console.log();
console.log(String(mvAfter) === String(target)
  ? 'CONFIRMED: the server passes it through. The MCP CLIENT strips undeclared\n'
    + 'keys. Declaring markupVersion in the inputSchema is the whole fix.'
  : 'NOT the client. The key is lost inside the server despite passthrough —\n'
    + 'look at updateForm merge order and the httpClient PUT body.');

await client.close();
