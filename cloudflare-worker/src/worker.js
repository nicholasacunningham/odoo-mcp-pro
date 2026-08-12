const SERVER_NAME = "odoo-mcp-pro";
const SERVER_VERSION = "1.0.0-cloudflare";
const MCP_PROTOCOL_VERSION = "2025-03-26";
let cachedUid = null;

function json(data, status = 200, extraHeaders = {}) {
return new Response(JSON.stringify(data), {
status,
headers: {
"content-type": "application/json; charset=utf-8",
"cache-control": "no-store",
...extraHeaders,
},
});
}

function xmlEscape(value) {
return String(value)
.replace(/&/g, "&amp;")
.replace(/</g, "&lt;")
.replace(/>/g, "&gt;")
.replace(/\"/g, "&quot;")
.replace(/'/g, "&apos;");
}

function xmlUnescape(value) {
return String(value)
.replace(/&lt;/g, "<")
.replace(/&gt;/g, ">")
.replace(/&quot;/g, '"')
.replace(/&apos;/g, "'")
.replace(/&amp;/g, "&")
.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
.replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function serializeXmlRpc(value) {
if (value === null || value === undefined) return "<value><boolean>0</boolean></value>";
if (typeof value === "boolean") return `<value><boolean>${value ? 1 : 0}</boolean></value>`;
if (typeof value === "number") {
if (!Number.isFinite(value)) throw new Error("Cannot serialize non-finite number");
if (Number.isInteger(value)) return `<value><int>${value}</int></value>`;
return `<value><double>${value}</double></value>`;
}
if (typeof value === "string") return `<value><string>${xmlEscape(value)}</string></value>`;
if (Array.isArray(value)) {
return `<value><array><data>${value.map(serializeXmlRpc).join("")}</data></array></value>`;
}
if (typeof value === "object") {
const members = Object.entries(value).map(([k, v]) =>
`<member><name>${xmlEscape(k)}</name>${serializeXmlRpc(v)}</member>`
).join("");
return `<value><struct>${members}</struct></value>`;
}
throw new Error(`Unsupported XML-RPC type: ${typeof value}`);
}

function xmlRpcBody(methodName, params) {
return `<?xml version="1.0"?><methodCall><methodName>${xmlEscape(methodName)}</methodName><params>${params.map(v => `<param>${serializeXmlRpc(v)}</param>`).join("")}</params></methodCall>`;
}

function skipWs(s, pos) {
while (pos < s.length && /\s/.test(s[pos])) pos++;
return pos;
}

function readUntil(s, pos, marker) {
const end = s.indexOf(marker, pos);
if (end < 0) throw new Error(`Malformed XML-RPC response: missing ${marker}`);
return [s.slice(pos, end), end + marker.length];
}

function parseValueAt(s, start) {
let pos = s.indexOf("<value", start);
if (pos < 0) throw new Error("Malformed XML-RPC response: missing <value>");
pos = s.indexOf(">", pos) + 1;
pos = skipWs(s, pos);

if (s.startsWith("</value>", pos)) return { value: "", pos: pos + 8 };
if (s.startsWith("<nil/>", pos)) return { value: null, pos: s.indexOf("</value>", pos) + 8 };
if (s.startsWith("<nil />", pos)) return { value: null, pos: s.indexOf("</value>", pos) + 8 };

const scalarTags = [
["string", v => xmlUnescape(v)],
["int", v => Number(v.trim())],
["i4", v => Number(v.trim())],
["i8", v => Number(v.trim())],
["double", v => Number(v.trim())],
["boolean", v => v.trim() === "1" || v.trim().toLowerCase() === "true"],
["dateTime.iso8601", v => xmlUnescape(v)],
["base64", v => v.replace(/\s+/g, "")],
];

for (const [tag, convert] of scalarTags) {
const open = `<${tag}>`;
if (s.startsWith(open, pos)) {
const [raw, afterClose] = readUntil(s, pos + open.length, `</${tag}>`);
const endValue = s.indexOf("</value>", afterClose);
if (endValue < 0) throw new Error("Malformed XML-RPC response");
return { value: convert(raw), pos: endValue + 8 };
}
}

if (s.startsWith("<array>", pos)) {
const dataStart = s.indexOf("<data>", pos);
const dataEnd = s.indexOf("</data>", dataStart);
if (dataStart < 0 || dataEnd < 0) throw new Error("Malformed XML-RPC array");
const arr = [];
let p = dataStart + 6;
while (true) {
p = skipWs(s, p);
if (p >= dataEnd) break;
const parsed = parseValueAt(s, p);
arr.push(parsed.value);
p = parsed.pos;
}
const endValue = s.indexOf("</value>", dataEnd);
return { value: arr, pos: endValue + 8 };
}

if (s.startsWith("<struct>", pos)) {
const structEnd = s.indexOf("</struct>", pos);
if (structEnd < 0) throw new Error("Malformed XML-RPC struct");
const obj = {};
let p = pos + 8;
while (true) {
p = skipWs(s, p);
const memberStart = s.indexOf("<member>", p);
if (memberStart < 0 || memberStart >= structEnd) break;
const nameStart = s.indexOf("<name>", memberStart);
const nameEnd = s.indexOf("</name>", nameStart);
if (nameStart < 0 || nameEnd < 0 || nameEnd > structEnd) throw new Error("Malformed XML-RPC member");
const name = xmlUnescape(s.slice(nameStart + 6, nameEnd));
const parsed = parseValueAt(s, nameEnd + 7);
obj[name] = parsed.value;
const memberEnd = s.indexOf("</member>", parsed.pos);
p = memberEnd >= 0 ? memberEnd + 9 : parsed.pos;
}
const endValue = s.indexOf("</value>", structEnd);
return { value: obj, pos: endValue + 8 };
}

const endValue = s.indexOf("</value>", pos);
if (endValue < 0) throw new Error("Malformed XML-RPC response");
return { value: xmlUnescape(s.slice(pos, endValue).trim()), pos: endValue + 8 };
}

function parseXmlRpcResponse(xml) {
const faultStart = xml.indexOf("<fault>");
if (faultStart >= 0) {
const parsed = parseValueAt(xml, faultStart);
const fault = parsed.value || {};
const message = fault.faultString || fault.message || JSON.stringify(fault);
throw new Error(`Odoo XML-RPC fault: ${message}`);
}
const paramsStart = xml.indexOf("<params>");
if (paramsStart < 0) throw new Error("Malformed XML-RPC response: missing params");
return parseValueAt(xml, paramsStart).value;
}

async function xmlRpcCall(url, methodName, params) {
const response = await fetch(url, {
method: "POST",
headers: {
"content-type": "text/xml",
"user-agent": "odoo-mcp-pro-cloudflare/1.0",
},
body: xmlRpcBody(methodName, params),
redirect: "error",
});
const text = await response.text();
if (!response.ok) throw new Error(`Odoo HTTP ${response.status}: ${text.slice(0, 300)}`);
return parseXmlRpcResponse(text);
}

async function getUid(env) {
if (cachedUid) return cachedUid;
const uid = await xmlRpcCall(`${env.ODOO_URL}/xmlrpc/2/common`, "authenticate", [
env.ODOO_DB,
env.ODOO_USERNAME,
env.ODOO_PASSWORD,
{},
]);
if (!uid || typeof uid !== "number") throw new Error("Odoo authentication failed");
cachedUid = uid;
return uid;
}

async function executeKw(env, model, method, args = [], kwargs = {}) {
if (!model || !method) throw new Error("model and method are required");
const uid = await getUid(env);
return xmlRpcCall(`${env.ODOO_URL}/xmlrpc/2/object`, "execute_kw", [
env.ODOO_DB,
uid,
env.ODOO_PASSWORD,
model,
method,
args,
{ context: { lang: "en_US" }, ...kwargs },
]);
}

const tools = [
{
name: "server_info",
description: "Return the Cloudflare MCP server version and Odoo connection status.",
inputSchema: { type: "object", properties: {}, additionalProperties: false },
},
{
name: "list_models",
description: "List Odoo models available to the service account.",
inputSchema: {
type: "object",
properties: { limit: { type: "integer", minimum: 1, maximum: 5000, default: 1000 } },
additionalProperties: false,
},
},
{
name: "model_fields",
description: "Inspect fields and metadata for an Odoo model.",
inputSchema: {
type: "object",
properties: {
model: { type: "string" },
attributes: { type: "array", items: { type: "string" } },
},
required: ["model"],
additionalProperties: false,
},
},
{
name: "search_records",
description: "Search records in an Odoo model using an Odoo domain.",
inputSchema: {
type: "object",
properties: {
model: { type: "string" },
domain: { type: "array", default: [] },
fields: { type: "array", items: { type: "string" } },
limit: { type: "integer", minimum: 1, maximum: 1000, default: 100 },
offset: { type: "integer", minimum: 0, default: 0 },
order: { type: "string" },
},
required: ["model"],
additionalProperties: false,
},
},
{
name: "get_record",
description: "Read a single Odoo record by ID.",
inputSchema: {
type: "object",
properties: {
model: { type: "string" },
record_id: { type: "integer" },
fields: { type: "array", items: { type: "string" } },
},
required: ["model", "record_id"],
additionalProperties: false,
},
},
{
name: "create_record",
description: "Create a record in an Odoo model.",
inputSchema: {
type: "object",
properties: { model: { type: "string" }, values: { type: "object" } },
required: ["model", "values"],
additionalProperties: false,
},
},
{
name: "update_record",
description: "Update one Odoo record.",
inputSchema: {
type: "object",
properties: { model: { type: "string" }, record_id: { type: "integer" }, values: { type: "object" } },
required: ["model", "record_id", "values"],
additionalProperties: false,
},
},
{
name: "delete_record",
description: "Delete one Odoo record.",
inputSchema: {
type: "object",
properties: { model: { type: "string" }, record_id: { type: "integer" } },
required: ["model", "record_id"],
additionalProperties: false,
},
},
{
name: "create_records",
description: "Create multiple records in one Odoo call.",
inputSchema: {
type: "object",
properties: { model: { type: "string" }, vals_list: { type: "array", items: { type: "object" }, minItems: 1, maxItems: 1000 } },
required: ["model", "vals_list"],
additionalProperties: false,
},
},
{
name: "update_records",
description: "Update multiple Odoo records with the same values.",
inputSchema: {
type: "object",
properties: { model: { type: "string" }, record_ids: { type: "array", items: { type: "integer" }, minItems: 1, maxItems: 1000 }, values: { type: "object" } },
required: ["model", "record_ids", "values"],
additionalProperties: false,
},
},
{
name: "delete_records",
description: "Delete multiple Odoo records.",
inputSchema: {
type: "object",
properties: { model: { type: "string" }, record_ids: { type: "array", items: { type: "integer" }, minItems: 1, maxItems: 1000 } },
required: ["model", "record_ids"],
additionalProperties: false,
},
},
{
name: "import_records",
description: "Import records with Odoo's native load method, including external IDs.",
inputSchema: {
type: "object",
properties: {
model: { type: "string" },
fields: { type: "array", items: { type: "string" }, minItems: 1 },
data: { type: "array", items: { type: "array", items: { type: "string" } }, minItems: 1 },
},
required: ["model", "fields", "data"],
additionalProperties: false,
},
},
{
name: "execute_method",
description: "Call a public Odoo model or recordset method. Private methods beginning with an underscore are rejected.",
inputSchema: {
type: "object",
properties: {
model: { type: "string" },
method: { type: "string" },
ids: { type: "array", items: { type: "integer" } },
args: { type: "array", default: [] },
kwargs: { type: "object", default: {} },
},
required: ["model", "method"],
additionalProperties: false,
},
},
{
name: "set_binary_field",
description: "Fetch a file from an HTTPS URL and write it to a Binary or Image field on an existing Odoo record.",
inputSchema: {
type: "object",
properties: {
model: { type: "string" },
record_id: { type: "integer" },
field_name: { type: "string" },
source: { type: "string" },
},
required: ["model", "record_id", "field_name", "source"],
additionalProperties: false,
},
},
];

async function arrayBufferToBase64(buffer) {
const bytes = new Uint8Array(buffer);
let binary = "";
const chunk = 0x8000;
for (let i = 0; i < bytes.length; i += chunk) {
binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, bytes.length)));
}
return btoa(binary);
}

