#!/usr/bin/env node
/**
 * inv.bg MCP server (read-only)
 *
 * Zero dependencies – uses the built-in fetch of Node 18+.
 * Authorisation: Bearer token from the INV_BG_TOKEN environment variable.
 * A long-lived token is generated in inv.bg: Settings → Company → API access.
 *
 * Environment:
 *   INV_BG_TOKEN         – required, the API token
 *   INV_BG_BASE          – optional, default https://api.inv.bg/v3 (must be https)
 *   INV_BG_DOWNLOAD_DIR  – optional, where PDFs are saved, default ~/inv-bg-invoices
 *
 * CLI: `node server.js --selftest` checks the token without an MCP client.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const VERSION = '1.0.0';

/**
 * The token travels in a header, so the base URL must be https. A plain http
 * base would send it unencrypted.
 */
function resolveBase(raw) {
  const value = (raw || 'https://api.inv.bg/v3').replace(/\/+$/, '');
  let url;
  try {
    url = new URL(value);
  } catch (_) {
    throw new Error(`INV_BG_BASE is not a valid URL: ${value}`);
  }
  if (url.protocol !== 'https:') {
    throw new Error(`INV_BG_BASE must use https, got ${url.protocol}//. The API token would otherwise travel unencrypted.`);
  }
  return value;
}

const BASE = resolveBase(process.env.INV_BG_BASE);
const BASE_URL = new URL(BASE);
const BASE_ORIGIN = BASE_URL.origin;
const BASE_PATH = BASE_URL.pathname.replace(/\/+$/, '');
const TOKEN = process.env.INV_BG_TOKEN || '';
const DOWNLOAD_DIR = path.resolve(process.env.INV_BG_DOWNLOAD_DIR || path.join(os.homedir(), 'inv-bg-invoices'));

const TIMEOUT_JSON_MS = 30_000;
const TIMEOUT_PDF_MS = 60_000;

/* ------------------------------------------------------------------ HTTP */

/**
 * Some array filters carry the brackets in the parameter name itself, others
 * do not. This is not a serialisation convention but a difference in the
 * inv.bg OpenAPI spec: `type[]`, `currency[]` and `payment_processor[]` are
 * bracketed, while `expand` and `bank_account_id` repeat as a bare key. Hence
 * an explicit list instead of appending `[]` to every array.
 *
 * `status` is the exception where the spec is wrong: it is documented as a
 * bare `status`, but a repeated bare key does not form a union – the last
 * value wins. `status=paid&status=unpaid` returns only the unpaid documents,
 * while `status[]=paid&status[]=unpaid` returns both. A wrong name is ignored
 * silently, so it belongs here.
 */
const BRACKETED_ARRAY_PARAMS = new Set(['type', 'status', 'currency', 'payment_processor']);

/**
 * End dates in inv.bg are compared against `YYYY-MM-DD 00:00:00`, while
 * documents are created at 00:00:01. So `date_to=2026-07-31` drops the whole
 * of 31 July, and `date_to=2026-07-31T23:59:59` keeps it. We therefore append
 * the end of the day unless the caller already passed a time.
 */
const END_OF_DAY_PARAMS = new Set(['date_to', 'to_date', 'paid_to', 'date_mature_to']);

function normaliseQueryValue(key, value) {
  if (END_OF_DAY_PARAMS.has(key) && typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return value + 'T23:59:59';
  }
  return value;
}

function buildUrl(endpoint, query) {
  const url = new URL(BASE + (endpoint.startsWith('/') ? endpoint : '/' + endpoint));
  // The URL parser resolves `..`, so this also catches an endpoint that climbs
  // out of the API path while staying on the same host.
  if (url.origin !== BASE_ORIGIN || !(url.pathname === BASE_PATH || url.pathname.startsWith(BASE_PATH + '/'))) {
    throw new Error(`Endpoint "${endpoint}" points outside ${BASE}. Only paths inside the inv.bg API are allowed.`);
  }
  for (const [k, v] of Object.entries(query || {})) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) {
      if (v.length === 0) continue;
      const key = k.endsWith('[]') || !BRACKETED_ARRAY_PARAMS.has(k) ? k : k + '[]';
      for (const item of v) url.searchParams.append(key, String(item));
    } else {
      url.searchParams.append(k, String(normaliseQueryValue(k, v)));
    }
  }
  return url;
}

