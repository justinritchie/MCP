/**
 * GravityCharts tasks — can a SMALL model create, configure, and manage
 * *meaningful* charts through the GravityCharts abilities (gc_*)?
 *
 * The suite covers the full surface, not just the happy path:
 *   - discovery (chart types)
 *   - creation: bare, count-per-category, pie, horizontal, custom color/label
 *   - aggregation: sum of a numeric field per category
 *   - mutation: chart-patch type change
 *   - roundtrip: create → chart-get returns the canonical dataset shape
 *   - errors: invalid form id, unsupported chart type (honest failure, no junk)
 *   - delete: idempotent double-delete
 *
 * Graders read GROUND TRUTH (charts-list / chart-get / chart-data-get), never
 * the agent's self-report. Expected values were verified empirically against
 * the real API (see the shapes in each grader's comments).
 */

import { uniqueLabel } from './helpers.mjs';

const STATUS_FIELD = 4; // 'Status' select: Open / Closed / Pending.
const AMOUNT_FIELD = 5; // 'Amount' number field (aggregation fixtures).

/** Form fields for chart fixtures: the default Status select + a numeric Amount. */
const CHART_FORM_FIELDS = [
  { id: 1, type: 'text', label: 'First Name' },
  {
    id: STATUS_FIELD,
    type: 'select',
    label: 'Status',
    choices: [
      { text: 'Open', value: 'open' },
      { text: 'Closed', value: 'closed' },
      { text: 'Pending', value: 'pending' },
    ],
  },
  { id: AMOUNT_FIELD, type: 'number', label: 'Amount' },
];

/** Seed entries with known Status counts AND Amount sums:
 *  counts → Open 3, Closed 2, Pending 1 (total 6)
 *  sums   → Open 60, Closed 20, Pending 7 */
const SEED_ENTRIES = [
  ['open', 10], ['open', 20], ['open', 30],
  ['closed', 5], ['closed', 15],
  ['pending', 7],
];
const EXPECTED_COUNTS = { Open: 3, Closed: 2, Pending: 1 };
const EXPECTED_SUMS = { Open: 60, Closed: 20, Pending: 7 };

async function seedChartForm(client, label) {
  const form = await client.createForm(uniqueLabel(label), CHART_FORM_FIELDS);
  for (const [status, amount] of SEED_ENTRIES) {
    await client.createEntry(form.id, { [STATUS_FIELD]: status, [AMOUNT_FIELD]: amount });
  }
  return form;
}

/** client.ability() returns { status, data }; charts-list data is { charts: [ {id,name,form,type,is_active} ] }. */
async function findChart(client, formId) {
  const { data } = await client.ability('gk-gravitycharts/charts-list', { form_id: formId });
  const list = data?.charts || [];
  return list[list.length - 1] || null; // most-recently-created
}

async function chartCount(client, formId) {
  const { data } = await client.ability('gk-gravitycharts/charts-list', { form_id: formId });
  return (data?.charts || []).length;
}

/** chart-get data is { id, form_id, is_active, meta } — the raw stored feed config. */
async function storedChart(client, feedId) {
  const { data } = await client.ability('gk-gravitycharts/chart-get', { feed_id: feedId });
  return data || {};
}

/** chart-data-get data is the rendered Chart.js shape { type, data: { labels, datasets }, options }.
 *  Data points are objects like {value,label,x} (or bare numbers) — normalize both. */
async function renderedChart(client, feedId) {
  const { data } = await client.ability('gk-gravitycharts/chart-data-get', { feed_id: feedId });
  const type = data?.type || '';
  const chartData = data?.data || {};
  const labels = chartData?.labels || [];
  const datasets = chartData?.datasets || [];
  const pointValue = (p) => (typeof p === 'number' ? p : (p?.value ?? p?.y ?? (Array.isArray(p) ? p[1] : NaN)));
  const values = datasets.flatMap((d) => (Array.isArray(d?.data) ? d.data : [])).map(pointValue).map(Number).filter((n) => Number.isFinite(n));
  return { type, labels, datasets, values, options: data?.options || {}, raw: data };
}

/** Order-agnostic label→value map from the rendered first dataset.
 *  Use the AXIS label (r.labels[i]) — a point's own `label` is the formatted
 *  VALUE on aggregated charts (e.g. "60" for a sum), not the category. */