async function runTool(env, name, input) {
switch (name) {
case "server_info": {
try {
const uid = await getUid(env);
const version = await fetch(`${env.ODOO_URL}/web/version`, { redirect: "error" }).then(r => r.json());
return { version: SERVER_VERSION, transport: "streamable-http", connected: true, uid, odoo_url: env.ODOO_URL, odoo_version: version.version || version.server_version || null };
} catch (error) {
return { version: SERVER_VERSION, transport: "streamable-http", connected: false, odoo_url: env.ODOO_URL, error: String(error.message || error) };
}
}
case "list_models": {
const limit = Math.min(input.limit ?? 1000, 5000);
return executeKw(env, "ir.model", "search_read", [[]], { fields: ["model", "name"], limit, order: "model asc" });
}
case "model_fields": {
const kwargs = {};
if (input.attributes) kwargs.attributes = input.attributes;
return executeKw(env, input.model, "fields_get", [], kwargs);
}
case "search_records": {
const kwargs = { limit: input.limit ?? 100, offset: input.offset ?? 0 };
if (input.fields) kwargs.fields = input.fields;
if (input.order) kwargs.order = input.order;
return executeKw(env, input.model, "search_read", [input.domain ?? []], kwargs);
}
case "get_record": {
const kwargs = {};
if (input.fields) kwargs.fields = input.fields;
const records = await executeKw(env, input.model, "read", [[input.record_id]], kwargs);
if (!Array.isArray(records) || records.length === 0) throw new Error(`${input.model} ${input.record_id} not found or inaccessible`);
return records[0];
}
case "create_record": {
const id = await executeKw(env, input.model, "create", [input.values]);
return { id, created: true };
}
case "update_record": {
const ok = await executeKw(env, input.model, "write", [[input.record_id], input.values]);
return { id: input.record_id, updated: Boolean(ok) };
}
case "delete_record": {
const ok = await executeKw(env, input.model, "unlink", [[input.record_id]]);
return { id: input.record_id, deleted: Boolean(ok) };
}
case "create_records": {
const ids = await executeKw(env, input.model, "create", [input.vals_list]);
return { ids: Array.isArray(ids) ? ids : [ids], count: Array.isArray(ids) ? ids.length : 1 };
}
case "update_records": {
const ok = await executeKw(env, input.model, "write", [input.record_ids, input.values]);
return { ids: input.record_ids, count: input.record_ids.length, updated: Boolean(ok) };
}
case "delete_records": {
const ok = await executeKw(env, input.model, "unlink", [input.record_ids]);
return { ids: input.record_ids, count: input.record_ids.length, deleted: Boolean(ok) };
}
case "import_records": {
return executeKw(env, input.model, "load", [input.fields, input.data]);
}
case "execute_method": {
if (input.method.startsWith("_")) throw new Error("Private Odoo methods are not allowed");
const args = [];
if (Array.isArray(input.ids)) args.push(input.ids);
if (Array.isArray(input.args)) args.push(...input.args);
return executeKw(env, input.model, input.method, args, input.kwargs ?? {});
}
case "set_binary_field": {
const sourceUrl = new URL(input.source);
if (sourceUrl.protocol !== "https:") throw new Error("source must use HTTPS");
const response = await fetch(sourceUrl.toString(), { redirect: "follow" });
if (!response.ok) throw new Error(`Failed to fetch source file: HTTP ${response.status}`);
const size = Number(response.headers.get("content-length") || "0");
if (size > 10 * 1024 * 1024) throw new Error("Source file exceeds 10 MB Cloudflare MCP limit");
const buf = await response.arrayBuffer();
if (buf.byteLength > 10 * 1024 * 1024) throw new Error("Source file exceeds 10 MB Cloudflare MCP limit");
const data = await arrayBufferToBase64(buf);
const ok = await executeKw(env, input.model, "write", [[input.record_id], { [input.field_name]: data }]);
return { id: input.record_id, field_name: input.field_name, bytes: buf.byteLength, updated: Boolean(ok) };
}
default:
throw new Error(`Unknown tool: ${name}`);
}
}