async function apiRequest(endpoint, query, { raw = false, language } = {}) {
  if (!TOKEN) throw new Error('INV_BG_TOKEN is not set in the server environment.');
  const url = buildUrl(endpoint, query);
  const headers = { Authorization: `Bearer ${TOKEN}`, Accept: raw ? '*/*' : 'application/json' };
  if (language) headers['Accept-Language'] = language;

  const timeoutMs = raw ? TIMEOUT_PDF_MS : TIMEOUT_JSON_MS;
  let res;
  try {
    // inv.bg does not redirect legitimately. Following a redirect could carry
    // the Authorization header to another host on older Node 18 releases.
    res = await fetch(url, { method: 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new Error(`inv.bg did not respond within ${timeoutMs / 1000} seconds for ${url.pathname}. Try again or narrow the filter.`);
    }
    throw new Error(`Could not reach inv.bg (${url.pathname}): ${err && err.message ? err.message : err}`);
  }

  if (res.status === 401 || res.status === 403) {
    throw new Error(
      `inv.bg denied access (HTTP ${res.status}). Check that the token is valid and that your plan includes API access. URL: ${url.pathname}`
    );
  }
  if (res.status === 404) {
    throw new Error(`inv.bg could not find ${url.pathname} (HTTP 404). Check the ID or the path.`);
  }
  if (res.status === 429) {
    throw new Error(`inv.bg rejected the request because of a rate limit (HTTP 429) for ${url.pathname}. Wait and send fewer requests.`);
  }
  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 500);
    } catch (_) {}
    throw new Error(`inv.bg returned HTTP ${res.status} for ${url.pathname}${detail ? ': ' + detail : ''}`);
  }
  if (raw) return Buffer.from(await res.arrayBuffer());
  return res.json();
}

/* ------------------------------------------------------------ validation */

function checkValue(label, value, spec) {
  if (value === undefined || value === null) return;

  if (spec.type === 'array') {
    if (!Array.isArray(value)) {
      throw new Error(`"${label}" must be a list, got: ${JSON.stringify(value)}.`);
    }
    for (const item of value) checkValue(label, item, spec.items || {});
    return;
  }
  if (spec.type === 'integer' && !Number.isInteger(value)) {
    throw new Error(`"${label}" must be an integer, got: ${JSON.stringify(value)}.`);
  }
  if (spec.type === 'boolean' && typeof value !== 'boolean') {
    throw new Error(`"${label}" must be true or false, got: ${JSON.stringify(value)}.`);
  }
  if (spec.type === 'string' && typeof value !== 'string') {
    throw new Error(`"${label}" must be a string, got: ${JSON.stringify(value)}.`);
  }
  if (spec.type === 'object' && (typeof value !== 'object' || Array.isArray(value))) {
    throw new Error(`"${label}" must be an object, got: ${JSON.stringify(value)}.`);
  }
  if (spec.enum && !spec.enum.includes(value)) {
    throw new Error(`"${label}" must be one of: ${spec.enum.join(', ')}. Got: ${JSON.stringify(value)}.`);
  }
  if (spec.pattern && !new RegExp(spec.pattern).test(value)) {
    throw new Error(`"${label}" has the wrong format (got: ${JSON.stringify(value)}). Expected: ${spec.formatHint || spec.pattern}.`);
  }
  if (spec.minimum !== undefined && value < spec.minimum) {
    throw new Error(`"${label}" must be at least ${spec.minimum}, got: ${value}.`);
  }
}

function validateArgs(tool, args) {
  const props = tool.inputSchema.properties || {};
  for (const req of tool.inputSchema.required || []) {
    if (args[req] === undefined || args[req] === null) {
      throw new Error(`Missing required parameter "${req}" for ${tool.name}.`);
    }
  }
  for (const [key, value] of Object.entries(args)) {
    const spec = props[key];
    if (!spec) {
      const allowed = Object.keys(props);
      throw new Error(
        `Unknown parameter "${key}" for ${tool.name}.` +
          (allowed.length ? ` Allowed: ${allowed.join(', ')}.` : ' The tool takes no parameters.')
      );
    }
    checkValue(key, value, spec);
  }
}

/* ----------------------------------------------------------------- utils */

