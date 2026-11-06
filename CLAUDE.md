# CLAUDE.md

Guidance for AI assistants working on this repository.

## What this is

A read-only MCP server for the [inv.bg](https://inv.bg) invoicing API (v3), runnable locally over stdio.

## Hard rules

- **Read-only towards inv.bg.** The server only ever sends `GET` requests. Do not add `POST`, `PATCH`, `PUT` or `DELETE` calls, and do not add tools that issue, edit, send or annul documents.
- **Zero dependencies.** Plain Node 18+ with the built-in `fetch`. No `npm install`, no `node_modules`.
- **No secrets in the repository.** The API token comes only from the `INV_BG_TOKEN` environment variable. Never hard-code a token, a company name, a client name or a local path.
- **Do not commit the OpenAPI spec.** It belongs to inv.bg; link to it instead.
- British English in code comments and docs. Use an en dash (–), never an em dash.

## Testing

```
node --test
INV_BG_TOKEN=<token> node server.js --selftest
```

The unit tests in `test/` need no token or network. The self-test calls `/firm` and `/invoices` and checks that the `status` filter actually narrows the result.

## API quirks worth knowing

These are documented in comments in `server.js`. Do not "fix" them back:

- `date_to` is compared against `YYYY-MM-DD 00:00:00`, so the server appends `T23:59:59`.
- Some array filters need `[]` in the parameter name (`type[]`, `status[]`, `currency[]`, `payment_processor[]`), even where the spec says otherwise. A wrong name is silently ignored.
- `/reports/*` returns "Not implemented Yet", so turnover is computed locally.
- `next_page` comes back as a URI; the server translates it to a page number.
- Credit notes (`cred`) come back with a positive amount, so `inv_turnover` subtracts them. Proformas are not turnover and are left out by default.

## Safety guards

Keep these, and cover any change to them in `test/`:

- `INV_BG_BASE` must be `https`; `buildUrl` keeps every request on the base origin and path; `fetch` uses `redirect: 'error'`.
- PDFs are written only inside `INV_BG_DOWNLOAD_DIR` (`resolveDestDir`).
