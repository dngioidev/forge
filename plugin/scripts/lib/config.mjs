import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const CONFIG_RELPATH = join('.claude', 'forge.json');

const FIELD_KEYS = ['status', 'priority', 'size', 'type'];

/**
 * Structural validation of .claude/forge.json — plain checks, no schema
 * library (zero-dependency principle, spec §2). Returns every problem it
 * finds so doctor can print them all at once.
 */
export function validateConfig(cfg) {
  const errors = [];
  const push = (msg) => errors.push(msg);

  if (cfg === null || typeof cfg !== 'object' || Array.isArray(cfg)) {
    return { ok: false, errors: ['config root must be a JSON object'] };
  }

  const board = cfg.board;
  if (!board || typeof board !== 'object') {
    push('board: missing block');
  } else {
    if (!Number.isInteger(board.projectNumber) || board.projectNumber <= 0) {
      push('board.projectNumber: must be a positive integer');
    }
    if (typeof board.projectId !== 'string' || !/^PVT_/.test(board.projectId)) {
      push('board.projectId: must be a ProjectV2 id (PVT_…)');
    }
    if (!board.fields || typeof board.fields !== 'object') {
      push('board.fields: missing block');
    } else {
      for (const key of FIELD_KEYS) {
        const f = board.fields[key];
        if (!f || typeof f !== 'object') {
          push(`board.fields.${key}: missing`);
          continue;
        }
        if (typeof f.id !== 'string' || !/^PVTSSF_/.test(f.id)) {
          push(`board.fields.${key}.id: must be a single-select field id (PVTSSF_…)`);
        }
        if (!f.options || typeof f.options !== 'object' || Object.keys(f.options).length === 0) {
          push(`board.fields.${key}.options: must be a non-empty map of option name -> option id`);
        } else {
          for (const [name, id] of Object.entries(f.options)) {
            if (typeof id !== 'string' || id.length === 0) push(`board.fields.${key}.options.${name}: empty option id`);
          }
        }
      }
    }
    if (board.deliveryLogIssue !== undefined && (!Number.isInteger(board.deliveryLogIssue) || board.deliveryLogIssue <= 0)) {
      push('board.deliveryLogIssue: must be a positive integer when present');
    }
  }

  if (cfg.conventions !== undefined) {
    if (typeof cfg.conventions !== 'object' || Array.isArray(cfg.conventions)) {
      push('conventions: must be an object');
    } else {
      for (const [k, v] of Object.entries(cfg.conventions)) {
        if (typeof v !== 'string') push(`conventions.${k}: must be a string`);
      }
    }
  }

  if (cfg.features !== undefined) {
    if (typeof cfg.features !== 'object' || Array.isArray(cfg.features)) {
      push('features: must be an object');
    } else {
      for (const [k, v] of Object.entries(cfg.features)) {
        if (typeof v !== 'boolean') push(`features.${k}: must be a boolean`);
      }
    }
  }

  if (cfg.team !== undefined) {
    const team = cfg.team;
    if (typeof team !== 'object' || Array.isArray(team)) {
      push('team: must be an object');
    } else if (team.members !== undefined) {
      if (!Array.isArray(team.members) || team.members.length === 0) {
        push('team.members: must be a non-empty array when present');
      } else {
        team.members.forEach((m, i) => {
          if (!m || typeof m.github !== 'string' || m.github.length === 0) push(`team.members[${i}].github: required`);
          if (!Array.isArray(m.roles) || m.roles.length === 0) push(`team.members[${i}].roles: required non-empty array`);
        });
        const hasMaintainer = team.members.some((m) => Array.isArray(m.roles) && m.roles.includes('maintainer'));
        if (!hasMaintainer) push('team.members: at least one member must hold the maintainer role');
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

/** Load + parse + validate. Missing file and broken JSON are distinct errors. */
export async function loadConfig(cwd) {
  const path = join(cwd, CONFIG_RELPATH);
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return { ok: false, missing: true, errors: [`${CONFIG_RELPATH} not found — run /forge:init`], config: null };
  }
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch (err) {
    return { ok: false, missing: false, errors: [`${CONFIG_RELPATH} is not valid JSON: ${err.message}`], config: null };
  }
  const v = validateConfig(cfg);
  return { ok: v.ok, missing: false, errors: v.errors, config: cfg };
}
