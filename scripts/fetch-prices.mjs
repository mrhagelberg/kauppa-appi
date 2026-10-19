// Hakee tuotteiden hinnat K-Ruoasta (Citymarket Malmi) ja S-kaupoista (Prisma Malmi)
// ja kirjoittaa ne tiedostoon prices.json. Vaatii Node 20+.
//
// Kumpikin kauppa päivitetään erikseen: jos toisen haku epäonnistuu (esim. kauppa estää
// palvelinosoitteet), sen vanhat hinnat jäävät ennalleen ja toisen uudet hinnat tallennetaan.
// Sivu varoittaa, jos vanhimmat hinnat ovat yli kolme päivää vanhoja.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "prices.json");

const K_STORE = "N149"; // Citymarket Malmi
const S_STORE = "513971200"; // Prisma Malmi (noutopiste)

// EAN-koodit kaupoittain. Samalla tuotteella voi olla eri EAN eri kaupoissa (kaupan oma merkki).
const PRODUCTS = [
  { id: "ikaffe", cm: "7394376616037", pm: "7394376616037" },
  { id: "pf-ak", cm: "6408430407217", pm: "6408430407217" },
  { id: "pf-pv", cm: "6408430401857", pm: "6408430401857" },
  { id: "nocco", cm: "7340131608014", pm: "7340131608014" },
  { id: "riisi", cm: "6410405272683", pm: "6438574170593" },
  { id: "raejuusto", cm: "6408430043071", pm: "6408430043071" },
  { id: "olter", cm: "6408430347155", pm: "6408430347155" },
  { id: "maito", cm: "6410405082657", pm: "6414893386488" },
  { id: "kaura", cm: "6410405346780", pm: "6414891802096" },
];

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const BROWSER = {
  "user-agent": UA,
  "accept-language": "fi-FI,fi;q=0.9,en;q=0.8",
  "sec-ch-ua": '"Chromium";v="130", "Google Chrome";v="130", "Not?A_Brand";v="99"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "same-origin",
};
const cents = (euros) => Math.round(Number(euros) * 100);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- K-Ruoka ----------
const K_BUILD_FALLBACK = "33322";

async function kBuildNumber() {
  try {
    const r = await fetch("https://www.k-ruoka.fi/kauppa", {
      headers: { ...BROWSER, accept: "text/html,application/xhtml+xml", "sec-fetch-dest": "document", "sec-fetch-mode": "navigate" },
    });
    if (r.ok) {
      const m = (await r.text()).match(/\/assets\/b-(\d+)\//);
      if (m) return m[1];
    } else {
      console.warn(`K-Ruoan etusivu -> ${r.status}, käytetään varaversiota`);
    }
  } catch (e) {
    console.warn("K-Ruoan versionumeron luku epäonnistui:", e.message);
  }
  return K_BUILD_FALLBACK;
}

async function kPrice(ean, build) {
  const url =
    `https://www.k-ruoka.fi/kr-api/v2/product-search/${ean}` +
    `?offset=0&language=fi&storeId=${K_STORE}&limit=5&discountFilter=false&isTrOffer=false`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      ...BROWSER,
      accept: "application/json",
      "content-type": "application/json",
      origin: "https://www.k-ruoka.fi",
      referer: `https://www.k-ruoka.fi/kauppa/tuotehaku?haku=${ean}`,
      "x-k-build-number": build,
    },
    body: JSON.stringify({ filters: {} }),
  });
  if (!r.ok) throw new Error(`K-Ruoka ${ean} -> ${r.status}`);
  const j = await r.json();
  const hit = (j.result || []).map((x) => x.product).find((p) => p && p.ean === ean);
  const pricing = hit?.mobilescan?.pricing;
  if (!hit || !pricing?.normal?.price) return null;
  const out = { cents: cents(pricing.normal.price) };
  const b = pricing.batch;
  if (b && b.amount > 1 && b.price) {
    out.deal = { n: b.amount, total: cents(b.price), type: b.discountType || null, until: b.endDate || null };
  } else if (b && b.price && b.price < pricing.normal.price) {
    out.deal = { n: 1, total: cents(b.price), type: b.discountType || null, until: b.endDate || null };
  }
  return out;
}

