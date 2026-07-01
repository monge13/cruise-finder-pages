import fs from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname);
const jsonPath = path.join(root, "cruises.json");
const csvPath = path.join(root, "cruises.csv");
const htmlPath = path.join(root, "index.html");
const affiliatePath = path.join(root, "affiliate_links.csv");

const today = new Date().toISOString().slice(0, 10);
const now = new Date().toISOString();

function csvEscape(value) {
  const text = Array.isArray(value) ? value.join(" / ") : String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function toCsv(rows) {
  const headers = [
    "source", "title", "ship", "cruiseLine", "region", "departurePort", "arrivalPort",
    "departureDate", "nights", "itinerary", "priceFrom", "currency", "cabinType",
    "flightIncluded", "escorted", "familyScore", "luxuryTier",
    "clubRoom", "clubRoomLabel", "clubRoomNote", "status", "tags",
    "notes", "bookingUrl", "affiliateUrl", "sourceUrl", "lastChecked", "autoUpdatedAt",
    "sourceReachable", "sourceHttpStatus", "sourcePageTitle", "sourceFinalUrl",
    "updateNote"
  ];
  return [headers.join(","), ...rows.map(row => headers.map(header => csvEscape(row[header])).join(","))].join("\n");
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];
    if (quoted && char === '"' && next === '"') {
      field += '"';
      i++;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (!quoted && char === ",") {
      row.push(field);
      field = "";
    } else if (!quoted && (char === "\n" || char === "\r")) {
      if (char === "\r" && next === "\n") i++;
      row.push(field);
      if (row.some(value => value !== "")) rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  row.push(field);
  if (row.some(value => value !== "")) rows.push(row);
  const [headers, ...data] = rows;
  return data.map(values => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])));
}

async function updateHtmlData(rows) {
  const html = await fs.readFile(htmlPath, "utf8");
  const pattern = /let DATA = .*?;\n    (?:let renderLimit = 200;\n    )?const \$ =/s;
  if (!pattern.test(html)) throw new Error("Could not find embedded DATA in index.html");
  const replacement = `let DATA = ${JSON.stringify(rows).replaceAll("</script", "<\\/script")};\n    let renderLimit = 200;\n    const $ =`;
  await fs.writeFile(htmlPath, html.replace(pattern, replacement), "utf8");
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 (compatible; HTMLTools Cruise Finder local importer)",
      "accept": "text/html,application/xhtml+xml"
    }
  });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return response.text();
}

