const $ = (id) => document.getElementById(id);

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v);
  }
  el.append(...kids.flat().filter((k) => k !== null && k !== undefined));
  return el;
}

async function api(path, method = 'GET', body) {
  const res = await fetch(path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data;
}

const STATUS = { detected: 'detected', gap: 'gap', not_run: 'not run', rule_only: 'rule only' };

function renderSummary(s) {
  const box = (n, label) => h('div', {}, h('b', {}, String(n)), h('span', {}, label));
  $('summary').replaceChildren(
    box(s.techniques, 'techniques'),
    box(s.detected, 'detected'),
    box(s.gap, 'gaps'),
    box(s.notRun, 'not run'),
    box(s.ruleOnly, 'rule only'),
    box(s.detectionRate === null ? '-' : s.detectionRate + '%', 'detection rate'),
  );
}

function renderCoverage(rows) {
  const head = h('tr', {}, ...['Technique', 'Status', 'Events', 'Scenarios', 'Detected by'].map((t) => h('th', {}, t)));
  const body = rows.map((c) =>
    h('tr', {},
      h('td', { class: 'mono' }, c.technique),
      h('td', {}, h('span', { class: `pill ${c.status}` }, STATUS[c.status])),
      h('td', {}, String(c.telemetry)),
      h('td', {}, (c.scenariosRun.length ? c.scenariosRun : c.scenarios).join(', ') || '-'),
      h('td', {}, c.detectedBy.map((d) => d.title).join(', ') || '-')),
  );
  $('coverage').replaceChildren(head, ...body);
}

function renderTimeline(events) {
  const t0 = events.length ? events[0].ts : 0;
  const head = h('tr', {}, ...['+s', 'Scenario', 'Technique', 'Event', 'Detections'].map((t) => h('th', {}, t)));
  const body = events.map((e) => {
    const f = e.fields;
    const text = f.CommandLine ?? (f.TargetImage ? `${f.SourceImage} -> ${f.TargetImage} (${f.GrantedAccess})` : JSON.stringify(f));
    return h('tr', {},
      h('td', { class: 'mono' }, ((e.ts - t0) / 1000).toFixed(1)),
      h('td', {}, e.scenarioId),
      h('td', { class: 'mono' }, e.technique),
      h('td', { class: 'mono' }, text),
      h('td', { class: e.detections.length ? 'fired' : '' }, e.detections.map((d) => `${d.title} [${d.level}]`).join('; ') || '-'));
  });
  $('timeline').replaceChildren(head, ...body);
}

async function refresh() {
  const [cat, cov] = await Promise.all([api('/api/catalog'), api('/api/coverage')]);
  renderSummary(cov.summary);
  renderCoverage(cov.techniques);

  $('scenarios').replaceChildren(
    ...cat.scenarios.map((s) =>
      h('li', {},
        h('div', {}, s.name, h('small', {}, `${s.techniques.join(', ')} - ${s.eventCount} events`)),
        h('button', { class: 'small', onclick: () => replay(s.id) }, 'Replay'))),
  );
  $('rules').replaceChildren(
    ...cat.rules.map((r) => h('li', {}, h('div', {}, r.title, h('small', {}, r.description || r.id)), h('span', { class: 'mono' }, r.techniques.join(', ')))),
  );
  $('errors').replaceChildren(
    ...[...cat.errors.scenarios, ...cat.errors.rules].map((e) => h('li', {}, `${e.file}: ${e.error}`)),
  );

  const sel = $('filter');
  const cur = sel.value;
  sel.replaceChildren(h('option', { value: '' }, 'all scenarios'), ...cat.scenarios.map((s) => h('option', { value: s.id }, s.id)));
  sel.value = cur;
  renderTimeline(await api('/api/timeline' + (cur ? `?scenario=${encodeURIComponent(cur)}` : '')));
}

async function replay(scenario) {
  await api('/api/replay', 'POST', { scenario });
  await refresh();
}

$('replay-all').addEventListener('click', () => replay('all'));
$('reset').addEventListener('click', async () => {
  await api('/api/reset', 'POST');
  await refresh();
});
$('filter').addEventListener('change', refresh);
refresh().catch((e) => alert(e.message));
