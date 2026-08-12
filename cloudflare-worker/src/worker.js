const SERVER_NAME = 'odoo-mcp-pro';
const SERVER_VERSION = '1.0.0-cloudflare';
const MCP_PROTOCOL_VERSION = '2025-03-26';
let sessionCookie = null;
let sessionUid = null;

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extraHeaders },
  });
}

async function login(env) {
  const r = await fetch(`${env.ODOO_URL}/web/session/authenticate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', method: 'call', id: 1,
      params: { db: env.ODOO_DB, login: env.ODOO_USERNAME, password: env.ODOO_PASSWORD },
    }),
    redirect: 'manual',
  });
  const data = await r.json().catch(() => null);
  if (!r.ok || data?.error || !data?.result?.uid) {
    throw new Error(data?.error?.data?.message || data?.error?.message || `Odoo login failed (HTTP ${r.status})`);
  }
  const setCookie = r.headers.get('set-cookie') || '';
  const m = setCookie.match(/session_id=([^;]+)/);
  if (!m) throw new Error('Odoo login succeeded but session cookie was not returned');
  sessionCookie = `session_id=${m[1]}`;
  sessionUid = data.result.uid;
  return sessionUid;
}

function rpcMessage(data) {
  if (!data?.error) return null;
  return data.error?.data?.message || data.error?.message || 'Odoo RPC error';
}

function sessionExpired(data) {
  const text = JSON.stringify(data?.error || {}).toLowerCase();
  return text.includes('sessionexpired') || text.includes('session expired') || text.includes('not logged');
}

async function callKwOnce(env, model, method, args = [], kwargs = {}) {
  if (!sessionCookie) await login(env);
  const r = await fetch(`${env.ODOO_URL}/web/dataset/call_kw/${encodeURIComponent(model)}/${encodeURIComponent(method)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: sessionCookie },
    body: JSON.stringify({
      jsonrpc: '2.0', method: 'call', id: Math.floor(Math.random() * 1e9),
      params: { model, method, args, kwargs },
    }),
    redirect: 'manual',
  });
  const data = await r.json().catch(() => null);
  return { r, data };
}

async function callKw(env, model, method, args = [], kwargs = {}) {
  let { r, data } = await callKwOnce(env, model, method, args, kwargs);
  if (r.status === 401 || r.status === 403 || sessionExpired(data)) {
    sessionCookie = null;
    sessionUid = null;
    await login(env);
    ({ r, data } = await callKwOnce(env, model, method, args, kwargs));
  }
  if (!r.ok) throw new Error(`Odoo HTTP ${r.status}`);
  if (!data) throw new Error('Odoo returned a non-JSON response');
  const message = rpcMessage(data);
  if (message) throw new Error(message);
  return data.result;
}

