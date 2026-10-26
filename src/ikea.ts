// Access to ikea.com public data. There is no official API: these are the URLs the
// website itself uses, and they can change without notice.

export const COUNTRY = Bun.env.IKEA_COUNTRY ?? 'fr';
export const LANG = Bun.env.IKEA_LANG ?? 'fr';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const SEARCH_URL = `https://sik.search.blue.cdtapps.com/${COUNTRY}/${LANG}/search-result-page`;
const SITE = `https://www.ikea.com/${COUNTRY}/${LANG}`;

// IKEA responses are undocumented, so they are read without strict typing.
type Raw = any;

// Resolves IKEA hostnames at startup to speed up the first call.
// (fetch.preconnect throws "Invalid port" for every URL in Bun 1.4.4, hence Bun.dns.)
export function preconnect(...extraUrls: string[]) {
  for (const url of [SEARCH_URL, SITE, ...extraUrls]) Bun.dns.prefetch(new URL(url).hostname, 443);
}

async function get(url: string, accept = 'application/json'): Promise<Response | null> {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: accept },
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`IKEA responded ${res.status} for ${url}`);
  return res;
}

const getJson = async (url: string): Promise<Raw> => (await get(url))?.json() ?? null;

// "205.220.46", "S29404584" or "20522046" -> "20522046"
export function normalizeItemNo(raw: string): string {
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length < 1 || digits.length > 8) throw new Error(`Invalid item number: ${raw}`);
  return digits.padStart(8, '0');
}

export const round2 = (n: number) => Math.round(n * 100) / 100;

function summarizeSearchItem(p: Raw) {
  return {
    itemNo: p.itemNo as string,
    name: p.name as string,
    type: p.typeName as string,
    color: p.validDesignText || undefined,
    dimensions: p.itemMeasureReferenceText || undefined,
    price: p.salesPrice?.numeral as number | undefined,
    currency: p.salesPrice?.currencyCode as string | undefined,
    discount: p.salesPrice?.discount || undefined,
    rating: p.ratingValue ? `${p.ratingValue}/5 (${p.ratingCount} reviews)` : undefined,
    onlineSellable: p.onlineSellable as boolean,
    lastChance: p.lastChance || undefined,
    url: p.pipUrl as string,
    otherVariants: p.gprDescription?.variants?.length
      ? p.gprDescription.variants.map((v: Raw) => ({
          itemNo: v.itemNo,
          color: v.validDesignText || undefined,
          dimensions: v.itemMeasureReferenceText || undefined,
          price: v.salesPrice?.numeral,
        }))
      : undefined,
  };
}

export async function searchProducts(query: string, { limit = 10, maxPrice }: { limit?: number; maxPrice?: number } = {}) {
  const size = maxPrice ? 48 : Math.min(limit, 48);
  const params = new URLSearchParams({ q: query, size: String(size), types: 'PRODUCT' });
  const page = (await getJson(`${SEARCH_URL}?${params}`))?.searchResultPage;
  let items: Raw[] = (page?.products?.main?.items ?? []).map((i: Raw) => i.product).filter(Boolean);
  if (maxPrice) items = items.filter((p) => (p.salesPrice?.numeral ?? Infinity) <= maxPrice);
  return {
    query,
    totalResults: page?.products?.main?.max as number | undefined,
    products: items.slice(0, limit).map(summarizeSearchItem),
    didYouMean: page?.didYouMean?.length ? page.didYouMean : undefined,
    relatedSearches: page?.relatedSearches?.slice(0, 5).map((r: Raw) => r.text) as string[] | undefined,
  };
}

function summarizePackaging(packaging: Raw) {
  if (!packaging) return undefined;
  let weight = 0;
  let longest = 0;
  const packages = [];
  for (const pkg of packaging.packages ?? []) {
    const qty: number = pkg.quantity?.value ?? 1;
    for (const group of pkg.measurementGroups ?? []) {
      const m: Record<string, number> = Object.fromEntries(group.measurements.map((x: Raw) => [x.type, x.value]));
      if (m.weight) weight += m.weight * qty;
      longest = Math.max(longest, m.length ?? 0, m.width ?? 0, m.height ?? 0, m.diameter ?? 0);
      packages.push({
        item: `${pkg.name} ${pkg.typeName}`.trim(),
        quantity: qty,
        dimensionsCm: [m.length, m.width, m.height].filter(Boolean).join(' x ') || undefined,
        weightKg: m.weight,
      });
    }
  }
  return {
    packageCount: packaging.numberOfPackages as number,
    totalWeightKg: round2(weight),
    longestPackageCm: longest || undefined,
    packages,
  };
}

