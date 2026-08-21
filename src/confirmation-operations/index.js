/**
 * Per-entry tools for Gravity Forms confirmations and notifications.
 *
 * WHY THIS MODULE EXISTS
 *   Before this, the only way to change a confirmation or notification was to
 *   pass a whole `confirmations` / `notifications` object to gf_update_form.
 *   That path merges shallowly — `{...existingForm, ...updates}` — so supplying
 *   a map containing only the entry you meant to edit DELETES every other entry
 *   on that form, silently, with a 200 response.
 *
 *   That is not theoretical. A survey of the live AAR sites (2026-08-21) found
 *   six forms carrying two notifications each — ADMIN: Send Email, ADMIN: Send
 *   SMS and HCS 2024 Wait List on both aaru65 and aarlocal. Editing one
 *   notification on any of them via the whole-map path would have destroyed the
 *   other with no warning.
 *
 *   These tools read the current map, change exactly one entry, and write the
 *   full map back. They also report how many entries they preserved, so the
 *   thing that used to fail silently is now visible in every response.
 *
 * WHY NOT FIX gf_update_form's MERGE INSTEAD
 *   Deep-merging there would silently change the meaning of an existing tool:
 *   callers who legitimately want to REPLACE a map (removing an entry by
 *   omission) would quietly stop being able to. Explicit per-entry verbs are
 *   honest about intent — and `delete` remains a thing you have to ask for.
 */

/** Entry maps this module knows how to patch, and their differing sub-shapes. */
const MAPS = {
  confirmation: {
    key: 'confirmations',
    label: 'confirmation',
    // Fields a caller may set. Anything else is refused rather than written
    // blindly into form meta.
    allowed: ['name', 'type', 'message', 'url', 'pageId', 'queryString',
              'disableAutoformat', 'isDefault', 'conditionalLogic', 'event'],
  },
  notification: {
    key: 'notifications',
    label: 'notification',
    allowed: ['name', 'event', 'isActive', 'toType', 'to', 'subject', 'message',
              'from', 'fromName', 'replyTo', 'bcc', 'cc', 'disableAutoformat',
              'attachUploadFields', 'conditionalLogic', 'service'],
  },
};

/** GF generates ids as 13-char lowercase hex. Human-readable keys also occur in
 *  the wild (form 21 on aaru65 uses `waitlist_admin_notify`), so this generates
 *  GF-shaped ids without requiring them. */
function generateEntryId() {
  return (Date.now().toString(16) + Math.random().toString(16).slice(2))
    .replace(/[^0-9a-f]/g, '').slice(0, 13);
}

function readMap(form, kind) {
  const raw = form?.[MAPS[kind].key];
  // GF returns [] rather than {} for an empty map. Normalising here keeps every
  // caller below from having to care.
  if (Array.isArray(raw)) return {};
  return (raw && typeof raw === 'object') ? { ...raw } : {};
}

function summarise(map, kind) {
  return Object.entries(map).map(([id, e]) => ({
    id,
    name: e?.name ?? null,
    ...(kind === 'confirmation'
      ? { type: e?.type ?? null, isDefault: e?.isDefault === true }
      : { event: e?.event ?? null, isActive: e?.isActive !== false,
          to: e?.to ?? null, subject: e?.subject ?? null }),
    hasConditionalLogic: !!(e?.conditionalLogic &&
      (e.conditionalLogic.enabled === true ||
       (Array.isArray(e.conditionalLogic.rules) && e.conditionalLogic.rules.length))),
  }));
}

function rejectUnknownKeys(properties, kind) {
  const allowed = MAPS[kind].allowed;
  const unknown = Object.keys(properties || {}).filter(k => !allowed.includes(k));
  if (unknown.length) {
    throw new Error(
      `Unknown ${MAPS[kind].label} propert${unknown.length > 1 ? 'ies' : 'y'}: ` +
      `${unknown.join(', ')}. Allowed: ${allowed.join(', ')}. ` +
      `Refusing rather than writing an unrecognised key into form meta, where it ` +
      `would persist invisibly and never be read.`);
  }
}

