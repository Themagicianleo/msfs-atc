// Loads a phraseology file; "extends" pulls in a base file first.

export function deepMerge(base, over) {
  if (Array.isArray(over) || typeof over !== 'object' || over === null) return over;
  const out = { ...(base && typeof base === 'object' && !Array.isArray(base) ? base : {}) };
  for (const [k, v] of Object.entries(over)) out[k] = k in out ? deepMerge(out[k], v) : v;
  return out;
}

// fetchJson(id) -> parsed JSON for phraseology/<id>.json
export async function loadPhraseology(id, fetchJson, seen = new Set()) {
  if (seen.has(id)) throw new Error(`phraseology files extend each other in a loop (${id})`);
  seen.add(id);
  const data = await fetchJson(id);
  if (!data.extends) return data;
  const base = await loadPhraseology(data.extends, fetchJson, seen);
  return deepMerge(base, data);
}

// Quick sanity check so a typo in an edited file is reported clearly.
export function validatePhraseology(p) {
  const problems = [];
  for (const section of ['atc', 'pilot', 'readback', 'unitNames', 'intents']) {
    if (!p[section]) problems.push(`missing section "${section}"`);
  }
  for (const [key, tpl] of Object.entries(p.atc || {})) {
    if ((tpl.match(/\[/g) || []).length !== (tpl.match(/\]/g) || []).length) problems.push(`atc.${key}: unbalanced [ ]`);
  }
  for (const rule of p.intents || []) {
    for (const pat of rule.patterns || []) {
      try { new RegExp(pat); } catch { problems.push(`intent ${rule.intent}: bad pattern ${pat}`); }
    }
  }
  return problems;
}
