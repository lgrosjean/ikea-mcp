// End-to-end tests: start the server the way Claude does (stdio) or over HTTP
// (Bun.serve), then call every tool against the real IKEA website.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const ENTRY = `${import.meta.dir}/../src/server.ts`;
const NET = { timeout: 30_000 };

// Each server gets its own directory: a fresh shopping list and guest cart.
type Started = { transport: Transport; dataDir: string; stop?: () => void };

async function childEnv() {
  const dataDir = await mkdtemp(`${tmpdir()}/ikea-mcp-`);
  const env = { ...Bun.env, IKEA_LIST_FILE: `${dataDir}/shopping-list.json`, IKEA_CART_FILE: `${dataDir}/cart.json` };
  return { dataDir, env: env as Record<string, string> };
}

async function startStdio(): Promise<Started> {
  const { dataDir, env } = await childEnv();
  return { dataDir, transport: new StdioClientTransport({ command: process.execPath, args: [ENTRY], env }) };
}

// Starts the HTTP mode on a free port and reads the announced URL from stderr.
async function startHttp(): Promise<Started> {
  const { dataDir, env } = await childEnv();
  const proc = Bun.spawn([process.execPath, ENTRY, '--http', '--port', '0'], { env, stdout: 'ignore', stderr: 'pipe' });
  let logs = '';
  const decoder = new TextDecoder();
  for await (const chunk of proc.stderr) {
    logs += decoder.decode(chunk);
    const url = logs.match(/http:\/\/\S+\/mcp/)?.[0];
    if (url) return { dataDir, transport: new StreamableHTTPClientTransport(new URL(url)), stop: () => proc.kill() };
  }
  throw new Error(`The HTTP server did not start:\n${logs}`);
}