/**
 * Validate a confirmation's shape against what GF actually needs to render it.
 * A confirmation with type:'page' and no pageId saves happily and then shows the
 * user a blank screen on submit — worth catching here rather than in production.
 */
function validateConfirmation(entry, { partial }) {
  const type = entry.type;
  if (type !== undefined && !['message', 'page', 'redirect'].includes(type)) {
    throw new Error(`confirmation type must be 'message', 'page' or 'redirect' (got '${type}')`);
  }
  if (partial) return; // a patch need not restate fields it is not changing
  if (type === 'page' && !entry.pageId) {
    throw new Error("confirmation type 'page' requires pageId (the WordPress page ID to show)");
  }
  if (type === 'redirect' && !entry.url) {
    throw new Error("confirmation type 'redirect' requires url");
  }
  if (type === 'message' && !entry.message) {
    throw new Error("confirmation type 'message' requires message (the HTML shown after submit)");
  }
}

function validateNotification(entry, { partial }) {
  const toType = entry.toType;
  if (toType !== undefined && !['email', 'field', 'routing', 'hidden'].includes(toType)) {
    throw new Error(`notification toType must be 'email', 'field' or 'routing' (got '${toType}')`);
  }
  if (partial) return;
  if (!entry.event) {
    throw new Error("notification requires event (normally 'form_submission')");
  }
  if (!entry.to && toType !== 'routing') {
    throw new Error(
      "notification requires `to`. For toType 'email' that is an address or " +
      "{admin_email}; for toType 'field' it is the ID of an email field on the form.");
  }
  if (!entry.subject) throw new Error('notification requires subject');
  if (!entry.message) throw new Error('notification requires message');
}

const VALIDATORS = { confirmation: validateConfirmation, notification: validateNotification };

/**
 * The one code path all six write tools share: read the form, change exactly one
 * key of one map, write the whole form back, then verify by re-reading.
 */
async function mutateEntry(client, { kind, formId, entryId, properties, mode, dryRun }) {
  const spec = MAPS[kind];
  const { form } = await client.getForm({ id: formId });
  if (!form) throw new Error(`form ${formId} not found`);

  const before = readMap(form, kind);
  const beforeIds = Object.keys(before);
  const exists = Object.prototype.hasOwnProperty.call(before, entryId ?? '');

  if (mode === 'update' && !exists) {
    throw new Error(
      `No ${spec.label} '${entryId}' on form ${formId}. Present: ` +
      `${beforeIds.length ? beforeIds.join(', ') : '(none)'}. ` +
      `Use gf_list_${spec.key} to see ids, or gf_add_${spec.label} to create one.`);
  }
  if (mode === 'add' && exists) {
    throw new Error(`A ${spec.label} '${entryId}' already exists on form ${formId}. ` +
                    `Use gf_update_${spec.label} to change it.`);
  }
  if (mode === 'delete' && !exists) {
    throw new Error(`No ${spec.label} '${entryId}' on form ${formId} to delete.`);
  }

  const after = { ...before };

  if (mode === 'delete') {
    // A form with zero confirmations shows the submitter nothing at all, and GF
    // treats the isDefault entry as the fallback when no conditional branch
    // matches. Removing either is a footgun rather than an edit.
    if (kind === 'confirmation') {
      if (beforeIds.length === 1) {
        throw new Error(
          `Refusing to delete the only confirmation on form ${formId}. A form with ` +
          `no confirmation shows the submitter a blank page. Edit this one instead, ` +
          `or add a replacement first.`);
      }
      if (before[entryId]?.isDefault === true) {
        throw new Error(
          `Refusing to delete the DEFAULT confirmation on form ${formId}. GF falls ` +
          `back to it when no conditional branch matches; without one, a submission ` +
          `that matches nothing displays nothing. Promote another entry with ` +
          `gf_update_confirmation(isDefault:true) first.`);
      }
    }
    delete after[entryId];
  } else {
    rejectUnknownKeys(properties, kind);
    const merged = mode === 'add'
      ? { ...properties, id: entryId }
      // Patch: keep every field the caller did not mention. This is the whole
      // point of the module — at the entry level as well as the map level.
      : { ...before[entryId], ...properties, id: entryId };
    VALIDATORS[kind](merged, { partial: false });

    // Exactly one confirmation may be the default. Promoting one demotes the
    // rest here rather than leaving GF with two and letting it pick.
    if (kind === 'confirmation' && merged.isDefault === true) {
      for (const k of Object.keys(after)) {
        if (k !== entryId && after[k]?.isDefault) after[k] = { ...after[k], isDefault: false };
      }
    }
    after[entryId] = merged;
  }

  const preserved = Object.keys(after).filter(k => k !== entryId);
  const plan = {
    form_id: formId,
    kind: spec.label,
    mode,
    entry_id: entryId,
    entries_before: summarise(before, kind),
    entries_after: summarise(after, kind),
    preserved_entries: preserved,
    preserved_count: preserved.length,
  };

  if (dryRun) {
    return {
      success: true, dry_run: true, persisted: false, db_write_attempted: false,
      ...plan,
      note: 'Nothing was written. Re-send with dry_run:false to apply.',
    };
  }

  // Write the FULL form with the FULL map. Never a partial map — that is the bug
  // this module exists to prevent.
  await client.replaceForm(formId, { ...form, [spec.key]: after });

  // Verify by re-read. A 200 from GF proves a form was saved, not that this
  // entry holds what was asked for.
  const { form: reread } = await client.getForm({ id: formId });
  const finalMap = readMap(reread, kind);
  const finalIds = Object.keys(finalMap);
  const lost = Object.keys(after).filter(k => !finalIds.includes(k));
  const landed = mode === 'delete'
    ? !finalIds.includes(entryId)
    : finalIds.includes(entryId);

  const result = {
    success: landed && lost.length === 0,
    dry_run: false,
    persisted: landed,
    db_write_attempted: true,
    ...plan,
    entries_after_reread: summarise(finalMap, kind),
    integrity: {
      verified_by_reread: landed,
      entries_lost: lost,
      count_before: beforeIds.length,
      count_after: finalIds.length,
    },
  };

  if (lost.length) {
    result.ATTENTION = `Entries present in the payload are missing after re-read: ` +
      `${lost.join(', ')}. Check the form in wp-admin before doing anything else.`;
  }
  if (!landed) {
    result.ATTENTION = `The ${spec.label} did not ${mode === 'delete' ? 'go away' : 'land'} ` +
      `after write. Treat this call as failed.`;
  }
  return result;
}

