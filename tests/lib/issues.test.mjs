import { describe, it, expect } from 'vitest';
import {
  getIssueNode,
  getSubIssues,
  listComments,
  upsertMarkedComment,
  getIssueBody,
  setIssueBody,
} from '../../plugin/scripts/lib/issues.mjs';
import { markedBody, hasMarker } from '../../plugin/scripts/lib/markers.mjs';

/**
 * A fake gh that records the calls it received and replays canned responses.
 * Each entry is [predicate(argsJoinedWithSpace), response]; the first match wins.
 * No network — every response is a plain {ok, json?, stderr?} literal, exactly
 * what the real makeGh(run) resolves to.
 */
function fakeGh(routes) {
  const calls = [];
  const gh = async (args, opts) => {
    const joined = args.join(' ');
    calls.push({ args, opts, joined });
    for (const [match, res] of routes) {
      if (match(joined, args)) return typeof res === 'function' ? res(args) : res;
    }
    throw new Error(`fakeGh: no route for ${joined}`);
  };
  return { gh, calls };
}

const COMMENTS_PATH = (n) => `issues/${n}/comments`;

describe('upsertMarkedComment idempotency (AC-322.1)', () => {
  it('AC-322.1: CREATES (POST) a new comment when no existing comment carries the marker', async () => {
    const marker = 'trail:started';
    const { gh, calls } = fakeGh([
      // comment list — empty, so nothing carries the marker
      [(j) => j.includes('comments?per_page=100'), { ok: true, json: [] }],
      // POST new comment (path without the ?per_page query)
      [(j) => j.includes(COMMENTS_PATH(42)), { ok: true, json: { id: 999 } }],
    ]);

    const res = await upsertMarkedComment(gh, 'o', 'r', 42, marker, 'hello');

    expect(res).toMatchObject({ ok: true, action: 'created', id: 999 });
    // exactly one list call and one POST create call — never a PATCH
    const listCall = calls.find((c) => c.joined.includes('comments?per_page=100'));
    const postCall = calls.find((c) => c.args[0] === 'api' && c.args.some((a) => a.startsWith('body=')));
    expect(listCall).toBeTruthy();
    expect(postCall).toBeTruthy();
    expect(calls.some((c) => c.args.includes('-X'))).toBe(false); // no PATCH => no update path
    // the marker mechanism: the body posted is the marked body carrying the marker
    const bodyArg = postCall.args.find((a) => a.startsWith('body='));
    expect(bodyArg).toBe(`body=${markedBody(marker, 'hello')}`);
    expect(hasMarker(bodyArg.slice('body='.length), marker)).toBe(true);
  });

  it('AC-322.1: UPDATES (PATCH) the existing marked comment instead of stacking a duplicate', async () => {
    const marker = 'trail:started';
    const existingBody = markedBody(marker, 'old content');
    const { gh, calls } = fakeGh([
      // comment list — one comment already carrying the marker, plus noise
      [(j) => j.includes('comments?per_page=100'), {
        ok: true,
        json: [
          { id: 111, body: 'an unrelated comment' },
          { id: 222, body: existingBody },
        ],
      }],
      // PATCH the existing comment
      [(j) => j.includes('-X PATCH'), { ok: true }],
    ]);

    const res = await upsertMarkedComment(gh, 'o', 'r', 7, marker, 'new content');

    expect(res).toMatchObject({ ok: true, action: 'updated', id: 222 });
    const patchCall = calls.find((c) => c.args.includes('PATCH'));
    expect(patchCall).toBeTruthy();
    // targets the marked comment's id, not the unrelated one, and never POSTs a duplicate
    expect(patchCall.joined).toContain('issues/comments/222');
    expect(patchCall.joined).not.toContain('issues/comments/111');
    const postCreate = calls.find((c) => c.joined.match(/issues\/7\/comments$/));
    expect(postCreate).toBeUndefined(); // no create => no duplicate stacked
    // updated body still carries the marker
    const bodyArg = patchCall.args.find((a) => a.startsWith('body='));
    expect(hasMarker(bodyArg.slice('body='.length), marker)).toBe(true);
  });
});

describe('lib/issues.mjs not-ok failure branches (AC-322.1)', () => {
  it('AC-322.1: upsertMarkedComment surfaces the list failure without throwing', async () => {
    const { gh } = fakeGh([
      [(j) => j.includes('comments?per_page=100'), { ok: false, stderr: 'HTTP 403: forbidden' }],
    ]);
    const res = await upsertMarkedComment(gh, 'o', 'r', 5, 'trail:pr', 'body');
    expect(res.ok).toBe(false);
    expect(res.error).toContain('403');
  });

  it('AC-322.1: upsertMarkedComment surfaces a create (POST) failure as not-ok', async () => {
    const { gh } = fakeGh([
      [(j) => j.includes('comments?per_page=100'), { ok: true, json: [] }],
      [(j) => j.includes('/comments'), { ok: false, stderr: 'HTTP 422: unprocessable' }],
    ]);
    const res = await upsertMarkedComment(gh, 'o', 'r', 5, 'trail:pr', 'body');
    expect(res.ok).toBe(false);
    expect(res.error).toContain('422');
  });

  it('AC-322.1: upsertMarkedComment surfaces a PATCH (update) failure as not-ok', async () => {
    const marker = 'trail:pr';
    const { gh } = fakeGh([
      [(j) => j.includes('comments?per_page=100'), { ok: true, json: [{ id: 3, body: markedBody(marker, 'x') }] }],
      [(j) => j.includes('PATCH'), { ok: false, stderr: 'HTTP 500: boom' }],
    ]);
    const res = await upsertMarkedComment(gh, 'o', 'r', 5, marker, 'body');
    expect(res.ok).toBe(false);
    expect(res.error).toContain('500');
  });

  it('AC-322.1: getIssueNode returns {ok:false,error} on a not-ok gh response', async () => {
    const { gh } = fakeGh([[() => true, { ok: false, stderr: 'HTTP 404: not found' }]]);
    const res = await getIssueNode(gh, 'o', 'r', 88);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('404');
  });

  it('AC-322.1: getIssueNode returns {ok:false} when gh is ok but the issue node is absent', async () => {
    const { gh } = fakeGh([[() => true, { ok: true, json: { data: { repository: { issue: null } } } }]]);
    const res = await getIssueNode(gh, 'o', 'r', 88);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('#88');
  });

  it('AC-322.1: getSubIssues returns {ok:false,error} on a not-ok gh response', async () => {
    const { gh } = fakeGh([[() => true, { ok: false, stderr: 'HTTP 502: bad gateway' }]]);
    const res = await getSubIssues(gh, 'o', 'r', 12);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('502');
  });

  it('AC-322.1: listComments returns {ok:false,error} on a not-ok gh response', async () => {
    const { gh } = fakeGh([[() => true, { ok: false, stderr: 'HTTP 403: forbidden' }]]);
    const res = await listComments(gh, 'o', 'r', 9);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('403');
  });

  it('AC-322.1: getIssueBody returns {ok:false,error} on a not-ok gh response', async () => {
    const { gh } = fakeGh([[() => true, { ok: false, stderr: 'issue not found' }]]);
    const res = await getIssueBody(gh, 404);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('not found');
  });

  it('AC-322.1: setIssueBody returns {ok:false,error} on a not-ok gh response', async () => {
    const { gh } = fakeGh([[() => true, { ok: false, stderr: 'HTTP 403: insufficient scope' }]]);
    const res = await setIssueBody(gh, 5, 'new body');
    expect(res.ok).toBe(false);
    expect(res.error).toContain('403');
  });
});