const tools = [
  { name: 'server_info', description: 'Return server version and Odoo connection status.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'list_models', description: 'List Odoo models visible to the service account.', inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 5000, default: 1000 } }, additionalProperties: false } },
  { name: 'model_fields', description: 'Inspect fields and metadata for an Odoo model.', inputSchema: { type: 'object', properties: { model: { type: 'string' }, attributes: { type: 'array', items: { type: 'string' } } }, required: ['model'], additionalProperties: false } },
  { name: 'search_records', description: 'Search records in an Odoo model using an Odoo domain.', inputSchema: { type: 'object', properties: { model: { type: 'string' }, domain: { type: 'array', default: [] }, fields: { type: 'array', items: { type: 'string' } }, limit: { type: 'integer', minimum: 1, maximum: 1000, default: 100 }, offset: { type: 'integer', minimum: 0, default: 0 }, order: { type: 'string' } }, required: ['model'], additionalProperties: false } },
  { name: 'get_record', description: 'Read a single Odoo record by ID.', inputSchema: { type: 'object', properties: { model: { type: 'string' }, record_id: { type: 'integer' }, fields: { type: 'array', items: { type: 'string' } } }, required: ['model', 'record_id'], additionalProperties: false } },
  { name: 'create_record', description: 'Create one record in an Odoo model.', inputSchema: { type: 'object', properties: { model: { type: 'string' }, values: { type: 'object' } }, required: ['model', 'values'], additionalProperties: false } },
  { name: 'update_record', description: 'Update one Odoo record.', inputSchema: { type: 'object', properties: { model: { type: 'string' }, record_id: { type: 'integer' }, values: { type: 'object' } }, required: ['model', 'record_id', 'values'], additionalProperties: false } },
  { name: 'delete_record', description: 'Delete one Odoo record.', inputSchema: { type: 'object', properties: { model: { type: 'string' }, record_id: { type: 'integer' } }, required: ['model', 'record_id'], additionalProperties: false } },
  { name: 'create_records', description: 'Create multiple records.', inputSchema: { type: 'object', properties: { model: { type: 'string' }, vals_list: { type: 'array', items: { type: 'object' }, minItems: 1, maxItems: 1000 } }, required: ['model', 'vals_list'], additionalProperties: false } },
  { name: 'update_records', description: 'Update multiple records with the same values.', inputSchema: { type: 'object', properties: { model: { type: 'string' }, record_ids: { type: 'array', items: { type: 'integer' }, minItems: 1, maxItems: 1000 }, values: { type: 'object' } }, required: ['model', 'record_ids', 'values'], additionalProperties: false } },
  { name: 'delete_records', description: 'Delete multiple records.', inputSchema: { type: 'object', properties: { model: { type: 'string' }, record_ids: { type: 'array', items: { type: 'integer' }, minItems: 1, maxItems: 1000 } }, required: ['model', 'record_ids'], additionalProperties: false } },
  { name: 'import_records', description: "Import records using Odoo's native load method.", inputSchema: { type: 'object', properties: { model: { type: 'string' }, fields: { type: 'array', items: { type: 'string' }, minItems: 1 }, data: { type: 'array', items: { type: 'array', items: { type: 'string' } }, minItems: 1 } }, required: ['model', 'fields', 'data'], additionalProperties: false } },
  { name: 'execute_method', description: 'Call a public Odoo model or recordset method. Methods beginning with underscore are rejected.', inputSchema: { type: 'object', properties: { model: { type: 'string' }, method: { type: 'string' }, ids: { type: 'array', items: { type: 'integer' } }, args: { type: 'array', default: [] }, kwargs: { type: 'object', default: {} } }, required: ['model', 'method'], additionalProperties: false } },
  { name: 'set_binary_field', description: 'Fetch an HTTPS file and write it to a Binary or Image field.', inputSchema: { type: 'object', properties: { model: { type: 'string' }, record_id: { type: 'integer' }, field_name: { type: 'string' }, source: { type: 'string' } }, required: ['model', 'record_id', 'field_name', 'source'], additionalProperties: false } },
];

async function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + 0x8000, bytes.length)));
  return btoa(binary);
}