// ---------- S-kaupat ----------
const S_HASH = "85a4eed2f0a1e3269ac49b94276ca952922568369d85ddd5dcee34481e4c0f91";
const S_VERSION = "production-ed41c245ef7e78b3b122cf09655d030016bc0dcb";

async function sPrice(ean) {
  const vars = { facets: [], limit: 5, loop54DirectSearch: true, queryString: ean, storeId: S_STORE, useRandomId: true };
  const url =
    "https://api.s-kaupat.fi?operationName=RemoteFilteredProducts" +
    `&variables=${encodeURIComponent(JSON.stringify(vars))}` +
    `&extensions=${encodeURIComponent(JSON.stringify({ persistedQuery: { version: 1, sha256Hash: S_HASH } }))}`;
  const r = await fetch(url, {
    headers: {
      ...BROWSER,
      accept: "application/json",
      "content-type": "application/json",
      origin: "https://www.s-kaupat.fi",
      referer: "https://www.s-kaupat.fi/",
      "sec-fetch-site": "same-site",
      "x-client-name": "skaupat-web",
      "x-client-version": S_VERSION,
    },
  });
  if (!r.ok) throw new Error(`S-kaupat ${ean} -> ${r.status}`);
  const j = await r.json();
  if (j.errors?.length) throw new Error(`S-kaupat ${ean}: ${j.errors[0].message}`);
  const hit = (j.data?.store?.products?.productListItems || []).map((x) => x.product).find((p) => p && p.ean === ean);
  const price = hit?.pricing?.currentPrice ?? hit?.price;
  if (!hit || price == null) return null;
  return { cents: cents(price) };
}

// ---------- Ajo ----------
async function fetchStore(store, fn, arg) {
  const result = {};
  const problems = [];
  for (const p of PRODUCTS) {
    try {
      const res = await fn(p[store], arg);
      if (res) result[p.id] = res;
      else problems.push(`${p.id}: tuotetta tai hintaa ei löytynyt (EAN ${p[store]})`);
    } catch (e) {
      problems.push(`${p.id}: ${e.message}`);
    }
    await sleep(500);
  }
  return { result, problems };
}

async function main() {
  let old = { products: {}, storeFetched: {} };
  try {
    old = JSON.parse(await readFile(OUT, "utf8"));
  } catch {}
  const now = new Date().toISOString();
  const storeFetched = { cm: old.storeFetched?.cm || old.fetched || now, pm: old.storeFetched?.pm || old.fetched || now };
  const products = {};
  for (const p of PRODUCTS) products[p.id] = { ...(old.products?.[p.id] || {}) };

  const build = await kBuildNumber();
  const runs = [
    ["cm", "K-Ruoka (Citymarket Malmi)", () => fetchStore("cm", kPrice, build)],
    ["pm", "S-kaupat (Prisma Malmi)", () => fetchStore("pm", sPrice)],
  ];

  let okStores = 0;
  for (const [store, label, run] of runs) {
    const { result, problems } = await run();
    if (problems.length) {
      console.warn(`${label}: haku epäonnistui, vanhat hinnat jätetään ennalleen:\n- ${problems.join("\n- ")}`);
      continue;
    }
    for (const [id, val] of Object.entries(result)) products[id][store] = val;
    storeFetched[store] = now;
    okStores++;
    console.log(`${label}: ${Object.keys(result).length} hintaa päivitetty`);
  }

  if (okStores === 0) {
    console.error("Kumpikaan kauppa ei vastannut. prices.json jätetään ennalleen.");
    process.exit(1);
  }

  const data = {
    fetched: [storeFetched.cm, storeFetched.pm].sort()[0], // vanhin hintojen päivitysaika
    storeFetched,
    stores: { cm: "Citymarket Malmi (K-Ruoka)", pm: "Prisma Malmi (S-kaupat)" },
    products,
  };
  await writeFile(OUT, JSON.stringify(data, null, 2) + "\n");
  console.log("Valmis", now);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
