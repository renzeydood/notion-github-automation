// Notion webhook → GitHub workflow dispatcher.
// Secrets: NOTION_WEBHOOK_SECRET, NOTION_TOKEN, GITHUB_TOKEN.
// Variable: PROJECTS_CONFIG (JSON array, see templates/projects-config.json).
const NOTION_VERSION = '2022-06-28';
const normalize = value => String(value ?? '').replace(/-/g, '').toLowerCase();

function loadProjects(raw) {
  if (!raw) throw new Error('Missing PROJECTS_CONFIG');
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!Array.isArray(parsed) || !parsed.length) throw new Error('PROJECTS_CONFIG must be a nonempty array');
  const uuid = /^[0-9a-f]{32}$/i;
  const seen = new Set();
  for (const p of parsed) {
    if (!uuid.test(normalize(p.databaseId)) || !uuid.test(normalize(p.dataSourceId))) throw new Error('Invalid Notion IDs');
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(p.repo)) throw new Error('Invalid repository');
    p.workflow ??= 'create-notion-branch.yml';
    p.ref ??= 'main';
    if (!/^[A-Za-z0-9_.-]+\.ya?ml$/.test(p.workflow) || !/^[A-Za-z0-9_./-]+$/.test(p.ref)) throw new Error('Invalid workflow/ref');
    for (const id of [p.databaseId, p.dataSourceId]) {
      const key = normalize(id);
      if (seen.has(key)) throw new Error('Duplicate project ID');
      seen.add(key);
    }
  }
  return parsed;
}

async function verifySignature(body, signature, secret) {
  if (!signature || !secret) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
  const digest = await crypto.subtle.sign('HMAC', key, enc.encode(body));
  const expected = 'sha256=' + Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
  const a = enc.encode(signature), b = enc.encode(expected);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/') return new Response('Notion GitHub bridge running', {status: 200});
    if (request.method !== 'POST' || url.pathname !== '/webhook') return new Response('Not found', {status: 404});
    if (!env.NOTION_WEBHOOK_SECRET || !env.NOTION_TOKEN || !env.GITHUB_TOKEN) return new Response('Missing secrets', {status: 503});

    const body = await request.text();
    if (!await verifySignature(body, request.headers.get('X-Notion-Signature'), env.NOTION_WEBHOOK_SECRET))
      return new Response('Unauthorized', {status: 401});

    let event;
    try { event = JSON.parse(body); }
    catch { return new Response('Invalid JSON', {status: 400}); }
    if (event.type !== 'page.properties_updated' || event.entity?.type !== 'page' || !event.entity.id)
      return new Response('Ignored event', {status: 200});

    let projects;
    try { projects = loadProjects(env.PROJECTS_CONFIG); }
    catch (error) {
      console.error('Invalid PROJECTS_CONFIG', String(error));
      return new Response('Invalid project configuration', {status: 503});
    }

    const pageId = event.entity.id;
    const notionResponse = await fetch('https://api.notion.com/v1/pages/' + encodeURIComponent(pageId), {
      headers: {Authorization: 'Bearer ' + env.NOTION_TOKEN, 'Notion-Version': NOTION_VERSION}
    });
    if (!notionResponse.ok) {
      console.error('Notion lookup failed', notionResponse.status);
      return new Response('Notion lookup failed', {status: 503});
    }

    const page = await notionResponse.json();
    const parentId = page.parent?.database_id ?? page.parent?.data_source_id;
    const project = projects.find(p => [p.databaseId, p.dataSourceId].some(id => normalize(id) === normalize(parentId)));
    if (!project) return new Response('Unconfigured project', {status: 200});

    const props = page.properties ?? {};
    const state = props['GitHub Lifecycle']?.select?.name ?? null;
    const ticketNumber = props['Ticket ID']?.unique_id?.number ?? null;
    const title = (props.Name?.title ?? []).map(t => t.plain_text ?? '').join('');
    if (state !== 'Pending') return new Response('No request pending', {status: 200});
    if (!Number.isInteger(ticketNumber) || ticketNumber <= 0 || !title.trim())
      return new Response('Invalid ticket', {status: 200});

    const dispatchUrl = 'https://api.github.com/repos/' + project.repo +
      '/actions/workflows/' + encodeURIComponent(project.workflow) + '/dispatches';
    const githubResponse = await fetch(dispatchUrl, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + env.GITHUB_TOKEN,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'notion-github-bridge',
        'X-GitHub-Api-Version': '2022-11-28'
      },
      body: JSON.stringify({ref: project.ref, inputs: {page_id: pageId}})
    });
    if (!githubResponse.ok) {
      console.error('Dispatch failed', project.repo, githubResponse.status, (await githubResponse.text()).slice(0, 300));
      return new Response('GitHub dispatch failed', {status: 503});
    }
    console.log('Dispatched', JSON.stringify({repo: project.repo, pageId, ticketNumber}));
    return new Response('Workflow dispatched', {status: 200});
  }
};
