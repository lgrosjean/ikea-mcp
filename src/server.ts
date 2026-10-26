#!/usr/bin/env bun
// IKEA MCP server: search, product details, stores, shopping list and guest cart.
//
//   bun src/server.ts                       -> stdio (Claude starts the process)
//   bun src/server.ts --http [--port 3000]  -> HTTP with Bun.serve on /mcp

import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CART_URL, TOKEN_URL } from './cart.ts';
import { preconnect } from './ikea.ts';
import { createServer } from './tools.ts';

const { values: opts } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    http: { type: 'boolean', default: false },
    port: { type: 'string', default: Bun.env.PORT ?? '3000' },
    host: { type: 'string', default: '127.0.0.1' },
  },
});

preconnect(TOKEN_URL, CART_URL);

if (!opts.http) {
  await createServer().connect(new StdioServerTransport());
} else {
  const http = Bun.serve({
    hostname: opts.host,
    port: Number(opts.port),
    routes: {
      // Stateless mode: a fresh MCP server per request, plain JSON responses.
      '/mcp': async (req, server) => {
        const transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
          // Rejects requests from a web page trying to reach the local server.
          enableDnsRebindingProtection: true,
          allowedHosts: [`${opts.host}:${server.port}`, `localhost:${server.port}`],
        });
        await createServer().connect(transport);
        return transport.handleRequest(req);
      },
    },
    fetch: () => new Response('Not found', { status: 404 }),
  });
  // stderr: keeps stdout clean even if this mode is started from a stdio client.
  console.error(`IKEA MCP server listening on ${http.url}mcp`);
}
