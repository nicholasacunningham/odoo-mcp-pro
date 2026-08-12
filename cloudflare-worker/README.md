# Cloudflare Worker deployment

This directory contains the standalone Cloudflare Workers deployment for `odoo-mcp-pro`.

It does not depend on or modify the existing `odoo-sign-mcp` Worker.

## Endpoint

The MCP endpoint is `/mcp`. A public `/health` endpoint is provided for liveness and Odoo connectivity checks.

## Odoo identity

The Worker uses the dedicated Odoo service account `mcp-cloudflare@thriveadvisorysolutions.com`. Odoo ACLs on that account govern all data and operations exposed through MCP.

## Required secrets

Configure these as Cloudflare Worker secrets. Never commit their values:

- `ODOO_PASSWORD`: password for the dedicated Odoo service account
- `MCP_AUTH_TOKEN`: bearer token required to access `/mcp`

## Deploy

From this directory:

```sh
npx wrangler secret put ODOO_PASSWORD
npx wrangler secret put MCP_AUTH_TOKEN
npx wrangler deploy
```

The Worker authenticates through Odoo's web session API and calls Odoo ORM methods through the web dataset JSON-RPC endpoint. This avoids Python runtime constraints on Cloudflare Workers while keeping the Cloudflare deployment completely separate from any existing MCP Worker.