async function runTool(env, name, input) {
  switch (name) {
    case 'server_info': {
      try {
        const uid = sessionUid || await login(env);
        const versionRes = await fetch(`${env.ODOO_URL}/web/version`, { redirect: 'manual' });
        const version = await versionRes.json().catch(() => ({}));
        return { version: SERVER_VERSION, transport: 'streamable-http', connected: true, uid, odoo_url: env.ODOO_URL, odoo_version: version.version || version.server_version || null };
      } catch (e) {
        return { version: SERVER_VERSION, transport: 'streamable-http', connected: false, odoo_url: env.ODOO_URL, error: String(e?.message || e) };
      }
    }
    case 'list_models':
      return callKw(env, 'ir.model', 'search_read', [[]], { fields: ['model', 'name'], limit: Math.min(input.limit ?? 1000, 5000), order: 'model asc' });
    case 'model_fields': {
      const kwargs = input.attributes ? { attributes: input.attributes } : {};
      return callKw(env, input.model, 'fields_get', [], kwargs);
    }
    case 'search_records': {
      const kwargs = { limit: input.limit ?? 100, offset: input.offset ?? 0 };
      if (input.fields) kwargs.fields = input.fields;
      if (input.order) kwargs.order = input.order;
      return callKw(env, input.model, 'search_read', [input.domain ?? []], kwargs);
    }
    case 'get_record': {
      const kwargs = input.fields ? { fields: input.fields } : {};
      const records = await callKw(env, input.model, 'read', [[input.record_id]], kwargs);
      if (!Array.isArray(records) || !records.length) throw new Error(`${input.model} ${input.record_id} not found or inaccessible`);
      return records[0];
    }
    case 'create_record': {
      const ids = await callKw(env, input.model, 'create', [[input.values]], {});
      const id = Array.isArray(ids) ? ids[0] : ids;
      return { id, created: true };
    }
    case 'update_record': {
      const ok = await callKw(env, input.model, 'write', [[input.record_id], input.values], {});
      return { id: input.record_id, updated: Boolean(ok) };
    }
    case 'delete_record': {
      const ok = await callKw(env, input.model, 'unlink', [[input.record_id]], {});
      return { id: input.record_id, deleted: Boolean(ok) };
    }
    case 'create_records': {
      const ids = await callKw(env, input.model, 'create', [input.vals_list], {});
      const out = Array.isArray(ids) ? ids : [ids];
      return { ids: out, count: out.length };
    }
    case 'update_records': {
      const ok = await callKw(env, input.model, 'write', [input.record_ids, input.values], {});
      return { ids: input.record_ids, count: input.record_ids.length, updated: Boolean(ok) };
    }
    case 'delete_records': {
      const ok = await callKw(env, input.model, 'unlink', [input.record_ids], {});
      return { ids: input.record_ids, count: input.record_ids.length, deleted: Boolean(ok) };
    }
    case 'import_records':
      return callKw(env, input.model, 'load', [input.fields, input.data], {});
    case 'execute_method': {
      if (input.method.startsWith('_')) throw new Error('Private Odoo methods are not allowed');
      const args = [];
      if (Array.isArray(input.ids)) args.push(input.ids);
      if (Array.isArray(input.args)) args.push(...input.args);
      return callKw(env, input.model, input.method, args, input.kwargs ?? {});
    }
    case 'set_binary_field': {
      const sourceUrl = new URL(input.source);
      if (sourceUrl.protocol !== 'https:') throw new Error('source must use HTTPS');
      const r = await fetch(sourceUrl.toString(), { redirect: 'follow' });
      if (!r.ok) throw new Error(`Failed to fetch source file: HTTP ${r.status}`);
      const buf = await r.arrayBuffer();
      if (buf.byteLength > 10 * 1024 * 1024) throw new Error('Source file exceeds 10 MB limit');
      const data = await arrayBufferToBase64(buf);
      const ok = await callKw(env, input.model, 'write', [[input.record_id], { [input.field_name]: data }], {});
      return { id: input.record_id, field_name: input.field_name, bytes: buf.byteLength, updated: Boolean(ok) };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function rpcResult(id, result) { return { jsonrpc: '2.0', id, result }; }
function rpcError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id: id ?? null, error };
}

async function handleRpc(env, message) {
  if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return rpcError(message?.id ?? null, -32600, 'Invalid Request');
  const id = message.id;
  switch (message.method) {
    case 'initialize':
      return rpcResult(id, { protocolVersion: message.params?.protocolVersion || MCP_PROTOCOL_VERSION, capabilities: { tools: { listChanged: false } }, serverInfo: { name: SERVER_NAME, version: SERVER_VERSION }, instructions: "Odoo MCP server for Thrive Advisory Solutions. Access is governed by the dedicated Odoo service account's ACLs." });
    case 'ping': return rpcResult(id, {});
    case 'notifications/initialized':
    case 'notifications/cancelled': return null;
    case 'tools/list': return rpcResult(id, { tools });
    case 'tools/call': {
      const name = message.params?.name;
      const input = message.params?.arguments ?? {};
      if (!tools.some(t => t.name === name)) return rpcError(id, -32602, `Unknown tool: ${name}`);
      try {
        const result = await runTool(env, name, input);
        return rpcResult(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: result });
      } catch (e) {
        return rpcResult(id, { content: [{ type: 'text', text: `Error: ${String(e?.message || e)}` }], isError: true });
      }
    }
    default: return rpcError(id, -32601, 'Method not found');
  }
}

async function tokenMatches(request, expected) {
  const url = new URL(request.url);
  const auth = request.headers.get('authorization') || '';
  const supplied = auth.replace(/^Bearer\s+/i, '') || url.searchParams.get('token') || '';
  if (!supplied || !expected) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(supplied)), crypto.subtle.digest('SHA-256', enc.encode(expected))]);
  const aa = new Uint8Array(a), bb = new Uint8Array(b);
  let diff = aa.length ^ bb.length;
  for (let i = 0; i < Math.min(aa.length, bb.length); i++) diff |= aa[i] ^ bb[i];
  return diff === 0;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') {
      try {
        const uid = sessionUid || await login(env);
        return json({ status: 'ok', name: SERVER_NAME, version: SERVER_VERSION, odoo_connected: true, uid });
      } catch (e) {
        return json({ status: 'degraded', name: SERVER_NAME, version: SERVER_VERSION, odoo_connected: false, error: String(e?.message || e) }, 503);
      }
    }
    if (url.pathname !== '/mcp') return json({ error: 'Not found' }, 404);
    if (!(await tokenMatches(request, env.MCP_AUTH_TOKEN))) return json({ error: 'Unauthorized' }, 401, { 'www-authenticate': 'Bearer' });
    if (request.method === 'GET') return new Response('Streamable HTTP MCP endpoint. Send JSON-RPC 2.0 requests with POST.', { status: 405, headers: { 'content-type': 'text/plain; charset=utf-8', allow: 'POST' } });
    if (request.method === 'DELETE') return new Response(null, { status: 204 });
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, { allow: 'POST, DELETE' });
    let body;
    try { body = await request.json(); } catch { return json(rpcError(null, -32700, 'Parse error'), 400); }
    const response = await handleRpc(env, body);
    if (response === null) return new Response(null, { status: 202 });
    return json(response, 200, { 'mcp-protocol-version': MCP_PROTOCOL_VERSION });
  },
};