async function listEntries(client, kind, formId) {
  const { form } = await client.getForm({ id: formId });
  if (!form) throw new Error(`form ${formId} not found`);
  const map = readMap(form, kind);
  const entries = summarise(map, kind);
  return {
    success: true,
    form_id: formId,
    form_title: form.title,
    [MAPS[kind].key]: entries,
    count: entries.length,
    ...(entries.length > 1 ? {
      note: `${entries.length} entries. Editing any one of them through ` +
            `gf_update_form's whole-map argument would DELETE the others — use the ` +
            `per-entry tools.`,
    } : {}),
  };
}

export const confirmationOperationHandlers = {
  async gf_list_confirmations(params, client) {
    return listEntries(client, 'confirmation', params.form_id);
  },
  async gf_list_notifications(params, client) {
    return listEntries(client, 'notification', params.form_id);
  },

  async gf_update_confirmation(params, client) {
    const { form_id, confirmation_id, properties = {}, dry_run = false } = params;
    return mutateEntry(client, { kind: 'confirmation', formId: form_id,
      entryId: confirmation_id, properties, mode: 'update', dryRun: dry_run });
  },
  async gf_add_confirmation(params, client) {
    const { form_id, properties = {}, confirmation_id, dry_run = false } = params;
    return mutateEntry(client, { kind: 'confirmation', formId: form_id,
      entryId: confirmation_id || generateEntryId(), properties, mode: 'add',
      dryRun: dry_run });
  },
  async gf_delete_confirmation(params, client) {
    const { form_id, confirmation_id, dry_run = false } = params;
    return mutateEntry(client, { kind: 'confirmation', formId: form_id,
      entryId: confirmation_id, mode: 'delete', dryRun: dry_run });
  },

  async gf_update_notification(params, client) {
    const { form_id, notification_id, properties = {}, dry_run = false } = params;
    return mutateEntry(client, { kind: 'notification', formId: form_id,
      entryId: notification_id, properties, mode: 'update', dryRun: dry_run });
  },
  async gf_add_notification(params, client) {
    const { form_id, properties = {}, notification_id, dry_run = false } = params;
    return mutateEntry(client, { kind: 'notification', formId: form_id,
      entryId: notification_id || generateEntryId(), properties, mode: 'add',
      dryRun: dry_run });
  },
  async gf_delete_notification(params, client) {
    const { form_id, notification_id, dry_run = false } = params;
    return mutateEntry(client, { kind: 'notification', formId: form_id,
      entryId: notification_id, mode: 'delete', dryRun: dry_run });
  },
};

