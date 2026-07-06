/**
 * GravityCharts tasks — can a SMALL model create a *meaningful* chart through
 * the GravityCharts abilities (gc_*)?
 *
 * The hard part is not the minimal create (form_id + chart_type); it is
 * building `meta.datasets` correctly so the chart actually renders real data.
 * `chart-create`'s `meta` is a free-form object, so these tasks measure whether
 * the discovery surface (chart-types-list, form-fields-list) + the create
 * ability's description teach the model the dataset shape well enough to
 * succeed. Graders read the RENDERED output via `chart-data-get` (the same
 * config the shortcode emits), never the agent's self-report.
 */

import { uniqueLabel } from './helpers.mjs';

const STATUS_FIELD = 4; // createForm() seeds a 'Status' select: Open / Closed / Pending.

/** Seed a handful of entries with varied Status so aggregation has something to count. */
async function seedStatusEntries(client, formId) {
  const statuses = ['open', 'open', 'closed', 'pending', 'closed', 'open'];
  for (const s of statuses) {
    await client.createEntry(formId, { [STATUS_FIELD]: s });
  }
  return { open: 3, closed: 2, pending: 1 };
}

/** Find the chart feed the agent created on this form (via the read-only ability).
 *  client.ability() returns { status, data }; charts-list data is { charts: [ {id,name,form,type,is_active} ] }. */
async function findChart(client, formId) {
  const { data } = await client.ability('gk-gravitycharts/charts-list', { form_id: formId });
  const list = data?.charts || [];
  return list[list.length - 1] || null; // most-recently-created
}

/** Pull the rendered Chart.js config for a feed and normalize labels/datasets out of it.
 *  chart-data-get data is the Chart.js shape { type, data: { labels, datasets }, options }. */
async function renderedChart(client, feedId) {
  const { data } = await client.ability('gk-gravitycharts/chart-data-get', { feed_id: feedId });
  const type = data?.type || '';
  const chartData = data?.data || {};
  const labels = chartData?.labels || [];
  const datasets = chartData?.datasets || [];
  // Data points may be numbers or point objects ({value,label,x} / {x,y}); pull the numeric value out of each.
  const pointValue = (p) => (typeof p === 'number' ? p : (p?.value ?? p?.y ?? (Array.isArray(p) ? p[1] : NaN)));
  const values = datasets.flatMap((d) => (Array.isArray(d?.data) ? d.data : [])).map(pointValue).map(Number).filter((n) => Number.isFinite(n));
  return { type, labels, datasets, values, raw: data };
}

export default [
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
      if (!chart) return { pass: false, detail: `no chart feed created on form ${state.formId}; errors: ${(telemetry.toolCalls || []).filter((c) => c.isError).map((c) => c.errorCode).filter(Boolean).join(', ') || 'none'}` };
      state.feedId = chart.id;
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
      const form = await client.createForm(uniqueLabel('GC Bench Form'));
      const expected = await seedStatusEntries(client, form.id);
      return { formId: form.id, name: uniqueLabel('GC Status Bar'), expected };
    },
    prompt: (s) =>
      `On Gravity Forms form ${s.formId}, create a bar chart named "${s.name}" that shows how many entries there are ` +
      `for each value of the "Status" field (the choices are Open, Closed, and Pending). The chart should count entries per status.`,
    async grade({ client, state, telemetry }) {
      const chart = await findChart(client, state.formId);
      if (!chart) return { pass: false, detail: `no chart feed created; errors: ${(telemetry.toolCalls || []).filter((c) => c.isError).map((c) => c.errorCode).filter(Boolean).join(', ') || 'none'}` };
      state.feedId = chart.id;
      const r = await renderedChart(client, state.feedId);
      const isBar = /bar/i.test(r.type || chart.type || '');
      const hasCategories = (r.labels || []).length >= 2;
      const hasData = r.values.some((v) => v > 0);
      const totalsSix = r.values.reduce((a, b) => a + b, 0) === 6; // 6 seeded entries counted
      const pass = isBar && hasCategories && hasData;
      return {
        pass,
        detail: pass
          ? (totalsSix ? '' : `renders per-category data (counts sum to ${r.values.reduce((a, b) => a + b, 0)}, expected 6) — acceptable`)
          : `type=${r.type || '?'} labels=[${(r.labels || []).join(',')}] values=[${r.values.join(',')}] — wanted a bar chart counting entries per Status`,
      };
    },
    async teardown({ client, state }) {
      if (state.formId) await client.deleteForm(state.formId); // cascades its feeds
    },
  },
];