function labelValueMap(r) {
  const map = {};
  const points = Array.isArray(r.datasets?.[0]?.data) ? r.datasets[0].data : [];
  points.forEach((p, i) => {
    const label = r.labels?.[i] ?? (p && typeof p === 'object' ? p.label : undefined);
    const value = typeof p === 'number' ? p : (p?.value ?? p?.y);
    if (label !== undefined) map[String(label)] = Number(value);
  });
  return map;
}

function mapsEqual(actual, expected) {
  const keys = Object.keys(expected);
  return keys.length === Object.keys(actual).length && keys.every((k) => actual[k] === expected[k]);
}

const agentErrors = (t) => (t.toolCalls || []).filter((c) => c.isError).map((c) => c.errorCode || (c.text || '').slice(0, 60)).filter(Boolean);

export default [
  // ── Discovery ────────────────────────────────────────────────────────────

  {
    id: 'charts.discover-types',
    category: 'charts',
    expectedTurns: 2,
    maxTurns: 8,
    prompt: 'What chart types can GravityCharts create on this site? List them.',
    async grade({ telemetry }) {
      const called = (telemetry.toolCalls || []).some((c) => /chart[_-]?types[_-]?list/i.test(c.name || '') && !c.isError);
      const named = /\b(bar|line|pie|table)\b/i.test(telemetry.finalText || '');
      return { pass: called && named, detail: called ? (named ? '' : 'listed types but named none in the answer') : 'never cleanly called chart-types-list' };
    },
  },

  // ── Creation ─────────────────────────────────────────────────────────────

  {
    id: 'charts.create-basic-bar',
    category: 'charts',
    expectedTurns: 3,
    maxTurns: 12,
    async setup(client) {
      const form = await client.createForm(uniqueLabel('GC Bench Form'));
      return { formId: form.id, name: uniqueLabel('GC Basic Bar') };
    },
    prompt: (s) => `On Gravity Forms form ${s.formId}, create a bar chart named "${s.name}" using GravityCharts.`,
    async grade({ client, state, telemetry }) {
      const chart = await findChart(client, state.formId);
      if (!chart) return { pass: false, detail: `no chart feed created on form ${state.formId}; errors: ${agentErrors(telemetry).join(', ') || 'none'}` };
      const isBar = /bar/i.test(chart.type || '');
      return { pass: isBar, detail: isBar ? '' : `created a chart but type="${chart.type || '?'}" (wanted bar)` };
    },
    async teardown({ client, state }) {
      if (state.formId) await client.deleteForm(state.formId); // cascades its feeds
    },
  },

  {
    id: 'charts.count-per-category',
    category: 'charts',
    expectedTurns: 5,
    maxTurns: 18,
    async setup(client) {
      const form = await seedChartForm(client, 'GC Bench Form');
      return { formId: form.id, name: uniqueLabel('GC Status Bar') };
    },
    prompt: (s) =>
      `On Gravity Forms form ${s.formId}, create a bar chart named "${s.name}" that shows how many entries there are ` +
      `for each value of the "Status" field (the choices are Open, Closed, and Pending). The chart should count entries per status.`,
    async grade({ client, state, telemetry }) {
      const chart = await findChart(client, state.formId);
      if (!chart) return { pass: false, detail: `no chart feed created; errors: ${agentErrors(telemetry).join(', ') || 'none'}` };
      const r = await renderedChart(client, chart.id);
      const counts = labelValueMap(r);
      const exact = mapsEqual(counts, EXPECTED_COUNTS);
      const pass = /bar/i.test(r.type || chart.type || '') && exact;
      return { pass, detail: pass ? '' : `type=${r.type || '?'} rendered=${JSON.stringify(counts)} — wanted exact counts ${JSON.stringify(EXPECTED_COUNTS)}` };
    },
    async teardown({ client, state }) {
      if (state.formId) await client.deleteForm(state.formId);
    },
  },

  {
    id: 'charts.create-pie',
    category: 'charts',
    expectedTurns: 4,
    maxTurns: 15,
    async setup(client) {
      const form = await seedChartForm(client, 'GC Bench Form');
      return { formId: form.id, name: uniqueLabel('GC Status Pie') };
    },
    prompt: (s) =>
      `On Gravity Forms form ${s.formId}, create a pie chart named "${s.name}" showing the proportion of entries in each Status.`,
    async grade({ client, state, telemetry }) {
      const chart = await findChart(client, state.formId);
      if (!chart) return { pass: false, detail: `no chart feed created; errors: ${agentErrors(telemetry).join(', ') || 'none'}` };
      const r = await renderedChart(client, chart.id);
      const counts = labelValueMap(r);
      const pass = /pie/i.test(r.type || chart.type || '') && mapsEqual(counts, EXPECTED_COUNTS);
      return { pass, detail: pass ? '' : `type=${r.type || '?'} rendered=${JSON.stringify(counts)} — wanted a pie with counts ${JSON.stringify(EXPECTED_COUNTS)}` };
    },
    async teardown({ client, state }) {
      if (state.formId) await client.deleteForm(state.formId);
    },
  },

  {
    id: 'charts.horizontal-bar',
    category: 'charts',
    expectedTurns: 4,
    maxTurns: 15,
    async setup(client) {
      const form = await seedChartForm(client, 'GC Bench Form');
      return { formId: form.id, name: uniqueLabel('GC Horizontal') };
    },
    prompt: (s) =>
      `On Gravity Forms form ${s.formId}, create a HORIZONTAL bar chart named "${s.name}" counting entries per Status ` +
      `(the bars should run left-to-right, not bottom-to-top).`,
    async grade({ client, state, telemetry }) {
      const chart = await findChart(client, state.formId);
      if (!chart) return { pass: false, detail: `no chart feed created; errors: ${agentErrors(telemetry).join(', ') || 'none'}` };
      const r = await renderedChart(client, chart.id);
      // Horizontal = meta.indexAxis "y", which the renderer emits as options.indexAxis "y" (verified).
      const horizontal = String(r.options?.indexAxis || '') === 'y';
      const counts = labelValueMap(r);
      const pass = /bar/i.test(r.type || '') && horizontal && mapsEqual(counts, EXPECTED_COUNTS);
      return {
        pass,
        detail: pass ? '' : `type=${r.type || '?'} indexAxis=${JSON.stringify(r.options?.indexAxis)} rendered=${JSON.stringify(counts)} — wanted a horizontal (indexAxis "y") bar with counts ${JSON.stringify(EXPECTED_COUNTS)}`,
      };
    },
    async teardown({ client, state }) {
      if (state.formId) await client.deleteForm(state.formId);
    },
  },

  {
    id: 'charts.dataset-color',
    category: 'charts',
    expectedTurns: 4,
    maxTurns: 15,
    async setup(client) {
      const form = await seedChartForm(client, 'GC Bench Form');
      return { formId: form.id, name: uniqueLabel('GC Colored') };
    },
    prompt: (s) =>
      `On Gravity Forms form ${s.formId}, create a bar chart named "${s.name}" counting entries per Status. ` +
      `Make the bars the exact color #ff6384 and label the data series "By Status".`,
    async grade({ client, state, telemetry }) {
      const chart = await findChart(client, state.formId);
      if (!chart) return { pass: false, detail: `no chart feed created; errors: ${agentErrors(telemetry).join(', ') || 'none'}` };
      const stored = await storedChart(client, chart.id);
      const ds0 = stored.meta?.datasets?.[0] || {};
      const r = await renderedChart(client, chart.id);
      const rendered0 = r.datasets?.[0] || {};
      // Verified: dataset color "#ff6384" is stored verbatim and emitted verbatim as backgroundColor.
      const storedOk = String(ds0.color || '').toLowerCase() === '#ff6384' && ds0.label === 'By Status';
      const renderedOk = JSON.stringify(rendered0.backgroundColor || '').toLowerCase().includes('ff6384') && rendered0.label === 'By Status';
      const pass = storedOk && renderedOk;
      return {
        pass,
        detail: pass ? '' : `stored ds0=${JSON.stringify({ color: ds0.color, label: ds0.label })} rendered ds0=${JSON.stringify({ backgroundColor: rendered0.backgroundColor, label: rendered0.label })} — wanted color #ff6384 + label "By Status" in both`,
      };
    },
    async teardown({ client, state }) {
      if (state.formId) await client.deleteForm(state.formId);
    },
  },

  // ── Aggregation ──────────────────────────────────────────────────────────

  {
    id: 'charts.sum-per-category',
    category: 'charts',
    expectedTurns: 5,
    maxTurns: 18,
    async setup(client) {
      const form = await seedChartForm(client, 'GC Bench Form');
      return { formId: form.id, name: uniqueLabel('GC Amount Sum') };
    },
    prompt: (s) =>
      `On Gravity Forms form ${s.formId}, create a bar chart named "${s.name}" showing the TOTAL of the "Amount" field ` +
      `for each Status. So each bar is the sum of Amount across that status's entries, not a count of entries.`,
    async grade({ client, state, telemetry }) {
      const chart = await findChart(client, state.formId);
      if (!chart) return { pass: false, detail: `no chart feed created; errors: ${agentErrors(telemetry).join(', ') || 'none'}` };
      const r = await renderedChart(client, chart.id);
      const sums = labelValueMap(r);
      // Seeded amounts: Open 10+20+30=60, Closed 5+15=20, Pending 7 (verified rendering).
      const pass = mapsEqual(sums, EXPECTED_SUMS);
      return { pass, detail: pass ? '' : `rendered=${JSON.stringify(sums)} — wanted exact sums ${JSON.stringify(EXPECTED_SUMS)} (dataOperationField "sum" + dataAggregateField "${AMOUNT_FIELD}")` };
    },
    async teardown({ client, state }) {
      if (state.formId) await client.deleteForm(state.formId);
    },
  },

  // ── Mutation ─────────────────────────────────────────────────────────────

  {
    id: 'charts.change-type',
    category: 'charts',
    expectedTurns: 3,
    maxTurns: 12,
    async setup(client) {
      const form = await seedChartForm(client, 'GC Bench Form');
      const feedId = await client.createChart(form.id, {
        chart_type: 'bar',
        name: uniqueLabel('GC Morph'),
        datasets: [{ dataField: String(STATUS_FIELD) }],
      });
      return { formId: form.id, feedId };
    },
    prompt: (s) => `Chart feed ${s.feedId} on Gravity Forms form ${s.formId} is currently a bar chart. Change it to a LINE chart. Don't change anything else about it.`,
    async grade({ client, state, telemetry }) {
      const stored = await storedChart(client, state.feedId);
      const isLine = String(stored.meta?.chartType || '') === 'line';
      // "Don't change anything else": the dataset mapping must survive the patch.
      const dsIntact = String(stored.meta?.datasets?.[0]?.dataField || '') === String(STATUS_FIELD);
      const pass = isLine && dsIntact;
      return {
        pass,
        detail: pass ? '' : `chartType=${JSON.stringify(stored.meta?.chartType)} datasets[0].dataField=${JSON.stringify(stored.meta?.datasets?.[0]?.dataField)} (errors: ${agentErrors(telemetry).join(', ') || 'none'}) — wanted line + dataset untouched`,
      };
    },
    async teardown({ client, state }) {
      if (state.formId) await client.deleteForm(state.formId);
    },
  },

  // ── Roundtrip fidelity ───────────────────────────────────────────────────

  {
    id: 'charts.roundtrip-shape',
    category: 'charts',
    expectedTurns: 5,
    maxTurns: 18,
    async setup(client) {
      const form = await seedChartForm(client, 'GC Bench Form');
      return { formId: form.id, name: uniqueLabel('GC Roundtrip') };
    },
    prompt: (s) =>
      `On Gravity Forms form ${s.formId}, create a bar chart named "${s.name}" counting entries per Status. ` +
      `Then read the chart's stored configuration back and tell me exactly which field id drives the chart and how the data is aggregated.`,
    async grade({ client, state, telemetry }) {
      const chart = await findChart(client, state.formId);
      if (!chart) return { pass: false, detail: `no chart feed created; errors: ${agentErrors(telemetry).join(', ') || 'none'}` };
      const stored = await storedChart(client, chart.id);
      const ds0 = stored.meta?.datasets?.[0] || {};
      // The canonical shape must round-trip: dataField (NOT field_id), categories mode, and the chart must render.
      const canonical = String(ds0.dataField || '') === String(STATUS_FIELD) && !('field_id' in ds0) && String(stored.meta?.xAxisMode || '') === 'categories';
      const r = await renderedChart(client, chart.id);
      const renders = mapsEqual(labelValueMap(r), EXPECTED_COUNTS);
      const reported = new RegExp(`\\b${STATUS_FIELD}\\b`).test(telemetry.finalText || '') && /count/i.test(telemetry.finalText || '');
      const pass = canonical && renders && reported;
      return {
        pass,
        detail: pass ? '' : `stored ds0=${JSON.stringify(ds0)} xAxisMode=${JSON.stringify(stored.meta?.xAxisMode)} renders=${renders} reported=${reported} — wanted canonical dataField shape, correct render, and an answer naming field ${STATUS_FIELD} + counting`,
      };
    },
    async teardown({ client, state }) {
      if (state.formId) await client.deleteForm(state.formId);
    },
  },

  // ── Error handling ───────────────────────────────────────────────────────

  {
    id: 'charts.error-invalid-form',
    category: 'charts',
    expectedTurns: 2,
    maxTurns: 10,
    prompt:
      'Create a GravityCharts bar chart on Gravity Forms form 999999. If that is not possible, do not create a chart anywhere else — just tell me exactly what went wrong.',
    async grade({ client, telemetry }) {
      // Honest failure: the agent reports the form doesn't exist and creates nothing.
      const admitted = /not (found|exist)|doesn'?t exist|no (such )?form|invalid form|couldn'?t find/i.test(telemetry.finalText || '');
      const { data } = await client.ability('gk-gravitycharts/charts-list', { form_id: 999999 });
      const nothingCreated = (data?.charts || []).length === 0;
      const pass = admitted && nothingCreated;
      return { pass, detail: pass ? '' : `admitted=${admitted} chartsOn999999=${(data?.charts || []).length} — wanted an honest "form not found" and zero charts created` };
    },
  },

  {
    id: 'charts.error-invalid-type',
    category: 'charts',
    expectedTurns: 3,
    maxTurns: 10,
    async setup(client) {
      const form = await client.createForm(uniqueLabel('GC Bench Form'));
      return { formId: form.id };
    },
    prompt: (s) =>
      `Create a "scatter" chart on Gravity Forms form ${s.formId} using GravityCharts. If scatter is not a supported chart type, ` +
      `do NOT create a chart of any other type — instead tell me which chart types ARE supported.`,
    async grade({ client, state, telemetry }) {
      const created = await chartCount(client, state.formId);
      // Refusal phrasings vary ("not supported" / "not a supported chart type" /
      // "won't create…") — grade the semantics (a negation + the types named), not one phrasing.
      const text = telemetry.finalText || '';
      const namedTypes = ['bar', 'line', 'pie'].filter((t) => new RegExp(`\\b${t}\\b`, 'i').test(text)).length;
      const negation = /\b(not|no|isn'?t|aren'?t|unsupported|unavailable|won'?t|cannot|can'?t|doesn'?t)\b/i.test(text);
      const listedSupported = namedTypes >= 3 && negation;
      const pass = created === 0 && listedSupported;
      return { pass, detail: pass ? '' : `chartsCreated=${created} listedSupported=${listedSupported} — wanted zero charts + an answer naming the supported types` };
    },
    async teardown({ client, state }) {
      if (state.formId) await client.deleteForm(state.formId);
    },
  },

  // ── Delete ───────────────────────────────────────────────────────────────

  {
    id: 'charts.delete-idempotent',
    category: 'charts',
    expectedTurns: 3,
    maxTurns: 12,
    async setup(client) {
      const form = await client.createForm(uniqueLabel('GC Bench Form'));
      const feedId = await client.createChart(form.id, { chart_type: 'bar', name: uniqueLabel('GC Doomed') });
      return { formId: form.id, feedId };
    },
    prompt: (s) =>
      `Delete GravityCharts chart feed ${s.feedId} (it's on form ${s.formId}). Then try deleting the SAME feed id a second time ` +
      `and tell me what the second attempt reported.`,
    async grade({ client, state, telemetry }) {
      const remaining = await chartCount(client, state.formId);
      const deleteCalls = (telemetry.toolCalls || []).filter((c) => /chart[_-]?delete/i.test(c.name || ''));
      const mentionedIdempotent = /already[ _-]?(deleted|gone|removed)|no longer exists|was already/i.test(telemetry.finalText || '');
      const pass = remaining === 0 && deleteCalls.length >= 2 && mentionedIdempotent;
      return {
        pass,
        detail: pass ? '' : `remaining=${remaining} deleteCalls=${deleteCalls.length} mentionedIdempotent=${mentionedIdempotent} — wanted the feed gone, two delete calls, and the answer relaying already_deleted`,
      };
    },
    async teardown({ client, state }) {
      if (state.formId) await client.deleteForm(state.formId);
    },
  },
];