function rpcResult(id, result) {
return { jsonrpc: "2.0", id, result };
}

function rpcError(id, code, message, data) {
const error = { code, message };
if (data !== undefined) error.data = data;
return { jsonrpc: "2.0", id: id ?? null, error };
}

async function handleRpc(env, message) {
if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
return rpcError(message?.id ?? null, -32600, "Invalid Request");
}
const id = message.id;
switch (message.method) {
case "initialize": {
const requested = message.params?.protocolVersion;
return rpcResult(id, {
protocolVersion: requested || MCP_PROTOCOL_VERSION,
capabilities: { tools: { listChanged: false } },
serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
instructions: "Odoo MCP server for Thrive Advisory Solutions. Odoo access is governed by the dedicated service account's ACLs.",
});
}
case "ping":
return rpcResult(id, {});
case "notifications/initialized":
case "notifications/cancelled":
return null;
case "tools/list":
return rpcResult(id, { tools });
case "tools/call": {
const name = message.params?.name;
const input = message.params?.arguments ?? {};
if (!tools.some(t => t.name === name)) return rpcError(id, -32602, `Unknown tool: ${name}`);
try {
const result = await runTool(env, name, input);
return rpcResult(id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result });
} catch (error) {
const text = String(error?.message || error);
return rpcResult(id, { content: [{ type: "text", text: `Error: ${text}` }], isError: true });
}
}
default:
return rpcError(id, -32601, "Method not found");
}
}