function slug(s) {
  return String(s || '')
    .replace(/[\/\\:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

const TYPE_LABELS = {
  dan: 'tax invoice',
  deb: 'debit note',
  cred: 'credit note',
  prof: 'proforma invoice',
  protocol: 'protocol',
  custom: 'other document',
};

function dateOnly(value) {
  return typeof value === 'string' ? value.slice(0, 10) : '';
}

function invoiceDate(inv) {
  return dateOnly(inv.date_create) || dateOnly(inv.date_event);
}

function pdfFileName(inv, language) {
  const raw = invoiceDate(inv);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : 'undated';
  const num = inv.number != null ? String(inv.number).padStart(10, '0') : `id${inv.id}`;
  const who = slug(inv.to_name || inv.recipient || 'client');
  // The Bulgarian version has no suffix; other languages get one so that both
  // versions can live in the same folder.
  const lang = language && language !== 'bg' ? `_${language.toUpperCase()}` : '';
  return `${date}_${num}_${who}${lang}.pdf`;
}

/**
 * Resolves `dest_dir` inside INV_BG_DOWNLOAD_DIR. A relative path is taken as
 * a subfolder; an absolute path must already lie inside. This keeps a model
 * steered by document contents from writing files anywhere else on disk.
 */
function resolveDestDir(destDir, root = DOWNLOAD_DIR) {
  if (!destDir) return root;
  const resolved = path.resolve(root, destDir);
  const rel = path.relative(root, resolved);
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return resolved;
  throw new Error(`dest_dir must be inside INV_BG_DOWNLOAD_DIR (${root}). Got: ${destDir}`);
}

function pdfTargetPath(inv, destDir, language) {
  const year = invoiceDate(inv).slice(0, 4);
  const folder = /^\d{4}$/.test(year) ? year : 'undated';
  return path.join(resolveDestDir(destDir), folder, pdfFileName(inv, language));
}

function summariseInvoice(inv) {
  return {
    id: inv.id,
    number: inv.number,
    type: inv.type,
    type_label: TYPE_LABELS[inv.type] || inv.type,
    date: invoiceDate(inv),
    due: dateOnly(inv.date_mature) || null,
    client: inv.to_name,
    client_id: inv.client_id,
    total: inv.payment_amount_total,
    currency: inv.payment_currency,
    // `status` is the only reliable payment indicator. `balance_paid` and
    // `balance_due` come from the payments register; if the account does not
    // keep it, they stay at 0 and "the full amount" even on a document with
    // status "paid". They are returned together so that debt is not read from
    // the balances alone.
    status: inv.status,
    paid: inv.balance_paid,
    due_amount: inv.balance_due,
    is_draft: !!inv.is_draft,
    is_annulled: !!inv.is_annulled,
  };
}

function summariseClient(c) {
  return {
    id: c.id,
    name: c.name,
    bulstat: c.bulstat,
    vat_number: c.vat_number,
    mol: c.mol,
    town: c.town,
    country: c.country,
    is_person: !!c.is_person,
    is_reg_vat: !!c.is_reg_vat,
    deleted: !!c.deleted,
  };
}

function summarisePayment(p) {
  return {
    id: p.id,
    date: dateOnly(p.paid_at),
    kind: p.is_expense ? 'expense' : 'income',
    amount: p.amount,
    currency: p.currency,
    processor: p.payment_processor,
    contragent: p.contragent,
    contragent_id: p.contragent_id,
    amount_left: p.amount_left,
    note: p.note,
  };
}

/**
 * inv.bg returns `next_page` as a URI, not a number, so the model cannot pass
 * it back into `page`. We translate it to has_more plus a page number.
 */
function paginate(data, items, query, summarise) {
  const page = (query && query.page) || 1;
  return {
    total: data.total,
    count: items.length,
    page,
    has_more: !!data.next_page,
    next_page: data.next_page ? page + 1 : null,
    items: items.map(summarise),
  };
}

const PAGE_SIZE = 100;

/**
 * Fetches consecutive pages of /invoices until they run out or `max` is
 * reached. Returns `truncated` so that a partial result does not look complete.
 */
async function fetchInvoicesUpTo(filters, max) {
  const invoices = [];
  let total = null;
  let page = 1;
  let exhausted = false;

  while (invoices.length < max) {
    const data = await apiRequest('/invoices', { ...filters, page, per_page: PAGE_SIZE });
    if (total === null) total = data.total;
    const batch = data.invoices || [];
    invoices.push(...batch);
    if (!data.next_page || batch.length === 0) {
      exhausted = true;
      break;
    }
    page += 1;
  }

  // A page holds 100 documents and `max` may be smaller – then the result is
  // partial even though the walk has finished. So truncated is measured against
  // what is left out of the returned list, not only against exhaustion.
  if (invoices.length > max) invoices.length = max;
  const truncated = !exhausted || (total != null && invoices.length < total);
  return { invoices, total, truncated };
}

async function savePdf(inv, destDir, overwrite, language) {
  const target = pdfTargetPath(inv, destDir, language);
  if (!overwrite && fs.existsSync(target)) {
    return { id: inv.id, number: inv.number, path: target, skipped: true, reason: 'file already exists' };
  }
  // The PDF language is chosen with Accept-Language (bg/en), not a query parameter.
  const pdf = await apiRequest(`/invoices/${inv.id}/pdf`, {}, { raw: true, language });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, pdf);
  return { id: inv.id, number: inv.number, path: target, bytes: pdf.length, skipped: false };
}

async function downloadInvoicePdf(id, destDir, overwrite, language) {
  // Resolve the folder before any request, so a bad dest_dir fails fast.
  resolveDestDir(destDir);
  const detail = await apiRequest(`/invoices/${id}`, {});
  return savePdf(detail.invoice || detail, destDir, overwrite, language);
}

/**
 * Turnover is computed locally because /reports/* returns "Not implemented Yet".
 * Credit notes come back with a positive amount, so they are subtracted here.
 * Proformas are not turnover and are left out unless asked for explicitly.
 */
const TURNOVER_DEFAULT_TYPES = ['dan', 'deb', 'cred'];

function signedAmount(inv) {
  const amount = Number(inv.payment_amount_total) || 0;
  return inv.type === 'cred' ? -Math.abs(amount) : amount;
}

function computeTurnover(invoices, grouping) {
  const live = invoices.filter((i) => !i.is_draft && !i.is_annulled);
  const buckets = new Map();
  for (const inv of live) {
    const key =
      grouping === 'client'
        ? inv.to_name || `client ${inv.client_id}`
        : grouping === 'month'
          ? invoiceDate(inv).slice(0, 7)
          : 'total';
    const currency = inv.payment_currency || '?';
    const bucketKey = `${key}||${currency}`;
    const bucket = buckets.get(bucketKey) || { key, currency, count: 0, total: 0 };
    bucket.count += 1;
    bucket.total += signedAmount(inv);
    buckets.set(bucketKey, bucket);
  }

  const round2 = (n) => Math.round(n * 100) / 100;
  const rows = [...buckets.values()].map((b) => ({ ...b, total: round2(b.total) })).sort((a, b) => b.total - a.total);

  // Currencies are not added into one number – the exchange rate at each
  // document's date is not part of this response, and adding EUR to BGN would
  // mislead.
  const totalsByCurrency = {};
  for (const row of rows) totalsByCurrency[row.currency] = round2((totalsByCurrency[row.currency] || 0) + row.total);

  return { counted: live.length, skipped: invoices.length - live.length, rows, totalsByCurrency };
}

/* ----------------------------------------------------------------- tools */

const DATE_PARAM = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', formatHint: 'YYYY-MM-DD' };
const DOCUMENT_TYPES = ['dan', 'deb', 'cred', 'prof', 'protocol', 'custom'];

const LIST_FILTERS = {
  type: {
    type: 'array',
    items: { type: 'string', enum: DOCUMENT_TYPES },
    description: 'Document type: dan – tax invoice, deb – debit note, cred – credit note, prof – proforma, protocol, custom',
  },
  status: { type: 'array', items: { type: 'string', enum: ['paid', 'unpaid', 'partially-paid'] }, description: 'Payment status' },
  client_id: { type: 'integer', description: 'Client ID' },
  to_name: { type: 'string', description: 'Client name; supports % and _ as wildcards' },
  number: { type: 'string', description: 'Document number' },
  date_from: { ...DATE_PARAM, description: 'Start date, YYYY-MM-DD' },
  date_to: { ...DATE_PARAM, description: 'End date, YYYY-MM-DD, inclusive' },
  search: { type: 'string', description: 'Free-text search' },
  page: { type: 'integer', minimum: 1, description: 'Page, default 1' },
  per_page: { type: 'integer', minimum: 1, description: 'Items per page, default 50' },
  order_by: { type: 'string', description: 'Field to sort by' },
  order: { type: 'string', enum: ['asc', 'desc'], description: 'Sort direction' },
};

const LANGUAGE_PARAM = {
  type: 'string',
  enum: ['bg', 'en'],
  description: 'PDF language (sent as Accept-Language). Default bg. Use en for foreign clients; the file gets an _EN suffix.',
};

const DEST_DIR_PARAM = {
  type: 'string',
  description: 'Subfolder of INV_BG_DOWNLOAD_DIR to save into; default is INV_BG_DOWNLOAD_DIR itself. Paths outside it are rejected.',
};

/* -------------------------------------------------------- output schemas */

/**
 * List tools return a summary, or the raw inv.bg response with `full: true`.
 * The schemas describe the summary but stay valid for the raw variant: extra
 * fields are allowed, and names that appear in both (id, number, type, status,
 * paid, is_draft…) carry the same type. The one difference is `next_page`: a
 * page number here, a URI in the raw response.
 */
const PAGINATION_OUTPUT = {
  total: { type: 'integer', description: 'Total records matching the filter, not only on this page' },
  count: { type: 'integer', description: 'Records on this page' },
  page: { type: 'integer', description: 'Which page was returned' },
  has_more: { type: 'boolean', description: 'Whether more pages exist' },
  next_page: {
    type: ['integer', 'string', 'null'],
    description: 'Next page number to pass in page; with full: true – the raw inv.bg URI, which cannot be passed back',
  },
};

function listOutputSchema(key, itemProperties, itemsDescription) {
  return {
    type: 'object',
    properties: {
      ...PAGINATION_OUTPUT,
      [key]: {
        type: 'array',
        description: itemsDescription,
        items: { type: 'object', properties: itemProperties },
      },
    },
    required: ['total', key],
  };
}

const INVOICE_ITEM_OUTPUT = {
  id: { type: 'integer', description: 'Document ID – pass it to inv_get_invoice' },
  number: { type: 'integer', description: 'Document number' },
  type: { type: 'string', description: 'Type code: dan, deb, cred, prof, protocol, custom' },
  type_label: { type: 'string', description: 'Human-readable type; absent with full: true' },
  date: { type: 'string', description: 'Issue date, YYYY-MM-DD' },
  due: { type: ['string', 'null'], description: 'Due date, or null if none' },
  client: { type: 'string', description: 'Client name' },
  client_id: { type: 'integer', description: 'Client ID' },
  total: { type: 'number', description: 'Total amount including VAT' },
  currency: { type: 'string', description: 'Document currency' },
  status: { type: 'string', description: 'paid, unpaid or partially-paid – the only reliable payment indicator in inv.bg' },
  paid: { type: 'number', description: 'Paid according to the payments register; stays 0 on paid documents if the register is not kept. Do not read it as debt.' },
  due_amount: { type: 'number', description: 'Remaining amount according to the same register – equally unreliable' },
  is_draft: { type: 'boolean', description: 'Draft' },
  is_annulled: { type: 'boolean', description: 'Annulled document' },
};

const CLIENT_ITEM_OUTPUT = {
  id: { type: 'integer', description: 'Client ID – usable in the client_id filter' },
  name: { type: ['string', 'null'], description: 'Name' },
  bulstat: { type: ['string', 'null'], description: 'Company ID (EIK/BULSTAT)' },
  vat_number: { type: ['string', 'null'], description: 'VAT number' },
  mol: { type: ['string', 'null'], description: 'Legal representative (MOL)' },
  town: { type: ['string', 'null'], description: 'Town' },
  country: { type: ['string', 'null'], description: 'Country' },
  is_person: { type: 'boolean', description: 'Private individual' },
  is_reg_vat: { type: 'boolean', description: 'VAT registered' },
  deleted: { type: 'boolean', description: 'Deleted client' },
};

// The amount types have not been checked against live data, so they are
// described but not pinned, to avoid a client rejecting a valid response.
const PAYMENT_ITEM_OUTPUT = {
  id: { type: 'integer', description: 'Payment ID' },
  date: { type: 'string', description: 'Payment date, YYYY-MM-DD' },
  kind: { type: 'string', description: '"income" or "expense"' },
  amount: { description: 'Amount' },
  currency: { description: 'Currency' },
  processor: { description: 'Payment method' },
  contragent: { description: 'Counterparty' },
  contragent_id: { description: 'Counterparty ID' },
  amount_left: { description: 'Unallocated remainder' },
  note: { description: 'Note' },
};

const PDF_RESULT_OUTPUT = {
  id: { type: 'integer', description: 'Document ID' },
  number: { type: 'integer', description: 'Document number' },
  path: { type: 'string', description: 'Full path of the saved PDF' },
  bytes: { type: 'integer', description: 'Size of the saved file; absent when skipped' },
  skipped: { type: 'boolean', description: 'true if the file was already there and was not downloaded again' },
  reason: { type: 'string', description: 'Why it was skipped' },
  error: { type: 'string', description: 'Error for this document; the others carry on' },
};

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const WRITES_FILES = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true };

const TOOLS = [
  {
    name: 'inv_get_firm',
    description: 'Company details in inv.bg. Also useful as a check that the token works.',
    annotations: { title: 'inv.bg: company details', ...READ_ONLY },
    inputSchema: { type: 'object', properties: {} },
    // The shape belongs to inv.bg, not to us – so the known fields are only
    // described, with no `required`, so the response does not break if the API
    // changes something.
    outputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'Company ID in inv.bg' },
        name: { type: 'string', description: 'Name' },
        bulstat: { type: 'string', description: 'Company ID (EIK/BULSTAT)' },
        vat_number: { type: 'string', description: 'VAT number' },
        is_reg_vat: { type: 'boolean', description: 'VAT registered' },
        town: { type: 'string', description: 'Town' },
        address: { type: 'string', description: 'Address' },
        mol: { type: 'string', description: 'Legal representative (MOL)' },
        email: { type: 'string', description: 'Email' },
        default_currency: { description: 'Default currency' },
      },
    },
    handler: async () => apiRequest('/firm', {}),
  },
  {
    name: 'inv_list_invoices',
    description:
      'List issued documents (invoices, proformas, credit and debit notes) filtered by type, payment status, client and period. Returns one page of summarised fields; use inv_get_invoice for the full data of one document.',
    annotations: { title: 'inv.bg: list documents', ...READ_ONLY },
    inputSchema: { type: 'object', properties: { ...LIST_FILTERS, full: { type: 'boolean', description: 'Return the raw response instead of a summary' } } },
    outputSchema: listOutputSchema('invoices', INVOICE_ITEM_OUTPUT, 'Documents on this page; with full: true – the raw inv.bg records with all their fields'),
    handler: async (args) => {
      const { full, ...query } = args;
      const data = await apiRequest('/invoices', query);
      if (full) return data;
      const { items, ...rest } = paginate(data, data.invoices || [], query, summariseInvoice);
      return { ...rest, invoices: items };
    },
  },
  {
    name: 'inv_get_invoice',
    description: 'Full data of one document by its ID, including the line items.',
    annotations: { title: 'inv.bg: one document', ...READ_ONLY },
    inputSchema: { type: 'object', properties: { id: { type: 'integer', description: 'Document ID' } }, required: ['id'] },
    // The raw inv.bg document – about 60 fields. The ones the tool is usually
    // called for are described; the rest come through as they are.
    outputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'Document ID' },
        number: { type: 'integer', description: 'Number' },
        type: { type: 'string', description: 'Type code: dan, deb, cred, prof, protocol, custom' },
        status: { type: 'string', description: 'paid, unpaid or partially-paid' },
        to_name: { type: 'string', description: 'Client' },
        client_id: { type: 'integer', description: 'Client ID' },
        date_create: { type: 'string', description: 'Issue date (ISO 8601)' },
        date_event: { description: 'Tax event date' },
        date_mature: { description: 'Due date' },
        payment_amount_total: { type: 'number', description: 'Total amount including VAT' },
        payment_amount_base: { description: 'Tax base' },
        payment_amount_vat: { description: 'VAT' },
        payment_currency: { description: 'Currency' },
        currency_rate: { description: 'Exchange rate to the base currency' },
        items: { type: 'array', description: 'Line items', items: { type: 'object' } },
        notes: { description: 'Notes' },
        is_draft: { type: 'boolean', description: 'Draft' },
        is_annulled: { type: 'boolean', description: 'Annulled' },
      },
    },
    handler: async (args) => apiRequest(`/invoices/${args.id}`, {}),
  },
  {
    name: 'inv_download_invoice_pdf',
    description:
      'Download the PDF of one document and save it locally, in INV_BG_DOWNLOAD_DIR sorted into a folder per year. An existing file is skipped unless overwrite is true.',
    annotations: { title: 'inv.bg: download PDF', ...WRITES_FILES },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'Document ID' },
        dest_dir: DEST_DIR_PARAM,
        overwrite: { type: 'boolean', description: 'Overwrite the file if it already exists' },
        language: LANGUAGE_PARAM,
      },
      required: ['id'],
    },
    outputSchema: {
      type: 'object',
      properties: PDF_RESULT_OUTPUT,
      required: ['id', 'path', 'skipped'],
    },
    handler: async (args) => downloadInvoicePdf(args.id, args.dest_dir, !!args.overwrite, args.language),
  },
  {
    name: 'inv_sync_invoices',
    description:
      'Archive the PDFs of documents for a period – walks all pages and downloads only the missing files. Stops at limit documents (default 100) and then returns truncated: true.',
    annotations: { title: 'inv.bg: archive PDFs', ...WRITES_FILES },
    inputSchema: {
      type: 'object',
      properties: {
        date_from: { ...DATE_PARAM, description: 'Start date, YYYY-MM-DD' },
        date_to: { ...DATE_PARAM, description: 'End date, YYYY-MM-DD, inclusive' },
        type: LIST_FILTERS.type,
        dest_dir: DEST_DIR_PARAM,
        language: LANGUAGE_PARAM,
        limit: { type: 'integer', minimum: 1, description: 'Maximum documents to process in one call, default 100' },
      },
    },
    outputSchema: {
      type: 'object',
      properties: {
        total_matching: { type: ['integer', 'null'], description: 'How many documents match the filter in total' },
        processed: { type: 'integer', description: 'How many were processed this time' },
        truncated: { type: 'boolean', description: 'true if limit stopped the walk before the end – the archive is partial' },
        note: { type: 'string', description: 'Explanation when something was left unprocessed' },
        downloaded: { type: 'integer', description: 'Newly downloaded files' },
        already_present: { type: 'integer', description: 'Skipped because they were already there' },
        failed: { type: 'integer', description: 'Documents with an error' },
        results: { type: 'array', description: 'One row per document', items: { type: 'object', properties: PDF_RESULT_OUTPUT } },
      },
      required: ['processed', 'truncated', 'downloaded', 'already_present', 'failed', 'results'],
    },
    handler: async (args) => {
      const { dest_dir, limit, language, ...filters } = args;
      resolveDestDir(dest_dir);
      const { invoices, total, truncated } = await fetchInvoicesUpTo(filters, limit || 100);

      const results = [];
      for (const inv of invoices) {
        try {
          results.push(await savePdf(inv, dest_dir, false, language));
        } catch (err) {
          results.push({ id: inv.id, number: inv.number, error: String(err.message || err) });
        }
      }

      return {
        total_matching: total,
        processed: results.length,
        truncated,
        note: truncated
          ? `Processed the first ${results.length} of ${total} documents. Raise limit or narrow the period to cover the rest.`
          : undefined,
        downloaded: results.filter((r) => r.skipped === false && !r.error).length,
        already_present: results.filter((r) => r.skipped).length,
        failed: results.filter((r) => r.error).length,
        results,
      };
    },
  },
  {
    name: 'inv_list_clients',
    description: "List the company's clients. Returns summarised fields; use full for the raw response.",
    annotations: { title: 'inv.bg: clients', ...READ_ONLY },
    inputSchema: {
      type: 'object',
      properties: {
        search: LIST_FILTERS.search,
        page: LIST_FILTERS.page,
        per_page: LIST_FILTERS.per_page,
        order_by: LIST_FILTERS.order_by,
        order: LIST_FILTERS.order,
        full: { type: 'boolean', description: 'Return the raw response instead of a summary' },
      },
    },
    outputSchema: listOutputSchema('clients', CLIENT_ITEM_OUTPUT, 'Clients on this page; with full: true – the raw inv.bg records'),
    handler: async (args) => {
      const { full, ...query } = args;
      const data = await apiRequest('/clients', query);
      if (full) return data;
      const { items, ...rest } = paginate(data, data.clients || [], query, summariseClient);
      return { ...rest, clients: items };
    },
  },
  {
    name: 'inv_list_payments',
    description: 'List payments (income and expenses). Returns summarised fields; use full for the raw response.',
    annotations: { title: 'inv.bg: payments', ...READ_ONLY },
    inputSchema: {
      type: 'object',
      properties: {
        date_from: LIST_FILTERS.date_from,
        date_to: LIST_FILTERS.date_to,
        expense: { type: 'integer', enum: [0, 1], description: '1 – expenses only, 0 – income only' },
        page: LIST_FILTERS.page,
        per_page: LIST_FILTERS.per_page,
        full: { type: 'boolean', description: 'Return the raw response instead of a summary' },
      },
    },
    outputSchema: listOutputSchema(
      'payments',
      PAYMENT_ITEM_OUTPUT,
      'Payments on this page. Many accounts do not keep the payments register – then expect total: 0 and read the status field of the documents instead.'
    ),
    handler: async (args) => {
      const { full, ...query } = args;
      const data = await apiRequest('/payments', query);
      if (full) return data;
      const { items, ...rest } = paginate(data, data.payments || [], query, summarisePayment);
      return { ...rest, payments: items };
    },
  },
  {
    name: 'inv_turnover',
    description:
      'Turnover for a period – totals issued documents by client, by month or overall. Computed locally from the document list, because the inv.bg reports (/reports/*) return "Not implemented Yet". By default counts tax invoices and debit notes and subtracts credit notes; proformas are included only if requested in type.',
    annotations: { title: 'inv.bg: turnover for a period', ...READ_ONLY },
    inputSchema: {
      type: 'object',
      properties: {
        date_from: { ...DATE_PARAM, description: 'Start date, YYYY-MM-DD' },
        date_to: { ...DATE_PARAM, description: 'End date, YYYY-MM-DD, inclusive' },
        type: { ...LIST_FILTERS.type, description: 'Document types to count; default dan, deb, cred. Credit notes (cred) are always subtracted.' },
        client_id: LIST_FILTERS.client_id,
        group_by: {
          type: 'string',
          enum: ['client', 'month', 'none'],
          description: 'Breakdown: by client (default), by month, or none',
        },
        limit: { type: 'integer', minimum: 1, description: 'Cap on processed documents, default 1000' },
      },
    },
    outputSchema: {
      type: 'object',
      properties: {
        matching_documents: { type: ['integer', 'null'], description: 'How many documents match the filter' },
        counted: { type: 'integer', description: 'How many are in the totals – drafts and annulled documents excluded' },
        skipped_drafts_or_annulled: { type: 'integer', description: 'How many were excluded as draft or annulled' },
        truncated: { type: 'boolean', description: 'true if limit stopped the walk – the totals are incomplete' },
        types: { type: 'array', items: { type: 'string' }, description: 'Document types that were counted' },
        group_by: { type: 'string', enum: ['client', 'month', 'none'], description: 'The breakdown used for the rows' },
        totals_by_currency: {
          type: 'object',
          description: "Total for each currency separately. Currencies are not added into one number – the exchange rate at each document's date is not part of the response.",
          additionalProperties: { type: 'number' },
        },
        rows: {
          type: 'array',
          description: 'Breakdown rows, sorted by descending total',
          items: {
            type: 'object',
            properties: {
              key: { type: 'string', description: 'Client, month (YYYY-MM) or "total", depending on group_by' },
              currency: { type: 'string', description: 'Row currency' },
              count: { type: 'integer', description: 'Number of documents in the row' },
              total: { type: 'number', description: 'Row total, credit notes subtracted' },
            },
          },
        },
      },
      required: ['counted', 'truncated', 'group_by', 'totals_by_currency', 'rows'],
    },
    handler: async (args) => {
      const { group_by, limit, ...filters } = args;
      const types = filters.type && filters.type.length ? filters.type : TURNOVER_DEFAULT_TYPES;
      const { invoices, total, truncated } = await fetchInvoicesUpTo({ ...filters, type: types }, limit || 1000);
      const grouping = group_by || 'client';
      const { counted, skipped, rows, totalsByCurrency } = computeTurnover(invoices, grouping);
      return {
        matching_documents: total,
        counted,
        skipped_drafts_or_annulled: skipped,
        truncated,
        types,
        group_by: grouping,
        totals_by_currency: totalsByCurrency,
        rows,
      };
    },
  },
  {
    name: 'inv_api_get',
    description:
      'Fallback tool: a raw GET to any endpoint of the inv.bg API v3 (for example /invoices/types, /bank/accounts, /utils/check-vat/BG123456789). Read-only. The response shape depends on the endpoint and may be a list, so this tool has no outputSchema – the others do.',
    annotations: { title: 'inv.bg: raw GET', ...READ_ONLY },
    inputSchema: {
      type: 'object',
      properties: {
        endpoint: { type: 'string', description: 'Path after /v3, for example /invoices/types' },
        query: { type: 'object', description: 'Query parameters as an object', additionalProperties: true },
      },
      required: ['endpoint'],
    },
    handler: async (args) => apiRequest(args.endpoint, args.query || {}),
  },
];

