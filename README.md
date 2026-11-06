# inv-bg-mcp

A read-only [MCP](https://modelcontextprotocol.io) server for the [inv.bg](https://inv.bg) invoicing API (v3). It runs locally over stdio, so Claude Desktop, Claude Code or any other MCP client can read your invoices, clients and payments, compute turnover and archive PDFs.

- **Read-only.** The server only ever sends `GET` requests. That is enforced in the code, not just in the tool descriptions: there is a single HTTP call and its method is fixed.
- **Local.** No hosting. Your token never leaves your machine except on its way to `api.inv.bg`.
- **Zero dependencies.** One file, plain Node 18+ with the built-in `fetch`. No `npm install`, no supply chain.

## Tools

| Tool | What it does |
| --- | --- |
| `inv_get_firm` | Company details. Also a quick check that the token works. |
| `inv_list_invoices` | Invoices, proformas, credit and debit notes, filtered by type, payment status, client and period. |
| `inv_get_invoice` | Full data of one document, including line items. |
| `inv_list_clients` | Clients. |
| `inv_list_payments` | Payments (income and expenses). |
| `inv_turnover` | Turnover for a period by client, by month or overall. Credit notes are subtracted, proformas are left out unless you ask for them. |
| `inv_download_invoice_pdf` | Saves one document as a PDF, in Bulgarian or English. |
| `inv_sync_invoices` | Archives all PDFs for a period, downloading only the missing ones. It tells you plainly if it stopped at the limit. |
| `inv_api_get` | Fallback: a raw `GET` to any inv.bg API v3 endpoint. |

All tools except `inv_api_get` declare an `outputSchema` and return `structuredContent`, as described in the MCP 2025-06-18 specification.

## Setup

1. In inv.bg, generate a long-lived API token: **Settings → Company → API access**. Your plan must include API access.
2. Check that it works:

   ```bash
   INV_BG_TOKEN=<your token> npx -y github:vboychev/inv-bg-mcp --selftest
   ```

   Or from a clone: `INV_BG_TOKEN=<your token> node server.js --selftest`.

### Claude Desktop

Add this to `claude_desktop_config.json` and restart the app:

```json
{
  "mcpServers": {
    "inv": {
      "command": "npx",
      "args": ["-y", "github:vboychev/inv-bg-mcp"],
      "env": {
        "INV_BG_TOKEN": "<your token>"
      }
    }
  }
}
```

From a clone, use `"command": "node"` and `"args": ["/path/to/inv-bg-mcp/server.js"]` instead.

### Claude Code

```bash
claude mcp add inv --env INV_BG_TOKEN=<your token> -- npx -y github:vboychev/inv-bg-mcp
```

### Environment variables

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `INV_BG_TOKEN` | yes | – | The inv.bg API token. |
| `INV_BG_DOWNLOAD_DIR` | no | `~/inv-bg-invoices` | Where PDFs are saved, in a folder per year. `dest_dir` in the PDF tools can only point to a subfolder of it. |
| `INV_BG_BASE` | no | `https://api.inv.bg/v3` | API base URL. Must be `https`. |

## inv.bg API quirks handled for you

These were found against the live API and are documented in `server.js`:

- **`date_to` cuts off the last day.** inv.bg compares it against `YYYY-MM-DD 00:00:00`, while documents are created at `00:00:01`. The server extends a bare date to `T23:59:59`.
- **Some array filters need `[]` in the name** (`type[]`, `status[]`, `currency[]`, `payment_processor[]`), even where the spec says otherwise. A wrong name is ignored silently, so `status=paid&status=unpaid` quietly returns only the unpaid ones.
- **`/reports/*` returns "Not implemented Yet"**, so `inv_turnover` computes turnover locally from the document list.
- **`next_page` is a URI**, which a model cannot pass back. The server returns a page number and `has_more` instead.
- **The payments register is often empty.** `balance_paid` and `balance_due` then stay at 0 even on paid documents. The document `status` is the reliable field, and the tool descriptions say so.

## Security and privacy

- The token comes only from the environment and is never logged. The self-test prints only its first and last four characters.
- Requests can only go to the configured API host and path: `inv_api_get` cannot be used to send the token elsewhere, and redirects are refused.
- PDFs can only be written inside `INV_BG_DOWNLOAD_DIR`.
- **Your inv.bg data goes to the model.** Client names, notes and line items end up in the conversation with whichever model your MCP client uses. Being read-only limits what a prompt injection hidden in that data could do, but does not rule it out: the PDF tools still write files, and the model still reads the text. Use it with an account and a model provider you are comfortable sharing that data with.

## How this differs from other inv.bg MCP servers

There are other good options, and they make different trade-offs:

- [unbelievable-digital/Inv.bg-MCP](https://github.com/unbelievable-digital/Inv.bg-MCP) – TypeScript on Cloudflare Workers, which you host yourself. Around 30 tools, including analytics and tools that create and send documents.
- [usefulapi inv.bg MCP](https://glama.ai/mcp/connectors/io.usefulapi/inv-bg) – a hosted service, so requests pass through its server. Includes issuing invoices.

This one is for people who want a local, read-only server with no dependencies that they can read end to end in one file.

## Development

```bash
npm test                                # unit tests, no token or network needed
INV_BG_TOKEN=<token> npm run selftest   # live check against inv.bg
```

The inv.bg OpenAPI specification is published by inv.bg and is not part of this repository.

## Credits

Written by [Vasil Boychev](https://github.com/vboychev), with [Mihail Shahov](https://github.com/shaxaaa) and [Nikolay Tsekov](https://github.com/ntsekov).

## License

[MIT](LICENSE)

---

## На български

Локален MCP сървър за API-то на [inv.bg](https://inv.bg), който **само чете**. Claude и другите MCP клиенти могат да виждат фактурите, клиентите и плащанията ви, да смятат оборот и да архивират PDF-ите. Сървърът не издава, не редактира, не изпраща и не анулира документи.

Как се пуска: генерирайте API токен в inv.bg (**Настройки → За фирмата → API достъп**) и го подайте в `INV_BG_TOKEN`. Примерите за Claude Desktop и Claude Code са по-горе. PDF-ите отиват в `~/inv-bg-invoices`, освен ако не зададете `INV_BG_DOWNLOAD_DIR`.

Имайте предвид, че данните от inv.bg (имена на клиенти, бележки, артикули) стигат до модела, с който работи вашият MCP клиент.
