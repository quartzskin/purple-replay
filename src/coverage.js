// status: detected | gap (telemetry, no matching rule fired) | not_run | rule_only (rule, no scenario)
export function buildCoverage(scenarios, rules, events) {
  const rows = new Map();
  const row = (t) => {
    if (!rows.has(t)) {
      rows.set(t, { technique: t, scenarios: [], rules: [], telemetry: 0, scenariosRun: [], detectedBy: [], status: null });
    }
    return rows.get(t);
  };

  for (const s of scenarios) for (const t of s.techniques) row(t).scenarios.push(s.id);
  for (const r of rules) for (const t of r.techniques) row(t).rules.push({ id: r.id, title: r.title });

  const ruleTech = new Map(rules.map((r) => [r.id, r.techniques]));
  for (const e of events) {
    const c = row(e.technique);
    c.telemetry++;
    if (!c.scenariosRun.includes(e.scenarioId)) c.scenariosRun.push(e.scenarioId);
    for (const d of e.detections) {
      if ((ruleTech.get(d.ruleId) ?? []).includes(e.technique) && !c.detectedBy.some((x) => x.id === d.ruleId)) {
        c.detectedBy.push({ id: d.ruleId, title: d.title });
      }
    }
  }

  for (const c of rows.values()) {
    if (c.detectedBy.length) c.status = 'detected';
    else if (c.telemetry) c.status = 'gap';
    else if (c.scenarios.length) c.status = 'not_run';
    else c.status = 'rule_only';
  }

  const techniques = [...rows.values()].sort((a, b) => a.technique.localeCompare(b.technique));
  const count = (s) => techniques.filter((t) => t.status === s).length;
  const withTelemetry = techniques.filter((t) => t.telemetry).length;
  return {
    techniques,
    summary: {
      techniques: techniques.length,
      detected: count('detected'),
      gap: count('gap'),
      notRun: count('not_run'),
      ruleOnly: count('rule_only'),
      detectionRate: withTelemetry ? Math.round((count('detected') / withTelemetry) * 100) : null,
    },
  };
}
