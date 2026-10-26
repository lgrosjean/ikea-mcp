// ikea.com guest cart: the same API the website uses for a visitor who is not signed in.
// The cart is stored by IKEA, tied to an anonymous guest token kept locally. It is
// separate from the cart of your ikea.com account and cannot be used to pay.

import { chmod } from 'node:fs/promises';
import { COUNTRY, LANG, normalizeItemNo, round2 } from './ikea.ts';

export const CART_FILE = Bun.env.IKEA_CART_FILE ?? `${Bun.env.HOME}/.ikea-mcp/cart.json`;
export const TOKEN_URL = 'https://api.ingka.ikea.com/guest/token';
export const CART_URL = `https://prod.cart.caas.selling.ingka.com/api/v1/${COUNTRY}`;
// Public client ID that ikea.com's token-service script sends for every visitor;
// it is not a secret.
const GUEST_CLIENT_ID = Bun.env.IKEA_GUEST_CLIENT_ID ?? 'b477b9e4-b836-40fb-842f-43db89dd3c52';

type Raw = any;
type Session = { token: string; expiresAt: number; country: string };

// IKEA returns expires_in as "720h" (or sometimes a number of seconds).
function parseExpiresIn(value: unknown): number {
  const [, n, unit = 's'] = String(value).match(/^(\d+)([hms]?)$/) ?? [];
  return n ? Number(n) * { h: 3_600_000, m: 60_000, s: 1000 }[unit as 'h' | 'm' | 's'] : 86_400_000;
}

async function newSession(): Promise<Session> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json;version=2', 'X-Client-Id': GUEST_CLIENT_ID },
    body: JSON.stringify({ retailUnit: COUNTRY }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`IKEA refused the guest token (${res.status})`);
  const body: Raw = await res.json();
  const session = { token: body.access_token, expiresAt: Date.now() + parseExpiresIn(body.expires_in), country: COUNTRY };
  await Bun.write(CART_FILE, JSON.stringify(session, null, 2));
  await chmod(CART_FILE, 0o600);
  return session;
}

const isFresh = (s: Session) => s.country === COUNTRY && s.expiresAt - Date.now() > 60_000;

async function loadSession(): Promise<Session> {
  const file = Bun.file(CART_FILE);
  const saved: Session | null = (await file.exists()) ? await file.json() : null;
  return saved && isFresh(saved) ? saved : newSession();
}

// A single session per process, even when several tools run in parallel.
let session: Promise<Session> | undefined;

async function token(): Promise<string> {
  session = (session ?? loadSession()).then((s) => (isFresh(s) ? s : newSession()));
  session.catch(() => (session = undefined));
  return (await session).token;
}

const POPULATE = { fetchCartContext: false, fetchItemInfo: true, fetchIndicativeAvailability: false, fetchPrice: true };
const POPULATE_QUERY = { ...Object.fromEntries(Object.entries(POPULATE).map(([k, v]) => [k, String(v)])), shoppingProfile: 'ONLINE', group: 'DEFAULT' };

function describeError(status: number, data: Raw) {
  const details = [
    ...(data?.items ?? []).map((i: Raw) => `${i.itemNo}: ${i.description}`),
    ...(data?.errors ?? []).map((e: Raw) => e.code).filter(Boolean),
  ];
  return `IKEA cart: ${data?.title ?? 'error'} (${status})${details.length ? ` - ${details.join(', ')}` : ''}`;
}

// Reads and deletes pass options in the query string, writes in the body.
async function cartRequest(method: string, path = '', { query, items }: { query?: Record<string, string>; items?: object[] } = {}, retried = false): Promise<Raw> {
  const params = items ? '' : `?${new URLSearchParams({ ...query, ...POPULATE_QUERY })}`;
  const res = await fetch(`${CART_URL}${path}${params}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await token()}`, 'X-Consumer-Name': 'Web Cart', 'Accept-Language': LANG },
    body: items && JSON.stringify({ shoppingProfile: 'ONLINE', group: 'DEFAULT', populateCart: POPULATE, items }),
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 401 && !retried) {
    session = newSession();
    return cartRequest(method, path, { query, items }, true);
  }
  const data: Raw = await res.json().catch(() => ({}));
  if (res.ok) return data.cart ?? data;
  if (data?.errors?.[0]?.code === 'CART_NOT_FOUND') return { empty: true };
  throw new Error(describeError(res.status, data));
}

const packageWeight = (i: Raw) =>
  (i.info?.packageProperties ?? [])
    .filter((p: Raw) => p.type === 'WEIGHT')
    .reduce((t: number, p: Raw) => t + Number(p.metric?.value ?? 0), 0) * (i.quantity ?? 0);

// For a combination (SPR), the weight is carried by its components, as on the website.
const itemWeight = (i: Raw) =>
  i.itemType === 'SPR' ? (i.childItems ?? []).reduce((t: number, c: Raw) => t + packageWeight(c), 0) : packageWeight(i);

function summarizeCart(cart: Raw) {
  const items: Raw[] = (cart.groups ?? []).flatMap((g: Raw) => g.items ?? []);
  return {
    cart: 'ikea.com guest cart, separate from your account: only visible through this MCP, checkout not possible here',
    items: items.map((i) => ({
      itemNo: i.itemNo as string,
      name: (i.info?.globalName ?? i.info?.name) as string,
      description: i.info?.description as string | undefined,
      quantity: i.quantity as number,
      maxQuantity: i.maxQuantity ?? undefined,
      unitPrice: i.price?.unitPrice?.current?.inclTax as number | undefined,
      subtotal: i.price?.subtotal?.current?.inclTax as number | undefined,
      packages: i.info?.numberOfPackages ? i.info.numberOfPackages * i.quantity : undefined,
      weightKg: round2(itemWeight(i)) || undefined,
    })),
    totals: {
      itemCount: (cart.quantity ?? 0) as number,
      totalPrice: (cart.price?.totalPrice?.current?.inclTax ?? 0) as number,
      includingEcoFee: (cart.price?.fees?.weee ?? undefined) as number | undefined,
      currency: cart.price?.currency as string | undefined,
      totalWeightKg: round2(items.reduce((t, i) => t + itemWeight(i), 0)),
    },
    updatedAt: cart.updatedAt as string | undefined,
  };
}

export const viewCart = async () => summarizeCart(await cartRequest('GET'));

// Adds to the quantities already in the cart (same as the "Add to cart" button).
export async function addToCart(items: { itemNo: string; quantity: number }[]) {
  const payload = items.map((i) => ({ itemNo: normalizeItemNo(i.itemNo), quantity: i.quantity }));
  return summarizeCart(await cartRequest('POST', '/items', { items: payload }));
}

export async function setCartQuantity(itemNo: string, quantity: number) {
  return summarizeCart(await cartRequest('PUT', '/items', { items: [{ itemNo: normalizeItemNo(itemNo), quantity }] }));
}

export async function removeFromCart(itemNos: string[]) {
  const itemNumbers = itemNos.map(normalizeItemNo).join(',');
  return summarizeCart(await cartRequest('DELETE', '/items', { query: { itemNumbers } }));
}

export async function clearCart() {
  const { items } = await viewCart();
  return items.length ? removeFromCart(items.map((a) => a.itemNo)) : viewCart();
}