// ---------------------------------------------------------------------------
// Tool definitions.
//
// The descriptions carry the semantic guide deliberately. An MCP client strips
// arguments absent from inputSchema (the markupVersion bug), so every field a
// caller may need MUST be declared here — and since the schema is the only thing
// the model sees at call time, the domain knowledge has to live here too, not in
// a README nobody loads.
// ---------------------------------------------------------------------------

const MERGE_TAGS =
  'MERGE TAGS work in message/subject/to: {all_fields} (the whole submission), ' +
  '{form_title}, {entry_id}, {admin_email}, {date_mdy}, and per-field ' +
  '{Field Label:ID} — e.g. {Email:5}. Field IDs come from gf_get_form.';

const CONDITIONAL_LOGIC =
  'conditionalLogic shape: {actionType:"show", logicType:"all"|"any", rules:[' +
  '{fieldId:"5", operator:"is"|"isnot"|"greater_than"|"less_than"|"contains"|' +
  '"starts_with"|"ends_with", value:"..."}]}. Pass null or {} to clear it. ' +
  'ORDER MATTERS: GF evaluates entries as an if/else chain and the FIRST match ' +
  'wins, with the default entry as the fallback.';

const dryRunProp = {
  type: 'boolean',
  default: false,
  description: 'Preview the before/after entry lists and write nothing. The write '
    + 'sits inside the non-dry branch, not behind a post-hoc check.',
};

