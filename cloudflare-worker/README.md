# Cloudflare Worker deployment

This directory contains the standalone Cloudflare Workers deployment for `odoo-mcp-pro`.

It does not depend on or modify the existing `odoo-sign-mcp` Worker.

## Endpoint

The MCP endpoint is `/mcp`. A public `/health` endpoint is provided for liveness checks.

## Required secrets

Configure these as Cloudflare Worker secrets. Never commit their values:

- `ODOO_PASSWORD`: password for the dedicated Odoo service account `mcp-cloudflare@thriveadvisorysolutions.com`
- `MCP_AUTH_TOKEN`: bearer token required to access `/mcp`

## Deploy

From this directory:

```sh
npx wrangler secret put ODOO_PASSWORD
npx wrangler secret put MCP_AUTH_TOKEN
npx wrangler deploy
```

The Worker uses Odoo XML-RPC so it remains independent of Python runtime constraints on Cloudflare Workers. Odoo ACLs for the dedicated service account govern available data and operations.