const TOOL_MAP = Object.fromEntries(TOOLS.map((t) => [t.name, t]));

/* ------------------------------------------------------------ MCP server */

const PROTOCOL_VERSION = '2025-06-18';
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

/**
 * stdout to a pipe is asynchronous: a large response is not written at once
 * but buffered and flushed later. So we count unfinished writes and exit only
 * after the last one – `process.exit()` does not wait for the buffer and cuts
 * the response in half. It only shows with responses over a few dozen
 * kilobytes (for example inv_list_invoices with per_page: 100), so it is easy
 * to miss.
 */
let outstandingWrites = 0;
let pendingRequests = 0;
let stdinEnded = false;

function exitWhenIdle() {
  if (stdinEnded && pendingRequests === 0 && outstandingWrites === 0) process.exit(0);
}

function send(msg) {
  outstandingWrites += 1;
  process.stdout.write(JSON.stringify(msg) + '\n', () => {
    outstandingWrites -= 1;
    exitWhenIdle();
  });
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handleMessage(msg) {
  const { id, method, params } = msg;

  if (method === 'initialize') {
    const requested = params && params.protocolVersion;
    return reply(id, {
      protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: 'inv-bg-mcp', title: 'inv.bg', version: VERSION },
    });
  }

  if (method === 'ping') return reply(id, {});

  if (method && method.startsWith('notifications/')) return;

  if (method === 'tools/list') {
    return reply(id, {
      tools: TOOLS.map(({ name, description, inputSchema, outputSchema, annotations }) => {
        const tool = { name, description, inputSchema, annotations };
        if (outputSchema) tool.outputSchema = outputSchema;
        return tool;
      }),
    });
  }

  if (method === 'tools/call') {
    const tool = TOOL_MAP[params && params.name];
    if (!tool) {
      return replyError(id, -32602, `Unknown tool: ${params && params.name}. Available: ${TOOLS.map((t) => t.name).join(', ')}`);
    }
    try {
      const args = (params && params.arguments) || {};
      validateArgs(tool, args);
      const result = await tool.handler(args);
      // The text stays for clients that do not read structuredContent. If the
      // tool declares an outputSchema, the response must carry
      // structuredContent too – so both go together.
      const payload = { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      if (tool.outputSchema) payload.structuredContent = result;
      return reply(id, payload);
    } catch (err) {
      return reply(id, {
        content: [{ type: 'text', text: `Error: ${err && err.message ? err.message : String(err)}` }],
        isError: true,
      });
    }
  }

  if (id !== undefined) replyError(id, -32601, `Unknown method: ${method}`);
}

function main() {
  let buffer = '';
  // Requests are asynchronous, and stdin may close while one is still running.
  // We exit only once everything in flight has settled, or responses are lost.
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (_) {
        continue;
      }
      pendingRequests += 1;
      Promise.resolve(handleMessage(msg))
        .catch((err) => {
          if (msg && msg.id !== undefined) replyError(msg.id, -32603, String(err && err.message ? err.message : err));
        })
        .finally(() => {
          pendingRequests -= 1;
          exitWhenIdle();
        });
    }
  });
  process.stdin.on('end', () => {
    stdinEnded = true;
    exitWhenIdle();
  });
}

