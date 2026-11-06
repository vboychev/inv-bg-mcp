'use strict';

// Unit tests that need no token and no network: `node --test`.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');

process.env.INV_BG_DOWNLOAD_DIR = path.join(os.tmpdir(), 'inv-bg-mcp-test');
delete process.env.INV_BG_BASE;

const server = require('../server.js');

test('resolveBase accepts https and strips the trailing slash', () => {
  assert.equal(server.resolveBase('https://api.inv.bg/v3/'), 'https://api.inv.bg/v3');
  assert.equal(server.resolveBase(undefined), 'https://api.inv.bg/v3');
});

test('resolveBase rejects http and garbage', () => {
  assert.throws(() => server.resolveBase('http://api.inv.bg/v3'), /https/);
  assert.throws(() => server.resolveBase('not a url'), /valid URL/);
});

test('buildUrl adds brackets only to the known array filters', () => {
  const url = server.buildUrl('/invoices', { status: ['paid', 'unpaid'], type: ['dan'], expand: ['items'] });
  assert.deepEqual(url.searchParams.getAll('status[]'), ['paid', 'unpaid']);
  assert.deepEqual(url.searchParams.getAll('type[]'), ['dan']);
  assert.deepEqual(url.searchParams.getAll('expand'), ['items']);
  assert.equal(url.searchParams.has('status'), false);
});

test('buildUrl does not double the brackets', () => {
  const url = server.buildUrl('/invoices', { 'type[]': ['dan'] });
  assert.deepEqual(url.searchParams.getAll('type[]'), ['dan']);
});

test('buildUrl skips empty values', () => {
  const url = server.buildUrl('/invoices', { a: '', b: null, c: undefined, d: [] });
  assert.equal(url.search, '');
});

test('buildUrl extends a bare date_to to the end of the day', () => {
  const url = server.buildUrl('/invoices', { date_from: '2026-07-01', date_to: '2026-07-31' });
  assert.equal(url.searchParams.get('date_from'), '2026-07-01');
  assert.equal(url.searchParams.get('date_to'), '2026-07-31T23:59:59');
});

test('buildUrl leaves a date_to that already has a time', () => {
  assert.equal(server.normaliseQueryValue('date_to', '2026-07-31T12:00:00'), '2026-07-31T12:00:00');
});

test('buildUrl keeps the request on the API host and path', () => {
  assert.equal(server.buildUrl('invoices', {}).href, 'https://api.inv.bg/v3/invoices');
  assert.throws(() => server.buildUrl('/../v2/invoices', {}), /outside/);
  assert.throws(() => server.buildUrl('/%2e%2e/admin', {}), /outside/);
  // Without a leading slash the endpoint is still appended as a path.
  assert.equal(server.buildUrl('@evil.example/x', {}).origin, 'https://api.inv.bg');
  assert.equal(server.buildUrl('//evil.example/x', {}).origin, 'https://api.inv.bg');
});

test('resolveDestDir allows subfolders and rejects escapes', () => {
  const root = server.DOWNLOAD_DIR;
  assert.equal(server.resolveDestDir(undefined), root);
  assert.equal(server.resolveDestDir('archive/en'), path.join(root, 'archive', 'en'));
  assert.equal(server.resolveDestDir(path.join(root, 'x')), path.join(root, 'x'));
  assert.throws(() => server.resolveDestDir('../outside'), /inside INV_BG_DOWNLOAD_DIR/);
  assert.throws(() => server.resolveDestDir('/etc'), /inside INV_BG_DOWNLOAD_DIR/);
  assert.throws(() => server.resolveDestDir(root + '-sibling'), /inside INV_BG_DOWNLOAD_DIR/);
});

test('pdfTargetPath sorts by year and falls back to "undated"', () => {
  const root = server.DOWNLOAD_DIR;
  const inv = { id: 7, number: 145, date_create: '2019-03-04 00:00:01', to_name: 'ACME: Ltd' };
  assert.equal(server.pdfTargetPath(inv), path.join(root, '2019', '2019-03-04_0000000145_ACME- Ltd.pdf'));
  assert.equal(path.basename(server.pdfTargetPath(inv, undefined, 'en')), '2019-03-04_0000000145_ACME- Ltd_EN.pdf');
  const odd = { id: 8, number: 1, date_create: 'x/y-01-01', to_name: 'A' };
  assert.equal(server.pdfTargetPath(odd), path.join(root, 'undated', 'undated_0000000001_A.pdf'));
});

test('summariseInvoice keeps the type code and adds a label', () => {
  const s = server.summariseInvoice({ id: 1, type: 'cred', payment_currency: 'EUR', date_create: '2026-01-02 00:00:01' });
  assert.equal(s.type, 'cred');
  assert.equal(s.type_label, 'credit note');
  assert.equal(s.currency, 'EUR');
  assert.equal(s.date, '2026-01-02');
});

test('computeTurnover subtracts credit notes and skips drafts and annulled documents', () => {
  const docs = [
    { type: 'dan', to_name: 'A', payment_currency: 'EUR', payment_amount_total: '1000', date_create: '2026-01-05' },
    { type: 'cred', to_name: 'A', payment_currency: 'EUR', payment_amount_total: 300, date_create: '2026-01-20' },
    { type: 'deb', to_name: 'B', payment_currency: 'EUR', payment_amount_total: 50, date_create: '2026-02-01' },
    { type: 'dan', to_name: 'B', payment_currency: 'BGN', payment_amount_total: 200, date_create: '2026-02-01' },
    { type: 'dan', to_name: 'C', payment_currency: 'EUR', payment_amount_total: 999, is_draft: true },
    { type: 'dan', to_name: 'C', payment_currency: 'EUR', payment_amount_total: 999, is_annulled: true },
  ];
  const r = server.computeTurnover(docs, 'client');
  assert.equal(r.counted, 4);
  assert.equal(r.skipped, 2);
  assert.deepEqual(r.totalsByCurrency, { EUR: 750, BGN: 200 });
  assert.deepEqual(r.rows[0], { key: 'A', currency: 'EUR', count: 2, total: 700 });

  const byMonth = server.computeTurnover(docs, 'month');
  assert.deepEqual(byMonth.rows.map((x) => [x.key, x.currency, x.total]), [
    ['2026-01', 'EUR', 700],
    ['2026-02', 'BGN', 200],
    ['2026-02', 'EUR', 50],
  ]);
});

test('validateArgs rejects unknown and mistyped parameters', () => {
  const tool = server.TOOLS.find((t) => t.name === 'inv_list_invoices');
  assert.doesNotThrow(() => server.validateArgs(tool, { status: ['paid'], date_from: '2026-01-01' }));
  assert.throws(() => server.validateArgs(tool, { nope: 1 }), /Unknown parameter/);
  assert.throws(() => server.validateArgs(tool, { status: 'paid' }), /must be a list/);
  assert.throws(() => server.validateArgs(tool, { date_from: '01.01.2026' }), /wrong format/);
});

test('every tool is GET-only by construction', () => {
  // The only HTTP call in the server is apiRequest, and it hard-codes GET.
  const src = require('node:fs').readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const methods = [...src.matchAll(/method:\s*'([A-Z]+)'/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(methods)], ['GET']);
});