describe.each([
  ['stdio', startStdio],
  ['http', startHttp],
] as const)('%s transport', (_name, start) => {
  const client = new Client({ name: 'test', version: '0' });
  let stop: (() => void) | undefined;
  let dataDir = '';

  beforeAll(async () => {
    const started = await start();
    stop = started.stop;
    dataDir = started.dataDir;
    await client.connect(started.transport);
  });
  afterAll(async () => {
    await client.close();
    stop?.();
  });

  async function call(name: string, args: Record<string, unknown> = {}): Promise<any> {
    const res: any = await client.callTool({ name, arguments: args });
    const text = res.content[0].text;
    if (res.isError) throw new Error(`${name} failed: ${text}`);
    return JSON.parse(text);
  }

  test('exposes the 13 tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'cart_add',
      'cart_add_shopping_list',
      'cart_clear',
      'cart_remove',
      'cart_set_quantity',
      'cart_view',
      'get_product',
      'list_stores',
      'search_products',
      'shopping_list_add',
      'shopping_list_clear',
      'shopping_list_remove',
      'shopping_list_view',
    ]);
  });

  test(
    'search_products honors the max price',
    async () => {
      const res = await call('search_products', { query: 'bibliothèque', limit: 3, max_price: 80 });
      expect(res.products.length).toBeGreaterThan(0);
      for (const p of res.products) expect(p.price).toBeLessThanOrEqual(80);
    },
    NET,
  );

  test(
    'get_product reads the packaging of a single item',
    async () => {
      const billy = await call('get_product', { item_no: '205.220.46' });
      expect(billy.name).toBe('BILLY');
      expect(billy.packaging.packageCount).toBe(1);
      expect(billy.packaging.totalWeightKg).toBeGreaterThan(0);
      expect(billy.packaging.longestPackageCm).toBeGreaterThan(200);
    },
    NET,
  );

  test(
    'get_product handles combinations ("s" prefix)',
    async () => {
      const besta = await call('get_product', { item_no: '09598085' });
      expect(besta.name).toBe('BESTÅ');
      expect(besta.components.length).toBeGreaterThan(1);
    },
    NET,
  );

  test(
    'get_product reports an unknown item',
    async () => {
      const res: any = await client.callTool({ name: 'get_product', arguments: { item_no: '99999999' } });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain('not found');
    },
    NET,
  );

  test(
    'list_stores filters by city, ignoring accents',
    async () => {
      const stores = await call('list_stores', { city: 'saint-etienne' });
      expect(stores.length).toBe(1);
      expect(stores[0].hours).toContain('10:00');
    },
    NET,
  );

  test(
    'shopping list: add, accumulate quantities, totals',
    async () => {
      await call('shopping_list_add', { item_no: '20522046', quantity: 1, note: 'living room' });
      await call('shopping_list_add', { item_no: '20522046' });
      const list = await call('shopping_list_add', { item_no: '09598085' });
      expect(list.items.length).toBe(2);
      expect(list.totals.itemCount).toBe(3);
      const billy = list.items.find((a: any) => a.itemNo === '20522046');
      expect(billy.quantity).toBe(2);
      expect(billy.note).toBe('living room');
      expect(list.totals.totalPrice).toBeCloseTo(
        list.items.reduce((t: number, a: any) => t + a.subtotal, 0),
        2,
      );
    },
    NET,
  );

  test(
    'shopping list: partial removal, then price check',
    async () => {
      await call('shopping_list_remove', { item_no: '205.220.46', quantity: 1 });
      const list = await call('shopping_list_view', { refresh_prices: true });
      expect(list.totals.itemCount).toBe(2);
      expect(list.priceChanges).toBeDefined();
    },
    NET,
  );

  test('shopping list: clear', async () => {
    const list = await call('shopping_list_clear');
    expect(list.items).toEqual([]);
    expect(list.totals.totalPrice).toBe(0);
  });

  const qty = (cart: any, itemNo: string) => cart.items.find((a: any) => a.itemNo === itemNo)?.quantity;

  test(
    'cart: a new guest token gives an empty cart',
    async () => {
      const cart = await call('cart_view');
      expect(cart.items).toEqual([]);
      expect(cart.totals.totalPrice).toBe(0);
      // The token is kept to find the same cart again, readable by the user only.
      const { mode } = await Bun.file(`${dataDir}/cart.json`).stat();
      expect(mode & 0o777).toBe(0o600);
    },
    NET,
  );

  test(
    'cart: additions accumulate, prices computed by IKEA',
    async () => {
      await call('cart_add', { items: [{ item_no: '205.220.46', quantity: 2 }] });
      const cart = await call('cart_add', { items: [{ item_no: '20522046' }, { item_no: '09598085' }] });
      expect(qty(cart, '20522046')).toBe(3);
      expect(qty(cart, '09598085')).toBe(1);
      expect(cart.totals.itemCount).toBe(4);
      expect(cart.totals.totalPrice).toBeCloseTo(
        cart.items.reduce((t: number, a: any) => t + a.subtotal, 0),
        2,
      );
      expect(cart.totals.totalWeightKg).toBeGreaterThan(100);
    },
    NET,
  );

  test(
    'cart: change a quantity, then remove an item',
    async () => {
      let cart = await call('cart_set_quantity', { item_no: '20522046', quantity: 1 });
      expect(qty(cart, '20522046')).toBe(1);
      cart = await call('cart_remove', { item_nos: ['095.980.85'] });
      expect(cart.items.map((a: any) => a.itemNo)).toEqual(['20522046']);
    },
    NET,
  );

  test(
    'cart: IKEA rejects an invalid item',
    async () => {
      const res: any = await client.callTool({ name: 'cart_add', arguments: { items: [{ item_no: '99999999' }] } });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain('99999999');
    },
    NET,
  );

  test(
    'cart: copy the shopping list',
    async () => {
      await call('shopping_list_add', { item_no: '20522046', quantity: 2 });
      const cart = await call('cart_add_shopping_list');
      expect(qty(cart, '20522046')).toBe(3);
      await call('shopping_list_clear');
    },
    NET,
  );

  test(
    'cart: clear',
    async () => {
      const cart = await call('cart_clear');
      expect(cart.items).toEqual([]);
      expect((await call('cart_view')).items).toEqual([]);
    },
    NET,
  );
});

test('HTTP: rejects a foreign Host header (DNS rebinding)', async () => {
  const { transport, stop } = await startHttp();
  const url = (transport as StreamableHTTPClientTransport)['_url'] as URL;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Host: 'evil.example', 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(403);
  } finally {
    stop?.();
  }
});