/* ------------------------------------------------------------- self-test */

async function selfTest() {
  const out = (s) => process.stderr.write(s + '\n');
  out(`Base: ${BASE}`);
  out(`Token: ${TOKEN ? TOKEN.slice(0, 4) + '…' + TOKEN.slice(-4) + ` (${TOKEN.length} characters)` : 'MISSING'}`);
  out(`PDF folder: ${DOWNLOAD_DIR}`);
  if (!TOKEN) {
    out('\nPut the token in INV_BG_TOKEN and try again.');
    process.exit(1);
  }
  try {
    const firm = await apiRequest('/firm', {});
    const f = firm.firm || firm;
    out(`\nOK – company: ${f.name || JSON.stringify(f).slice(0, 120)}`);
  } catch (err) {
    out(`\nProblem with /firm: ${err.message}`);
    process.exit(1);
  }
  try {
    const inv = await apiRequest('/invoices', { per_page: 3 });
    out(`OK – documents in total: ${inv.total}`);
    for (const i of inv.invoices || []) {
      const s = summariseInvoice(i);
      out(`   #${s.number} | ${s.date} | ${s.client} | ${s.total}`);
    }
  } catch (err) {
    out(`Problem with /invoices: ${err.message}`);
    process.exit(1);
  }
  try {
    const unpaid = await apiRequest('/invoices', { status: ['unpaid'], per_page: 1 });
    const all = await apiRequest('/invoices', { per_page: 1 });
    out(`OK – the status filter works: ${unpaid.total} unpaid out of ${all.total}`);
    if (unpaid.total === all.total) {
      out('   WARNING: the two counts are equal – either everything is unpaid, or the filter is being ignored.');
    }
  } catch (err) {
    out(`Problem with the status filter: ${err.message}`);
    process.exit(1);
  }
  out('\nAll good.');
}

if (require.main === module) {
  if (process.argv.includes('--selftest')) {
    selfTest();
  } else {
    main();
  }
}

module.exports = {
  resolveBase,
  buildUrl,
  normaliseQueryValue,
  resolveDestDir,
  pdfFileName,
  pdfTargetPath,
  summariseInvoice,
  computeTurnover,
  validateArgs,
  TOOLS,
  DOWNLOAD_DIR,
};
