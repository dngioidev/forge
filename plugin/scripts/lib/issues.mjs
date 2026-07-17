import { markedBody, hasMarker } from './markers.mjs';

/** Issue-level operations shared by board scripts. All gh calls injectable. */

const ISSUE_NODE_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) { id parent { number } }
  }
}`;

export async function getIssueNode(gh, owner, repo, number) {
  const res = await gh(
    ['api', 'graphql', '-f', `query=${ISSUE_NODE_QUERY}`, '-f', `owner=${owner}`, '-f', `repo=${repo}`, '-F', `number=${number}`],
    { parseJson: true },
  );
  if (!res.ok) return { ok: false, error: res.stderr || `issue #${number} not found` };
  const issue = res.json.data?.repository?.issue;
  if (!issue) return { ok: false, error: `issue #${number} not found` };
  return { ok: true, id: issue.id, parentNumber: issue.parent?.number ?? null };
}

const ADD_SUB_ISSUE = `mutation($parentId: ID!, $childId: ID!) {
  addSubIssue(input: { issueId: $parentId, subIssueId: $childId }) { issue { number } }
}`;

export async function addSubIssue(gh, parentNodeId, childNodeId) {
  const res = await gh(
    ['api', 'graphql', '-f', `query=${ADD_SUB_ISSUE}`, '-f', `parentId=${parentNodeId}`, '-f', `childId=${childNodeId}`],
    { parseJson: true },
  );
  if (!res.ok) return { ok: false, error: res.stderr || 'addSubIssue failed' };
  return { ok: true };
}

const SUB_ISSUES_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) {
      subIssues(first: 100) { nodes { number title state createdAt closedAt } }
    }
  }
}`;

export async function getSubIssues(gh, owner, repo, number) {
  const res = await gh(
    ['api', 'graphql', '-f', `query=${SUB_ISSUES_QUERY}`, '-f', `owner=${owner}`, '-f', `repo=${repo}`, '-F', `number=${number}`],
    { parseJson: true },
  );
  if (!res.ok) return { ok: false, error: res.stderr || 'subIssues query failed' };
  return { ok: true, children: res.json.data?.repository?.issue?.subIssues?.nodes ?? [] };
}

export async function listComments(gh, owner, repo, number) {
  const res = await gh(['api', `repos/${owner}/${repo}/issues/${number}/comments?per_page=100`], { parseJson: true });
  if (!res.ok) return { ok: false, error: res.stderr || 'comments list failed' };
  return { ok: true, comments: res.json };
}

/**
 * Idempotency core for every trail/receipt/log comment: find the comment
 * carrying `marker` and PATCH it, or POST a new one. Never stacks.
 */
export async function upsertMarkedComment(gh, owner, repo, number, marker, content) {
  const list = await listComments(gh, owner, repo, number);
  if (!list.ok) return list;
  const body = markedBody(marker, content);
  const existing = list.comments.find((c) => hasMarker(c.body, marker));
  if (existing) {
    const res = await gh(['api', '-X', 'PATCH', `repos/${owner}/${repo}/issues/comments/${existing.id}`, '-f', `body=${body}`]);
    if (!res.ok) return { ok: false, error: res.stderr || 'comment update failed' };
    return { ok: true, action: 'updated', id: existing.id };
  }
  const res = await gh(['api', `repos/${owner}/${repo}/issues/${number}/comments`, '-f', `body=${body}`], { parseJson: true });
  if (!res.ok) return { ok: false, error: res.stderr || 'comment create failed' };
  return { ok: true, action: 'created', id: res.json.id };
}

export async function getIssueBody(gh, number) {
  const res = await gh(['issue', 'view', String(number), '--json', 'body,title,state'], { parseJson: true });
  if (!res.ok) return { ok: false, error: res.stderr || `issue #${number} not found` };
  return { ok: true, ...res.json };
}

export async function setIssueBody(gh, number, body) {
  const res = await gh(['issue', 'edit', String(number), '--body', body]);
  if (!res.ok) return { ok: false, error: res.stderr || 'issue edit failed' };
  return { ok: true };
}
