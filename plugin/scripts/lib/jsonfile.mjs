import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Read a JSON file; returns null when missing, throws on broken JSON. */
export async function readJson(path) {
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return null;
  }
  return JSON.parse(raw);
}

export async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

/**
 * Deep-merge `patch` into the JSON file at `path`, creating it if missing.
 * Only keys present in the patch are touched — everything else in the file
 * survives byte-for-byte semantically (the no-clobber rule for settings).
 */
export async function mergeJson(path, patch) {
  const current = (await readJson(path)) ?? {};
  const merged = deepMerge(current, patch);
  await writeJson(path, merged);
  return merged;
}

function deepMerge(base, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    const existing = out[k];
    if (existing && typeof existing === 'object' && !Array.isArray(existing) && v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = deepMerge(existing, v);
    } else {
      out[k] = v;
    }
  }
  return out;
}
