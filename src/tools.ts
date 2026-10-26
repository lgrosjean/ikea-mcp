// MCP tool declarations, shared by the stdio and HTTP modes.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { addToCart, clearCart, removeFromCart, setCartQuantity, viewCart } from './cart.ts';
import { COUNTRY, LANG, getProduct, listStores, searchProducts } from './ikea.ts';
import { addToList, clearList, loadList, removeFromList, viewList } from './shopping-list.ts';

// Every tool returns JSON; errors come back as an isError result so the model
// can react (item not found, IKEA unavailable...).
const handle =
  <A>(fn: (args: A) => Promise<unknown>) =>
  async (args: A) => {
    try {
      return { content: [{ type: 'text' as const, text: JSON.stringify(await fn(args), null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }], isError: true };
    }
  };

const itemNo = z.string().describe('IKEA item number, with or without dots (e.g. 205.220.46 or 20522046)');
const readOnly = { readOnlyHint: true, openWorldHint: true };

const CART_NOTE =
  'This is an ikea.com guest cart, separate from the cart of your IKEA account: it does not show up when you sign in on ikea.com, and checkout cannot happen here.';

export function createServer() {
  const server = new McpServer({ name: 'ikea', version: '0.1.0' });

  server.registerTool(
    'search_products',
    {
      title: 'Search IKEA products',
      description: `Searches the IKEA catalog (${COUNTRY}/${LANG}). Returns name, type, color, dimensions, price, rating, link and color variants.`,
      inputSchema: {
        query: z.string().describe('What you are looking for, as on ikea.com: "white bookcase", "KALLAX", "bedside lamp"...'),
        limit: z.number().int().min(1).max(48).default(10).describe('Number of results'),
        max_price: z.number().positive().optional().describe("Maximum price, in the country's currency"),
      },
      annotations: readOnly,
    },
    handle(({ query, limit, max_price }) => searchProducts(query, { limit, maxPrice: max_price })),
  );

  server.registerTool(
    'get_product',
    {
      title: 'IKEA product details',
      description:
        'Details of an item: description, price, eco fee, dimensions, number of packages, weight and size of the longest package (handy to know whether it fits in the car), tips, and components of combinations.',
      inputSchema: { item_no: itemNo },
      annotations: readOnly,
    },
    handle(({ item_no }) => getProduct(item_no)),
  );

  server.registerTool(
    'list_stores',
    {
      title: 'IKEA stores',
      description: "Lists the country's IKEA stores with address, opening hours and upcoming closing days.",
      inputSchema: { city: z.string().optional().describe('City, store name or postal code to filter on (e.g. "Lyon", "Paris", "13")') },
      annotations: readOnly,
    },
    handle(({ city }) => listStores(city)),
  );

  server.registerTool(
    'shopping_list_view',
    {
      title: 'View the shopping list',
      description: 'Shows the IKEA shopping list with subtotals, total price, number of packages, total weight and longest package.',
      inputSchema: { refresh_prices: z.boolean().default(false).describe('Re-check current prices on ikea.com') },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    handle(({ refresh_prices }) => viewList(undefined, { refreshPrices: refresh_prices })),
  );

  server.registerTool(
    'shopping_list_add',
    {
      title: 'Add to the shopping list',
      description: 'Adds an item to the shopping list (or increases its quantity if it is already there).',
      inputSchema: {
        item_no: itemNo,
        quantity: z.number().int().min(1).default(1),
        note: z.string().optional().describe('Free-form note, e.g. "for the bedroom"'),
      },
      annotations: { openWorldHint: true },
    },
    handle(({ item_no, quantity, note }) => addToList(item_no, quantity, note)),
  );

  server.registerTool(
    'shopping_list_remove',
    {
      title: 'Remove from the shopping list',
      description: 'Removes an item from the list. Without a quantity, the item is removed entirely.',
      inputSchema: { item_no: itemNo, quantity: z.number().int().min(1).optional() },
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    handle(({ item_no, quantity }) => removeFromList(item_no, quantity)),
  );

  server.registerTool(
    'shopping_list_clear',
    {
      title: 'Clear the shopping list',
      description: 'Removes every item from the shopping list.',
      inputSchema: {},
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    handle(() => clearList()),
  );

  server.registerTool(
    'cart_view',
    {
      title: 'View the IKEA cart',
      description: `Shows the IKEA cart with prices computed by IKEA (incl. VAT and eco fee), number of packages and weight. ${CART_NOTE}`,
      inputSchema: {},
      annotations: readOnly,
    },
    handle(() => viewCart()),
  );

  server.registerTool(
    'cart_add',
    {
      title: 'Add to the IKEA cart',
      description: `Adds one or more items to the cart; the quantity is added to what is already there. IKEA rejects invalid items or items not sold online. ${CART_NOTE}`,
      inputSchema: {
        items: z.array(z.object({ item_no: itemNo, quantity: z.number().int().min(1).default(1) })).min(1),
      },
      annotations: { openWorldHint: true },
    },
    handle(({ items }) => addToCart(items.map((i) => ({ itemNo: i.item_no, quantity: i.quantity })))),
  );

  server.registerTool(
    'cart_add_shopping_list',
    {
      title: 'Put the shopping list in the cart',
      description: `Adds every item of the shopping list to the IKEA cart, with their quantities. ${CART_NOTE}`,
      inputSchema: {},
      annotations: { openWorldHint: true },
    },
    handle(async () => {
      const { items } = await loadList();
      if (!items.length) throw new Error('The shopping list is empty');
      return addToCart(items.map((a) => ({ itemNo: a.itemNo, quantity: a.quantity })));
    }),
  );

  server.registerTool(
    'cart_set_quantity',
    {
      title: 'Change a quantity in the cart',
      description: `Sets the quantity of an item already in the cart. ${CART_NOTE}`,
      inputSchema: { item_no: itemNo, quantity: z.number().int().min(1) },
      annotations: { idempotentHint: true, openWorldHint: true },
    },
    handle(({ item_no, quantity }) => setCartQuantity(item_no, quantity)),
  );

  server.registerTool(
    'cart_remove',
    {
      title: 'Remove from the IKEA cart',
      description: `Removes one or more items from the cart entirely. ${CART_NOTE}`,
      inputSchema: { item_nos: z.array(itemNo).min(1) },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    handle(({ item_nos }) => removeFromCart(item_nos)),
  );

  server.registerTool(
    'cart_clear',
    {
      title: 'Clear the IKEA cart',
      description: `Removes every item from the cart. ${CART_NOTE}`,
      inputSchema: {},
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    handle(() => clearCart()),
  );

  return server;
}
