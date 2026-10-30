import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
// A model-default reference, not the session's resolved compaction threshold.
export function compactReference(snapshot, models) {
  const model = models.find(m => m.slug === snapshot.model);
  if (!model || !Number.isFinite(model.context_window) || model.context_window <= 0 ||
      !Number.isFinite(model.effective_context_window_percent) || model.effective_context_window_percent <= 0 ||
      Math.floor(model.context_window * model.effective_context_window_percent / 100) !== snapshot.contextWindowTokens ||
      !Number.isFinite(snapshot.contextUsedTokens) || snapshot.contextUsedTokens < 0) return null;
  const defaultLimit = Math.floor(model.context_window * 0.9);
  const limit = Number.isFinite(model.auto_compact_token_limit) && model.auto_compact_token_limit > 0
    ? Math.min(defaultLimit, model.auto_compact_token_limit) : defaultLimit;
  const remaining = Math.max(0, limit - snapshot.contextUsedTokens);
  return { limit, remaining, remainingPercent:remaining / limit * 100, kind:'model-default-reference' };
}
let models = [], checkedAt = 0;
export async function addCompactReference(snapshot) {
  if (Date.now() - checkedAt > 60000) {
    checkedAt = Date.now();
    try {
      const file=path.join(process.env.CODEX_HOME || os.homedir()+'/.codex','models_cache.json');
      if ((await fs.stat(file)).size > 16*1024*1024) throw new Error('catalog too large');
      const catalog=JSON.parse(await fs.readFile(file,'utf8'));
      models=Array.isArray(catalog.models)?catalog.models:[];
    } catch { models=[]; }
  }
  return {...snapshot, compactReference:compactReference(snapshot,models)};
}
