# Security policy

## Supported versions

Until the first stable release, only the latest commit on the default branch receives security fixes.

## Reporting a vulnerability

Do not open a public issue for a vulnerability that could expose credentials, account identifiers, balances, transactions, or authentication bypasses. Use GitHub's private vulnerability reporting for this repository. If it is not enabled, contact the maintainer privately before sharing reproduction details.

Never include real Worker secrets, Access tokens, Enable Banking keys, session IDs, account UUIDs, IBANs, or transaction data in a report. Use generated test fixtures.

## Threat model

The primary assets are:

- the Enable Banking RSA private key and application ID;
- Enable Banking session IDs stored in Workers KV;
- Cloudflare Access OAuth credentials and tokens;
- balances, transactions, counterparties, and derived summaries.

The principal threats are unauthenticated MCP access, confused-deputy calls to arbitrary provider endpoints or accounts, prompt-injected destructive operations, secret disclosure through output or logs, SSRF, unbounded data extraction, replay of credentials, and accidental public deployment.

The intended security boundary is:

1. Worker-level Cloudflare Access authenticates the caller before invocation, and the Worker fails closed unless Cloudflare supplies a validated `ctx.access` context.
2. The MCP layer exposes only bounded semantic read tools.
3. The setup routes can only start, complete, and close Enable Banking account authorization; they are not MCP tools.
4. The provider module discovers account IDs from active stored sessions and rejects other IDs.
5. User-triggered account reads forward the bounded Cloudflare connecting-client IP and MCP client
   User-Agent as Enable Banking's `Psu-Ip-Address` and `Psu-User-Agent` headers. Those values are
   request-scoped and are neither stored nor logged.
6. The Worker stores no financial responses and returns `Cache-Control: no-store`.

## Deployment assumptions

Security claims assume that operators:

- disable preview URLs;
- protect all Worker traffic with Worker-level Cloudflare Access, including `workers.dev` and any custom domains;
- enable Managed OAuth on the generated Access application;
- restrict Access to their own identity;
- keep the Enable Banking private key in a Worker secret and session KV private;
- preserve Cloudflare's trusted `CF-Connecting-IP` handling and do not replace it with a
  caller-controlled forwarding header;
- review dependency and Worker changes before deploying;
- use the project only for accounts they are authorized to access.

Adding payments, generic HTTP tools, unvalidated account IDs, unauthenticated routes, persistent financial-data storage, or multi-user tenancy changes this threat model and requires a new security design.
