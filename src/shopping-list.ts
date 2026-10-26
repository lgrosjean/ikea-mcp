// Shopping list stored in a local JSON file, so it survives across conversations.

import { getProduct, normalizeItemNo, round2, type Product } from './ikea.ts';

export const LIST_FILE = Bun.env.IKEA_LIST_FILE ?? `${Bun.env.HOME}/.ikea-mcp/shopping-list.json`;

type Entry = ReturnType<typeof toEntry> & { quantity: number; note?: string };
type List = { items: Entry[] };

export async function loadList(): Promise<List> {
  const file = Bun.file(LIST_FILE);
  return (await file.exists()) ? file.json() : { items: [] };
}

// Bun.write creates the parent directory if it does not exist.
const save = (list: List) => Bun.write(LIST_FILE, JSON.stringify(list, null, 2));

function toEntry(product: Product) {
  return {
    itemNo: product.itemNo,
    name: product.name,
    type: product.type,
    color: product.color,
    unitPrice: product.price,
    currency: product.currency,
    url: product.url,
    packagesPerUnit: product.packaging?.packageCount,
    unitWeightKg: product.packaging?.totalWeightKg,
    longestPackageCm: product.packaging?.longestPackageCm,
    priceCheckedOn: new Date().toISOString().slice(0, 10),
  };
}

export async function addToList(rawItemNo: string, quantity = 1, note?: string) {
  const itemNo = normalizeItemNo(rawItemNo);
  const list = await loadList();
  let entry = list.items.find((a) => a.itemNo === itemNo);
  if (entry) {
    entry.quantity += quantity;
  } else {
    entry = { ...toEntry(await getProduct(itemNo)), quantity };
    list.items.push(entry);
  }
  if (note) entry.note = note;
  await save(list);
  return viewList(list);
}

export async function removeFromList(rawItemNo: string, quantity?: number) {
  const itemNo = normalizeItemNo(rawItemNo);
  const list = await loadList();
  const entry = list.items.find((a) => a.itemNo === itemNo);
  if (!entry) throw new Error(`Item ${itemNo} is not in the shopping list`);
  entry.quantity -= quantity ?? entry.quantity;
  list.items = list.items.filter((a) => a.quantity > 0);
  await save(list);
  return viewList(list);
}

export async function clearList() {
  const empty: List = { items: [] };
  await save(empty);
  return viewList(empty);
}

export async function viewList(list?: List, { refreshPrices = false } = {}) {
  list ??= await loadList();
  const changes: string[] = [];
  if (refreshPrices && list.items.length) {
    const fresh = await Promise.allSettled(list.items.map((a) => getProduct(a.itemNo)));
    fresh.forEach((r, i) => {
      const a = list.items[i]!;
      if (r.status === 'rejected') {
        changes.push(`${a.name} (${a.itemNo}): could not check (${r.reason.message})`);
        return;
      }
      if (r.value.price !== a.unitPrice) {
        changes.push(`${a.name} (${a.itemNo}): ${a.unitPrice} -> ${r.value.price} ${a.currency}`);
      }
      list.items[i] = { ...toEntry(r.value), quantity: a.quantity, note: a.note };
    });
    await save(list);
  }

  const items = list.items.map((a) => ({
    ...a,
    subtotal: a.unitPrice != null ? round2(a.unitPrice * a.quantity) : undefined,
  }));
  const sum = (f: (a: (typeof items)[number]) => number | undefined) =>
    round2(items.reduce((t, a) => t + (f(a) ?? 0), 0));
  return {
    items,
    totals: {
      itemCount: items.reduce((t, a) => t + a.quantity, 0),
      totalPrice: sum((a) => a.subtotal),
      currency: items[0]?.currency,
      packageCount: sum((a) => (a.packagesPerUnit ?? 0) * a.quantity),
      totalWeightKg: sum((a) => (a.unitWeightKg ?? 0) * a.quantity),
      longestPackageCm: Math.max(0, ...items.map((a) => a.longestPackageCm ?? 0)) || undefined,
    },
    priceChanges: refreshPrices ? (changes.length ? changes : 'none') : undefined,
    file: LIST_FILE,
  };
}
