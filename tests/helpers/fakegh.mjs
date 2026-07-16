import { makeGh } from '../../plugin/scripts/lib/exec.mjs';

/**
 * Scripted gh for tests. Routes are [predicate(argsJoined, args), response]
 * pairs checked in order; response is {stdout} (ok defaults true) or a full
 * {ok, code, stdout, stderr}. Records every call for order/absence asserts.
 */
export function fakeGh(routes) {
  const calls = [];
  const execFn = async (cmd, args) => {
    const joined = args.join(' ');
    calls.push(joined);
    for (const [pred, res] of routes) {
      const hit = typeof pred === 'string' ? joined.startsWith(pred) : pred(joined, args);
      if (hit) {
        const r = typeof res === 'function' ? res(joined, args) : res;
        return { ok: r.ok ?? true, code: r.code ?? (r.ok === false ? 1 : 0), stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
      }
    }
    return { ok: false, code: 1, stdout: '', stderr: `fakeGh: unrouted call: gh ${joined}` };
  };
  return { gh: makeGh(execFn), calls };
}

/** Build a ProjectsV2 fields-query response from simple field specs. */
export function fieldsResponse(itemsCount, fields) {
  return {
    stdout: JSON.stringify({
      data: {
        node: {
          items: { totalCount: itemsCount },
          fields: { nodes: fields.map((f) => ({ __typename: 'ProjectV2SingleSelectField', id: f.id, name: f.name, options: f.options })) },
        },
      },
    }),
  };
}

export const REPO_VIEW = { stdout: JSON.stringify({ owner: { login: 'dngioidev' }, name: 'forge', defaultBranchRef: { name: 'main' } }) };
export const AUTH_OK = { stdout: 'github.com\n  ✓ Logged in\n  - Token scopes: \'gist\', \'project\', \'read:org\', \'repo\'\n' };
