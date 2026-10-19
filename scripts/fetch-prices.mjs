// Hakee tuotteiden hinnat K-Ruoasta (Citymarket Malmi) ja S-kaupoista (Prisma Malmi)
// ja kirjoittaa ne tiedostoon prices.json. Vaatii Node 20+.
//
// Jos jokin tuote jää ilman hintaa, skripti päättyy virheeseen eikä korvaa vanhaa
// prices.json-tiedostoa osittaisella datalla. GitHub lähettää silloin ilmoituksen.

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

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const cents = (euros) => Math.round(Number(euros) * 100);

async function getText(url, headers = {}) {
  const r = await fetch(url, { headers: { "user-agent": UA, ...headers } });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.text();
}

// ---------- K-Ruoka ----------
async function kBuildNumber() {
  try {
    const html = await getText("https://www.k-ruoka.fi/kauppa");
    const m = html.match(/\/assets\/b-(\d+)\//);
    if (m) return m[1];
  } catch (e) {
    console.warn("K-Ruoan versionumeron luku epäonnistui:", e.message);
  }
  return "33322";
}

async function kPrice(ean, build) {
  const url =
    `https://www.k-ruoka.fi/kr-api/v2/product-search/${ean}` +
    `?offset=0&language=fi&storeId=${K_STORE}&limit=5&discountFilter=false&isTrOffer=false`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "user-agent": UA,
      accept: "application/json",
      "content-type": "application/json",
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
    // Yksittäiskappaleen tarjous, esim. Plussa-hinta
    out.deal = { n: 1, total: cents(b.price), type: b.discountType || null, until: b.endDate || null };
  }
  return out;
}

// ---------- S-kaupat ----------
const S_HASH = "85a4eed2f0a1e3269ac49b94276ca952922568369d85ddd5dcee34481e4c0f91";

async function sClientVersion() {
  try {
    const html = await getText("https://www.s-kaupat.fi/");
    const m = html.match(/production-[0-9a-f]{40}/);
    if (m) return m[0];
  } catch (e) {
    console.warn("S-kaupan versiotunnisteen luku epäonnistui:", e.message);
  }
  return "production-ed41c245ef7e78b3b122cf09655d030016bc0dcb";
}

async function sPrice(ean, version) {
  const vars = { facets: [], limit: 5, loop54DirectSearch: true, queryString: ean, storeId: S_STORE, useRandomId: true };
  const url =
    "https://api.s-kaupat.fi?operationName=RemoteFilteredProducts" +
    `&variables=${encodeURIComponent(JSON.stringify(vars))}` +
    `&extensions=${encodeURIComponent(JSON.stringify({ persistedQuery: { version: 1, sha256Hash: S_HASH } }))}`;
  const r = await fetch(url, {
    headers: {
      "user-agent": UA,
      accept: "application/json",
      "content-type": "application/json",
      "x-client-name": "skaupat-web",
      "x-client-version": version,
      "accept-language": "fi",
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
async function main() {
  const [build, version] = await Promise.all([kBuildNumber(), sClientVersion()]);
  const products = {};
  const problems = [];

  for (const p of PRODUCTS) {
    products[p.id] = {};
    for (const [store, fn, arg] of [
      ["cm", kPrice, build],
      ["pm", sPrice, version],
    ]) {
      try {
        const res = await fn(p[store], arg);
        if (res) products[p.id][store] = res;
        else problems.push(`${p.id}/${store}: tuotetta tai hintaa ei löytynyt (EAN ${p[store]})`);
      } catch (e) {
        problems.push(`${p.id}/${store}: ${e.message}`);
      }
      await new Promise((r) => setTimeout(r, 400)); // ei rasiteta palvelimia
    }
  }

  if (problems.length) {
    console.error("Haku epäonnistui osittain, prices.json jätetään ennalleen:\n- " + problems.join("\n- "));
    process.exit(1);
  }

  const data = {
    fetched: new Date().toISOString(),
    stores: { cm: "Citymarket Malmi (K-Ruoka)", pm: "Prisma Malmi (S-kaupat)" },
    products,
  };
  await writeFile(OUT, JSON.stringify(data, null, 2) + "\n");
  console.log("Valmis:", Object.keys(products).length, "tuotetta,", new Date().toISOString());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