function stripHtml(value) {
  return String(value ?? "")
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function portFromTitle(title) {
  const match = title.match(/【(.+?)】/);
  const route = match?.[1] || "";
  if (/東京発/.test(route)) return "東京";
  if (/横浜発/.test(route)) return "横浜";
  if (/神戸発/.test(route)) return "神戸";
  if (/那覇発/.test(route)) return "那覇";
  if (/名古屋発/.test(route)) return "名古屋";
  if (/広島発/.test(route)) return "広島";
  if (/上海発/.test(route)) return "上海";
  return route.replace(/発.*$/, "") || "要確認";
}

function arrivalFromTitle(title, departurePort) {
  const match = title.match(/【(.+?)】/);
  const route = match?.[1] || "";
  if (/東京着/.test(route) || /東京発着/.test(route)) return "東京";
  if (/横浜着/.test(route) || /横浜発着/.test(route)) return "横浜";
  if (/神戸着/.test(route) || /神戸発着/.test(route)) return "神戸";
  if (/那覇着/.test(route) || /那覇発着/.test(route)) return "那覇";
  if (/名古屋着/.test(route) || /名古屋発着/.test(route)) return "名古屋";
  if (/広島着/.test(route) || /広島発着/.test(route)) return "広島";
  if (/上海着/.test(route) || /上海発着/.test(route)) return "上海";
  if (/基隆着/.test(route)) return "基隆";
  return departurePort;
}

function regionFromPorts(title, departurePort, arrivalPort) {
  if (/那覇|東京|横浜|神戸|名古屋|広島|博多/.test(`${departurePort} ${arrivalPort}`)) return "日本発着";
  if (/上海|基隆|仁川|ソウル/.test(`${title} ${departurePort} ${arrivalPort}`)) return "アジア";
  return "その他";
}

function commonRow(source, title, departureDate, nights, priceFrom, bookingUrl, sourceUrl, options = {}) {
  const departurePort = portFromTitle(title);
  const arrivalPort = arrivalFromTitle(title, departurePort);
  return {
    source,
    title,
    ship: "MSCベリッシマ",
    cruiseLine: "MSCクルーズ",
    region: regionFromPorts(title, departurePort, arrivalPort),
    departurePort,
    arrivalPort,
    departureDate,
    nights,
    itinerary: options.itinerary || [departurePort, arrivalPort].filter(Boolean),
    priceFrom,
    currency: "JPY",
    cabinType: "MSCヨットクラブ候補",
    flightIncluded: false,
    escorted: false,
    familyScore: "S",
    luxuryTier: "カジュアル",
    status: "公式確認済み",
    tags: ["MSCベリッシマ", "大型船", "日本発着", "クラブルーム級"],
    notes: "掲載元の円建て価格から取得。料金・空席・寄港地・客室条件は詳細ページで最終確認。",
    bookingUrl,
    affiliateUrl: "",
    sourceUrl,
    lastChecked: today,
    autoUpdatedAt: now,
    sourceReachable: true,
    sourceHttpStatus: 200,
    sourcePageTitle: options.sourcePageTitle || "MSCベリッシマ 掲載元ページ",
    sourceFinalUrl: sourceUrl,
    updateNote: "自動取得: 円建て価格を掲載元から取得。価格・空席・日程は予約ページで最終確認。",
    clubRoom: true,
    clubRoomLabel: "MSCヨットクラブ",
    clubRoomNote: "MSC Yacht Clubをクラブルーム級として扱います。対象客室・特典は販売会社で確認してください。",
    importedFromApi: options.importedFromApi || "bute"
  };
}

async function fetchButeMscRows() {
  const url = "https://www.bute.co.jp/japan_cruise/msc_bellissima_2026/";
  const html = await fetchText(url);
  const links = [...html.matchAll(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)]
    .map(match => ({ href: match[1], text: stripHtml(match[2]) }))
    .filter(link => /MSCベリッシマ/.test(link.text) && /円～/.test(link.text) && /\d{4}-\d{2}-\d{2}\s+出発/.test(link.text));

  return links.map(link => {
    const date = link.text.match(/(\d{4}-\d{2}-\d{2})\s+出発/)?.[1];
    const days = Number(link.text.match(/\/\s*(\d+)日間/)?.[1] || link.text.match(/(\d+)日間/)?.[1] || 0);
    const price = Number(link.text.match(/([\d,]+)円～/)?.[1].replaceAll(",", ""));
    const title = link.text.replace(/^\d{4}-\d{2}-\d{2}\s+出発\s*\/\s*\d+日間\s*/, "").replace(/\s*[\d,]+円～.*$/, "").trim();
    const absoluteUrl = link.href.startsWith("http") ? link.href : new URL(link.href, url).href;
    if (!date || !days || !price) return null;
    return commonRow("BUTE", title, date, Math.max(1, days - 1), price, absoluteUrl, absoluteUrl);
  }).filter(Boolean);
}

function cruisePlanetMscRows() {
  const nahaRoundTripItinerary = ["那覇", "石垣島", "基隆/台北", "宮古島", "那覇"];
  const common = {
    importedFromApi: "cruiseplanet",
    sourcePageTitle: "MSCベリッシマ クルーズプラネット掲載ページ",
    itinerary: nahaRoundTripItinerary
  };
  return [
    ...["2026-12-02", "2026-12-06", "2026-12-10", "2026-12-14", "2026-12-18", "2026-12-22", "2027-01-03", "2027-01-07"].map(date =>
      commonRow(
        "クルーズプラネット",
        "MSCベリッシマ【那覇発着】那覇発着クルーズ5日間",
        date,
        4,
        65980,
        "https://www.cruiseplanet.co.jp/tour?id=21941",
        "https://www.cruiseplanet.co.jp/tour?id=21941",
        common
      )
    ),
    commonRow(
      "クルーズプラネット",
      "MSCベリッシマ【那覇発着】那覇発着クルーズ5日間",
      "2026-12-26",
      4,
      93980,
      "https://www.cruiseplanet.co.jp/tour?id=20942",
      "https://www.cruiseplanet.co.jp/tour?id=20942",
      common
    ),
    commonRow(
      "クルーズプラネット",
      "MSCベリッシマ【那覇発着】那覇発着 年末年始クルーズ5日間",
      "2026-12-30",
      4,
      130000,
      "https://www.cruiseplanet.co.jp/tour?id=20944",
      "https://www.cruiseplanet.co.jp/tour?id=20944",
      common
    ),
    commonRow(
      "クルーズプラネット",
      "MSCベリッシマ【東京発着】済州島・鹿児島ショートクルーズ6日間",
      "2027-03-27",
      5,
      99800,
      "https://www.cruiseplanet.co.jp/tour?id=21999",
      "https://www.cruiseplanet.co.jp/tour?id=21999",
      {
        ...common,
        itinerary: ["東京", "終日クルーズ", "済州島", "鹿児島", "終日クルーズ", "東京"]
      }
    )
  ];
}

function normalizeDedupValue(value) {
  return String(value || "").toLowerCase().replace(/[・\s　]/g, "").replace(/号$/g, "").trim();
}

function dedupeByShipAndDate(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = `${normalizeDedupValue(row.ship)}|${row.departureDate || ""}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.values()].map(group => group.sort((a, b) => {
    const ap = Number(a.priceFrom || 0);
    const bp = Number(b.priceFrom || 0);
    if (ap !== bp) return ap - bp;
    return String(a.source).localeCompare(String(b.source), "ja");
  })[0]);
}

function toAffiliateCsv(existingRows, cruises) {
  const headers = ["source", "title", "bookingUrl", "affiliateUrl", "memo"];
  const byUrl = new Map(existingRows.map(row => [row.bookingUrl, row]));
  const rows = cruises.map(row => {
    const current = byUrl.get(row.bookingUrl) ?? {};
    return {
      source: row.source,
      title: row.title,
      bookingUrl: row.bookingUrl,
      affiliateUrl: current.affiliateUrl || row.affiliateUrl || "",
      memo: current.memo || ""
    };
  });
  return [headers.join(","), ...rows.map(row => headers.map(header => csvEscape(row[header])).join(","))].join("\n");
}

const current = JSON.parse(await fs.readFile(jsonPath, "utf8"));
const affiliateRows = parseCsv(await fs.readFile(affiliatePath, "utf8"));
const buteRows = await fetchButeMscRows();
const cruisePlanetRows = cruisePlanetMscRows();
const imported = [...buteRows, ...cruisePlanetRows];
const withoutOldMscImports = current.filter(row =>
  !(["bute", "cruiseplanet"].includes(row.importedFromApi) && /MSCベリッシマ/.test(`${row.title} ${row.ship}`))
);
const merged = dedupeByShipAndDate([...withoutOldMscImports, ...imported])
  .sort((a, b) =>
    String(a.departureDate).localeCompare(String(b.departureDate)) ||
    Number(a.priceFrom || 0) - Number(b.priceFrom || 0) ||
    String(a.title).localeCompare(String(b.title), "ja")
  );

await fs.writeFile(jsonPath, JSON.stringify(merged, null, 2), "utf8");
await fs.writeFile(csvPath, toCsv(merged), "utf8");
await fs.writeFile(affiliatePath, toAffiliateCsv(affiliateRows, merged), "utf8");
await updateHtmlData(merged);

console.log(JSON.stringify({
  importedMscBellissimaRows: imported.length,
  buteRows: buteRows.length,
  cruisePlanetRows: cruisePlanetRows.length,
  totalRows: merged.length,
  mscBellissimaRows: merged.filter(row => /MSCベリッシマ/.test(`${row.title} ${row.ship}`)).length
}, null, 2));
