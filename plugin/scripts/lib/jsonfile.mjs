import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
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

/**
 * Write JSON atomically: stage the bytes in a sibling temp file, then rename it
 * onto the target. The rename is the only mutation of `path`, so a crash mid-write
 * can never leave a truncated/half-written JSON file — the next reader sees either
 * the old complete file or the new one, never a corrupt one (#164).
 */
export async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  try {
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {}); // don't leave a temp turd behind
    throw err;
  }
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