// The product page embeds its data in <script type="text/hydrate"> tags;
// they are extracted as a stream with Bun's HTMLRewriter.
async function findProductProps(page: Response, itemNo: string): Promise<Raw> {
  const blobs: string[] = [];
  let current = '';
  await new HTMLRewriter()
    .on('script[type="text/hydrate"]', {
      text(chunk) {
        current += chunk.text;
        if (chunk.lastInTextNode) {
          blobs.push(current);
          current = '';
        }
      },
    })
    .transform(page)
    .arrayBuffer();

  for (const body of blobs) {
    let blob: Raw;
    try {
      blob = JSON.parse(body);
    } catch {
      continue;
    }
    for (const value of Object.values<Raw>(blob)) {
      const pageProps = value?.loaderData?.pageProps;
      if (pageProps?.product?.itemNo === itemNo) return pageProps;
    }
  }
  return null;
}

export type Product = Awaited<ReturnType<typeof getProduct>>;

export async function getProduct(rawItemNo: string) {
  const itemNo = normalizeItemNo(rawItemNo);
  // Combinations (modular sofas, BESTÅ, PAX...) are prefixed with "s".
  const dir = `${SITE}/products/${itemNo.slice(-3)}`;
  const basic: Raw = (await getJson(`${dir}/${itemNo}.json`)) ?? (await getJson(`${dir}/s${itemNo}.json`));
  if (!basic) throw new Error(`Item ${itemNo} not found on ikea.com/${COUNTRY}`);

  const out = {
    itemNo,
    name: basic.name as string,
    type: basic.typeName as string,
    color: (basic.validDesignText || undefined) as string | undefined,
    price: basic.priceNumeral as number,
    currency: basic.currencyCode as string,
    style: (basic.styleGroup || undefined) as string | undefined,
    rating: basic.experimental?.rating?.ratingValue
      ? `${basic.experimental.rating.ratingValue}/5 (${basic.experimental.rating.ratingCount} reviews)`
      : undefined,
    url: basic.pipUrl as string,
    description: undefined as string | undefined,
    dimensionsSummary: undefined as string | undefined,
    ecoFee: undefined as string | undefined,
    onlineSellable: undefined as boolean | undefined,
    storeOnly: undefined as boolean | undefined,
    food: undefined as boolean | undefined,
    dimensions: undefined as string[] | undefined,
    packaging: undefined as ReturnType<typeof summarizePackaging>,
    goodToKnow: undefined as string[] | undefined,
    returnDays: undefined as number | undefined,
    components: undefined as { itemNo: string; name: string; type: string; quantity: number }[] | undefined,
  };

  const page = await get(out.url, 'text/html').catch(() => null);
  const props = page && (await findProductProps(page, itemNo));
  if (!props) return out;

  const p = props.product;
  const info = props.productInformationSectionProps ?? {};
  out.description = p.description;
  out.dimensionsSummary = p.itemMeasureReferenceText || undefined;
  out.ecoFee = p.ecoWeeFees?.[0]?.amount;
  out.onlineSellable = p.isServerOnlineSellable;
  out.storeOnly = p.isServerOnlySoldInStore || undefined;
  out.food = p.isFood || undefined;
  out.dimensions = (info.measurementsProps?.measurements ?? []).map((m: Raw) => `${m.name}: ${m.measure}`);
  out.packaging = summarizePackaging(p.packaging);
  out.goodToKnow = info.productDetailsProps?.accordionObject?.goodToKnow?.contentProps?.goodToKnow?.map((g: Raw) => g.text);
  out.returnDays = p.returnPolicy?.numberOfDays;
  if (p.subProducts?.length) {
    out.components = p.subProducts.map((s: Raw) => ({ itemNo: s.itemNo, name: s.name, type: s.typeName, quantity: s.quantity }));
  }
  return out;
}

const normalizeText = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const DAYS: Record<string, string> = { MON: 'Mon', TUE: 'Tue', WED: 'Wed', THU: 'Thu', FRI: 'Fri', SAT: 'Sat', SUN: 'Sun' };

export async function listStores(city?: string) {
  const stores: Raw[] = (await getJson(`${SITE}/meta-data/informera/stores-detailed.json`)) ?? [];
  const today = new Date().toISOString().slice(0, 10);
  const needle = city ? normalizeText(city) : null;
  return stores
    .filter((s) => !s.hideStore)
    .filter((s) => !needle || normalizeText(`${s.name} ${s.address?.city ?? ''} ${s.address?.zipCode ?? ''}`).includes(needle))
    .map((s) => ({
      id: s.id as string,
      name: (s.displayName || s.name) as string,
      address: [s.address?.street, s.address?.zipCode, s.address?.city].filter(Boolean).join(', '),
      hours: (s.hours?.normal ?? []).map((h: Raw) => `${DAYS[h.day] ?? h.day} ${h.open}-${h.close}`).join(', '),
      upcomingClosures: (s.hours?.closed ?? [])
        .filter((c: Raw) => c.date >= today)
        .slice(0, 3)
        .map((c: Raw) => (c.reason ? `${c.date} (${c.reason})` : c.date)) as string[],
      url: s.storePageUrl as string,
    }));
}