export const confirmationOperationTools = [
  {
    name: 'gf_list_confirmations',
    description:
      'List a form\'s confirmations — what the submitter sees after submitting. '
      + 'Read-only. Returns each entry\'s id, name, type, isDefault and whether it '
      + 'has conditional logic. Call this before any edit: the ids are what the '
      + 'update and delete tools take, and they are not guessable.',
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: { form_id: { type: 'number', description: 'Form ID' } },
      required: ['form_id'],
    },
  },
  {
    name: 'gf_update_confirmation',
    description:
      'Change ONE confirmation on a form, leaving every other confirmation intact.\n'
      + '\n'
      + 'USE THIS INSTEAD OF gf_update_form for confirmation edits. Passing a '
      + '`confirmations` object to gf_update_form replaces the WHOLE map and '
      + 'silently deletes every entry you did not include.\n'
      + '\n'
      + 'Only the properties you pass change; the rest of the entry is preserved. '
      + 'The response reports preserved_entries so you can see nothing was lost.\n'
      + '\n'
      + 'THE THREE CONFIRMATION TYPES:\n'
      + '  type:"message"  — show HTML inline. Requires `message`. Set '
      + 'disableAutoformat:true when supplying real HTML, or GF inserts <br> at '
      + 'every newline and wrecks the markup.\n'
      + '  type:"page"     — show an existing WordPress page. Requires `pageId`. '
      + '`queryString` passes data through, e.g. key={Auth Key (Hidden):11}.\n'
      + '  type:"redirect" — send to a URL. Requires `url`.\n'
      + '\n'
      + 'isDefault:true promotes this entry to the fallback and demotes the others '
      + 'automatically — exactly one confirmation may be the default.\n'
      + '\n' + CONDITIONAL_LOGIC + '\n\n' + MERGE_TAGS,
    annotations: { idempotentHint: true, destructiveHint: false, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        form_id: { type: 'number', description: 'Form ID' },
        confirmation_id: { type: 'string', description: 'Entry id from gf_list_confirmations' },
        properties: {
          type: 'object',
          description: 'Only the fields to change.',
          properties: {
            name: { type: 'string', description: 'Admin-facing label' },
            type: { type: 'string', enum: ['message', 'page', 'redirect'] },
            message: { type: 'string', description: 'HTML shown for type "message"' },
            url: { type: 'string', description: 'Destination for type "redirect"' },
            pageId: { type: 'number', description: 'WordPress page ID for type "page"' },
            queryString: { type: 'string', description: 'Query string appended for type page/redirect' },
            disableAutoformat: { type: 'boolean', description: 'true when message is real HTML' },
            isDefault: { type: 'boolean', description: 'Make this the fallback; demotes the others' },
            conditionalLogic: { type: 'object', description: 'See the tool description' },
          },
        },
        dry_run: dryRunProp,
      },
      required: ['form_id', 'confirmation_id'],
    },
  },
  {
    name: 'gf_add_confirmation',
    description:
      'Add a NEW confirmation to a form without disturbing the existing ones. '
      + 'Typically used to create a conditional branch: give the new entry '
      + 'conditionalLogic so it fires for some submissions, and leave the existing '
      + 'default as the fallback. GF evaluates entries in order, first match wins.\n'
      + '\n'
      + 'Supply the type\'s required field: `message` for type "message", `pageId` '
      + 'for "page", `url` for "redirect" — this is validated before writing.\n'
      + '\n' + CONDITIONAL_LOGIC + '\n\n' + MERGE_TAGS,
    annotations: { idempotentHint: false, destructiveHint: false, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        form_id: { type: 'number', description: 'Form ID' },
        confirmation_id: { type: 'string', description: 'Optional explicit id. Omit to generate a GF-shaped one.' },
        properties: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            type: { type: 'string', enum: ['message', 'page', 'redirect'] },
            message: { type: 'string' },
            url: { type: 'string' },
            pageId: { type: 'number' },
            queryString: { type: 'string' },
            disableAutoformat: { type: 'boolean' },
            isDefault: { type: 'boolean' },
            conditionalLogic: { type: 'object' },
          },
          required: ['name', 'type'],
        },
        dry_run: dryRunProp,
      },
      required: ['form_id', 'properties'],
    },
  },
  {
    name: 'gf_delete_confirmation',
    description:
      'Remove ONE confirmation, leaving the others intact.\n'
      + '\n'
      + 'Refuses two cases on purpose: deleting the only confirmation on a form '
      + '(the submitter would see a blank page), and deleting the isDefault entry '
      + '(GF falls back to it when no conditional branch matches). Promote another '
      + 'entry with gf_update_confirmation(isDefault:true) first.',
    annotations: { idempotentHint: true, destructiveHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        form_id: { type: 'number', description: 'Form ID' },
        confirmation_id: { type: 'string', description: 'Entry id from gf_list_confirmations' },
        dry_run: dryRunProp,
      },
      required: ['form_id', 'confirmation_id'],
    },
  },
  {
    name: 'gf_list_notifications',
    description:
      'List a form\'s notifications — the emails GF sends on submission. '
      + 'Read-only. Returns id, name, event, isActive, to, subject and whether the '
      + 'entry has conditional logic.\n'
      + '\n'
      + 'Call this first: six live AAR forms carry TWO notifications each, and the '
      + 'ids are not guessable.\n'
      + '\n'
      + 'Not to be confused with gf_send_notifications, which FIRES notifications '
      + 'for an existing entry and changes no configuration.',
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: { form_id: { type: 'number', description: 'Form ID' } },
      required: ['form_id'],
    },
  },
  {
    name: 'gf_update_notification',
    description:
      'Change ONE notification email, leaving every other notification intact.\n'
      + '\n'
      + 'USE THIS INSTEAD OF gf_update_form for notification edits. Passing a '
      + '`notifications` object to gf_update_form replaces the WHOLE map and '
      + 'silently deletes the entries you did not include — a real risk here, '
      + 'since several live forms carry two.\n'
      + '\n'
      + 'ADDRESSING (toType decides what `to` means):\n'
      + '  toType:"email"   — `to` is a literal address, or {admin_email}. Comma-'
      + 'separate multiple.\n'
      + '  toType:"field"   — `to` is the ID of an email field on the form, so the '
      + 'notification goes to whoever submitted it.\n'
      + '  toType:"routing" — conditional per-recipient routing; GF stores it '
      + 'separately and this tool does not construct it.\n'
      + '\n'
      + 'isActive:false disables an email without deleting it — the reversible way '
      + 'to stop a notification going out.\n'
      + '\n'
      + 'from/fromName affect deliverability: a From address on a domain the site '
      + 'is not authorised to send for gets filtered. Leaving from as {admin_email} '
      + 'is usually right; use replyTo for the address you want humans to answer.\n'
      + '\n' + CONDITIONAL_LOGIC + '\n\n' + MERGE_TAGS,
    annotations: { idempotentHint: true, destructiveHint: false, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        form_id: { type: 'number', description: 'Form ID' },
        notification_id: { type: 'string', description: 'Entry id from gf_list_notifications' },
        properties: {
          type: 'object',
          description: 'Only the fields to change.',
          properties: {
            name: { type: 'string', description: 'Admin-facing label' },
            event: { type: 'string', description: 'Normally "form_submission". Add-ons register others.' },
            isActive: { type: 'boolean', description: 'false disables without deleting' },
            toType: { type: 'string', enum: ['email', 'field', 'routing'] },
            to: { type: 'string', description: 'Address, {admin_email}, or a field ID — see toType' },
            subject: { type: 'string' },
            message: { type: 'string', description: 'Body. {all_fields} prints the whole submission.' },
            from: { type: 'string' },
            fromName: { type: 'string' },
            replyTo: { type: 'string' },
            cc: { type: 'string' },
            bcc: { type: 'string' },
            disableAutoformat: { type: 'boolean', description: 'true when message is real HTML' },
            conditionalLogic: { type: 'object', description: 'See the tool description' },
          },
        },
        dry_run: dryRunProp,
      },
      required: ['form_id', 'notification_id'],
    },
  },
  {
    name: 'gf_add_notification',
    description:
      'Add a NEW notification email to a form without disturbing the existing ones.\n'
      + '\n'
      + 'Requires name, event (normally "form_submission"), toType, to, subject and '
      + 'message — validated before writing, because GF will happily save a '
      + 'notification with no recipient and then never send it.\n'
      + '\n'
      + 'Give it conditionalLogic to send only for some submissions.\n'
      + '\n' + CONDITIONAL_LOGIC + '\n\n' + MERGE_TAGS,
    annotations: { idempotentHint: false, destructiveHint: false, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        form_id: { type: 'number', description: 'Form ID' },
        notification_id: { type: 'string', description: 'Optional explicit id. Omit to generate a GF-shaped one.' },
        properties: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            event: { type: 'string', default: 'form_submission' },
            isActive: { type: 'boolean', default: true },
            toType: { type: 'string', enum: ['email', 'field', 'routing'] },
            to: { type: 'string' },
            subject: { type: 'string' },
            message: { type: 'string' },
            from: { type: 'string' },
            fromName: { type: 'string' },
            replyTo: { type: 'string' },
            cc: { type: 'string' },
            bcc: { type: 'string' },
            disableAutoformat: { type: 'boolean' },
            conditionalLogic: { type: 'object' },
          },
          required: ['name', 'event', 'toType', 'to', 'subject', 'message'],
        },
        dry_run: dryRunProp,
      },
      required: ['form_id', 'properties'],
    },
  },
  {
    name: 'gf_delete_notification',
    description:
      'Remove ONE notification, leaving the others intact.\n'
      + '\n'
      + 'Prefer gf_update_notification(isActive:false) when the intent is "stop '
      + 'sending this" — that is reversible and keeps the wording, recipients and '
      + 'conditional logic for later. Delete when the entry is genuinely obsolete.',
    annotations: { idempotentHint: true, destructiveHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        form_id: { type: 'number', description: 'Form ID' },
        notification_id: { type: 'string', description: 'Entry id from gf_list_notifications' },
        dry_run: dryRunProp,
      },
      required: ['form_id', 'notification_id'],
    },
  },
];