async function tokenMatches(request, env) {
const url = new URL(request.url);
const auth = request.headers.get("authorization") || "";
const bearer = auth.replace(/^Bearer\s+/i, "");
const supplied = bearer || url.searchParams.get("token") || "";
if (!supplied || !env.MCP_AUTH_TOKEN) return false;
const enc = new TextEncoder();
const [a, b] = await Promise.all([
crypto.subtle.digest("SHA-256", enc.encode(supplied)),
crypto.subtle.digest("SHA-256", enc.encode(env.MCP_AUTH_TOKEN)),
]);
const aa = new Uint8Array(a);
const bb = new Uint8Array(b);
if (aa.length !== bb.length) return false;
let diff = 0;
for (let i = 0; i < aa.length; i++) diff |= aa[i] ^ bb[i];
return diff === 0;
}

export default {
async fetch(request, env) {
const url = new URL(request.url);

if (request.method === "GET" && url.pathname === "/health") {
return json({ status: "ok", name: SERVER_NAME, version: SERVER_VERSION });
}

if (url.pathname !== "/mcp") return json({ error: "Not found" }, 404);
if (!(await tokenMatches(request, env))) return json({ error: "Unauthorized" }, 401, { "www-authenticate": "Bearer" });

if (request.method === "GET") {
return new Response("Streamable HTTP MCP endpoint. Send JSON-RPC 2.0 requests with POST.", {
status: 405,
headers: { "content-type": "text/plain; charset=utf-8", "allow": "POST" },
});
}
if (request.method === "DELETE") return new Response(null, { status: 204 });
if (request.method !== "POST") return json({ error: "Method not allowed" }, 405, { allow: "POST, DELETE" });

let body;
try {
body = await request.json();
} catch {
return json(rpcError(null, -32700, "Parse error"), 400);
}

const response = await handleRpc(env, body);
if (response === null) return new Response(null, { status: 202 });
return json(response, 200, { "mcp-protocol-version": MCP_PROTOCOL_VERSION });
},
};
