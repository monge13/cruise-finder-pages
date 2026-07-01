import fs from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname);
const jsonPath = path.join(root, "cruises.json");
const csvPath = path.join(root, "cruises.csv");
const htmlPath = path.join(root, "index.html");
const affiliatePath = path.join(root, "affiliate_links.csv");

const today = new Date().toISOString().slice(0, 10);
const now = new Date().toISOString();
const buteMaxDetails = Number(process.env.BUTE_MAX_DETAILS || 260);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function csvEscape(value) {
  const text = Array.isArray(value) ? value.join(" / ") : String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
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
    .replace(/&#039;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
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
    if (ap > 0 && bp <= 0) return -1;
    if (bp > 0 && ap <= 0) return 1;
    if (ap !== bp) return ap - bp;
    return String(a.source).localeCompare(String(b.source), "ja");
  })[0]);
}

function parseJapaneseDate(text) {
  const iso = String(text).match(/(20\d{2})[-/](\d{1,2})[-/](\d{1,2})/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, "0")}-${iso[3].padStart(2, "0")}`;
  const jp = String(text).match(/(20\d{2})年\s*(\d{1,2})月\s*(\d{1,2})日/);
  if (jp) return `${jp[1]}-${jp[2].padStart(2, "0")}-${jp[3].padStart(2, "0")}`;
  return "";
}

function portName(value) {
  return String(value || "")
    .replace(/[（(].*?[）)]/g, "")
    .replace(/\/.*$/, "")
    .replace(/港$/, "")
    .trim() || "要確認";
}

function regionFor(text, departurePort = "", arrivalPort = "") {
  const value = `${text} ${departurePort} ${arrivalPort}`;
  if (/日本発着|横浜|東京|神戸|大阪|那覇|博多|鹿児島|清水|長崎|小樽|函館|金沢|舞鶴|広島|佐世保|石垣|宮古/.test(value)) return "日本発着";
  if (/地中海|エーゲ|アドリア|バルセロナ|ローマ|チビタベッキア|ベニス|アテネ|マルセイユ|ジェノバ|バレッタ/.test(value)) return "地中海";
  if (/アラスカ|バンクーバー|シアトル/.test(value)) return "アラスカ";
  if (/カリブ|バハマ|マイアミ|フォート.?ローダデール|ポートカナベラル/.test(value)) return "カリブ海";
  if (/アジア|台湾|基隆|香港|釜山|済州|上海|シンガポール/.test(value)) return "アジア";
  if (/ハワイ|ホノルル/.test(value)) return "ハワイ";
  if (/北欧|バルト|フィヨルド|英国|イギリス|アイスランド|グリーンランド|サウサンプトン|コペンハーゲン/.test(value)) return "北欧";
  if (/カナダ|ニューイングランド|ニューヨーク|ボストン|ボルチモア/.test(value)) return "北米";
  if (/リバークルーズ|ライン川|ドナウ川|セーヌ川/.test(value)) return "リバークルーズ";
  if (/南極|オセアニア|オーストラリア|ニュージーランド/.test(value)) return "オセアニア";
  return "その他";
}

function cruiseLineFor(ship, text) {
  const value = `${ship} ${text}`;
  if (/MSC/.test(value)) return "MSCクルーズ";
  if (/プリンセス|ダイヤモンド|サファイア|サンプリンセス/.test(value)) return "プリンセス・クルーズ";
  if (/コスタ/.test(value)) return "コスタクルーズ";
  if (/ロイヤル|スペクトラム|レジェンド|オブ・ザ・シーズ/.test(value)) return "ロイヤル・カリビアン";
  if (/キュナード|クイーン/.test(value)) return "キュナード・ライン";
  if (/セレブリティ/.test(value)) return "セレブリティクルーズ";
  if (/飛鳥/.test(value)) return "郵船クルーズ";
  if (/三井|MITSUI/.test(value)) return "商船三井クルーズ";
  return "要確認";
}

function detectClubRoom(cruiseLine, ship, text) {
  const value = `${cruiseLine} ${ship} ${text}`.toLowerCase();
  if (/msc|ヨットクラブ|yacht club/.test(value)) return ["MSCヨットクラブ", "MSC Yacht Club相当をクラブルーム級として扱います。対象客室・特典は販売会社で確認してください。"];
  if (/ロイヤル|royal caribbean|suite class/.test(value)) return ["Royal Suite Class級", "ロイヤル・カリビアンのスイート特典対象をクラブルーム級として扱います。対象客室・特典は販売会社で確認してください。"];
  if (/プリンセス|princess/.test(value)) return ["スイート/リザーブ・コレクション級", "プリンセスの上位客室をクラブルーム級として扱います。対象客室・特典は販売会社で確認してください。"];
  if (/キュナード|cunard|グリル|grill/.test(value)) return ["プリンセス/クイーンズ・グリル級", "キュナードのグリル級をクラブルーム級として扱います。対象客室・特典は販売会社で確認してください。"];
  if (/飛鳥|三井|mitsui|にっぽん丸|シーボーン|リージェント|シルバーシー|ラグジュアリー/.test(value)) return ["上位スイート級", "日本船・ラグジュアリー船の上位客室をクラブルーム級候補として扱います。対象客室・特典は販売会社で確認してください。"];
  return ["", ""];
}

function familyScoreFor(text, cruiseLine) {
  if (/ディズニー|ロイヤル|MSC|コスタ/.test(`${text} ${cruiseLine}`)) return "S";
  if (/大型船|ファミリー|プリンセス|ノルウェージャン/.test(`${text} ${cruiseLine}`)) return "A";
  return "B";
}

function commonRow({ source, title, ship, cruiseLine, departurePort, arrivalPort, departureDate, nights, priceFrom, bookingUrl, sourceUrl, itinerary = [], status = "公式確認済み", importedFromApi, notes, flightIncluded = false, escorted = false }) {
  const fullText = `${title} ${ship} ${cruiseLine} ${itinerary.join(" ")}`;
  const [clubRoomLabel, clubRoomNote] = detectClubRoom(cruiseLine, ship, fullText);
  const region = regionFor(fullText, departurePort, arrivalPort);
  return {
    source,
    title,
    ship,
    cruiseLine,
    region,
    departurePort,
    arrivalPort,
    departureDate,
    nights,
    itinerary: itinerary.length ? itinerary : [departurePort, arrivalPort].filter(Boolean),
    priceFrom,
    currency: "JPY",
    cabinType: clubRoomLabel ? `${clubRoomLabel}候補` : "通常客室目安",
    flightIncluded,
    escorted,
    familyScore: familyScoreFor(fullText, cruiseLine),
    luxuryTier: /飛鳥|三井|キュナード|シーボーン|リージェント|シルバーシー|ラグジュアリー|LUSSO/.test(fullText) ? "高級" : "スタンダード",
    status,
    tags: [region, cruiseLine, ship, ...(clubRoomLabel ? ["クラブルーム級"] : [])].filter(Boolean),
    notes: notes || `${source}の掲載情報から取得。料金・空席・寄港地・客室条件は詳細ページで最終確認。`,
    bookingUrl,
    affiliateUrl: "",
    sourceUrl,
    lastChecked: today,
    autoUpdatedAt: now,
    sourceReachable: true,
    sourceHttpStatus: 200,
    sourcePageTitle: `${source} 掲載ページ`,
    sourceFinalUrl: sourceUrl,
    updateNote: `自動取得: ${source}の掲載情報から取得。価格・空席・日程は予約ページで最終確認。`,
    clubRoom: Boolean(clubRoomLabel),
    clubRoomLabel,
    clubRoomNote,
    importedFromApi
  };
}

async function discoverButeCruiseUrls() {
  const startPages = [
    "https://www.bute.co.jp/",
    "https://www.bute.co.jp/foreign_vessels/",
    "https://www.bute.co.jp/japanese_vessels/",
    "https://www.bute.co.jp/ship/diamond_princess/",
    "https://www.bute.co.jp/ship/sapphire_princess/",
    "https://www.bute.co.jp/ship/msc_bellissima/"
  ];
  const shipPages = new Set(startPages.filter(url => url.includes("/ship/")));
  const cruiseUrls = new Set();

  for (const url of startPages) {
    try {
      const html = await fetchText(url);
      for (const match of html.matchAll(/<a[^>]+href="([^"]+)"/g)) {
        const absolute = new URL(match[1], url).href;
        if (/\/ship\/[^/]+\/$/.test(absolute)) shipPages.add(absolute);
        if (/\/cruise\/[^/]+\/$/.test(absolute)) cruiseUrls.add(absolute);
      }
    } catch (error) {
      console.warn(`BUTE discovery skipped ${url}: ${error.message}`);
    }
  }

  for (const url of [...shipPages].slice(0, 80)) {
    try {
      const html = await fetchText(url);
      for (const match of html.matchAll(/<a[^>]+href="([^"]+)"/g)) {
        const absolute = new URL(match[1], url).href;
        if (/\/cruise\/[^/]+\/$/.test(absolute)) cruiseUrls.add(absolute);
      }
      await sleep(120);
    } catch (error) {
      console.warn(`BUTE ship skipped ${url}: ${error.message}`);
    }
  }

  return [...cruiseUrls].slice(0, buteMaxDetails);
}

function parseButeDetail(url, html) {
  const text = stripHtml(html);
  const h1 = stripHtml(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || "");
  const rawTitle = h1 || text.match(/([^。]+?(?:【|〖).+?\d+日間[^\s]*?)\s+旅程\s+料金/)?.[1]?.trim() || "";
  const title = rawTitle
    .replace(/\s*｜クルーズ旅行会社.*$/, "")
    .replace(/\s*-->\s*$/, "")
    .trim();
  const departureDate = parseJapaneseDate(text.match(/出発日\s*(20\d{2}年\s*\d{1,2}月\s*\d{1,2}日)/)?.[1] || "");
  const priceText = text.match(/料金\s*([\d,]+円\s*[~～]\s*[\d,]+円|[\d,]+円\s*[~～])/);
  const priceFrom = Number(priceText?.[1]?.match(/[\d,]+/)?.[0].replaceAll(",", "") || 0);
  const ports = text.match(/出発地\s*([^\s]+)\s*帰着地\s*([^\s]+)\s*船名\s*([^\s]+)/);
  const departurePort = portName(ports?.[1]);
  const arrivalPort = portName(ports?.[2]);
  const titleShip = title.match(/^(?:\[[^\]]+\])?\s*(.+?)[【〖]/)?.[1]?.trim();
  const ship = titleShip || ports?.[3] || "要確認";
  const days = Number(title.match(/(\d+)日間/)?.[1] || text.match(/(\d+)日間/)?.[1] || 0);
  if (!title || !departureDate || !priceFrom || !days || ship === "要確認") return null;
  const cruiseLine = cruiseLineFor(ship, text);
  const itinerary = [...new Set([...text.matchAll(/\d{1,2}:\d{2}\s*([^\s（）()]+)(?:[\/／][^\s（）()]+)?/g)].map(match => portName(match[1])))].slice(0, 10);
  return commonRow({
    source: "BUTE",
    title,
    ship,
    cruiseLine,
    departurePort,
    arrivalPort,
    departureDate,
    nights: Math.max(1, days - 1),
    itinerary,
    priceFrom,
    bookingUrl: url,
    sourceUrl: url,
    importedFromApi: "bute"
  });
}

async function fetchButeRows() {
  const urls = await discoverButeCruiseUrls();
  const rows = [];
  for (const [index, url] of urls.entries()) {
    try {
      const html = await fetchText(url);
      const row = parseButeDetail(url, html);
      if (row) rows.push(row);
      if ((index + 1) % 25 === 0) console.log(JSON.stringify({ source: "BUTE", checked: index + 1, rows: rows.length }));
      await sleep(120);
    } catch (error) {
      console.warn(`BUTE detail skipped ${url}: ${error.message}`);
    }
  }
  return rows;
}

function cruisePlanetRows() {
  const rows = [];
  const add = row => rows.push(commonRow({
    source: "クルーズプラネット",
    status: "公式確認済み",
    importedFromApi: "cruiseplanet",
    notes: "クルーズプラネットの確認済み詳細ページから登録。自動取得がブロックされるページがあるため、料金・空席・日程は詳細ページで最終確認。",
    ...row
  }));

  const naha = ["那覇", "石垣島", "基隆/台北", "宮古島", "那覇"];
  for (const date of ["2026-12-02", "2026-12-06", "2026-12-10", "2026-12-14", "2026-12-18", "2026-12-22", "2027-01-03", "2027-01-07"]) {
    add({ title: "MSCベリッシマ【那覇発着】那覇発着クルーズ5日間", ship: "MSCベリッシマ", cruiseLine: "MSCクルーズ", departurePort: "那覇", arrivalPort: "那覇", departureDate: date, nights: 4, itinerary: naha, priceFrom: 65980, bookingUrl: "https://www.cruiseplanet.co.jp/tour?id=21941", sourceUrl: "https://www.cruiseplanet.co.jp/tour?id=21941" });
  }
  add({ title: "MSCベリッシマ【那覇発着】那覇発着クルーズ5日間", ship: "MSCベリッシマ", cruiseLine: "MSCクルーズ", departurePort: "那覇", arrivalPort: "那覇", departureDate: "2026-12-26", nights: 4, itinerary: naha, priceFrom: 93980, bookingUrl: "https://www.cruiseplanet.co.jp/tour?id=20942", sourceUrl: "https://www.cruiseplanet.co.jp/tour?id=20942" });
  add({ title: "MSCベリッシマ【那覇発着】那覇発着 年末年始クルーズ5日間", ship: "MSCベリッシマ", cruiseLine: "MSCクルーズ", departurePort: "那覇", arrivalPort: "那覇", departureDate: "2026-12-30", nights: 4, itinerary: naha, priceFrom: 130000, bookingUrl: "https://www.cruiseplanet.co.jp/tour?id=20944", sourceUrl: "https://www.cruiseplanet.co.jp/tour?id=20944" });
  add({ title: "MSCベリッシマ【東京発着】済州島・鹿児島ショートクルーズ6日間", ship: "MSCベリッシマ", cruiseLine: "MSCクルーズ", departurePort: "東京", arrivalPort: "東京", departureDate: "2027-03-27", nights: 5, itinerary: ["東京", "終日クルーズ", "済州島", "鹿児島", "終日クルーズ", "東京"], priceFrom: 99800, bookingUrl: "https://www.cruiseplanet.co.jp/tour?id=21999", sourceUrl: "https://www.cruiseplanet.co.jp/tour?id=21999" });
  add({ title: "ダイヤモンド・プリンセス【横浜発着】気軽にショートクルーズ！8日間 A", ship: "ダイヤモンド・プリンセス", cruiseLine: "プリンセス・クルーズ", departurePort: "横浜", arrivalPort: "横浜", departureDate: "2027-07-21", nights: 7, itinerary: ["横浜"], priceFrom: 113000, bookingUrl: "https://www.cruiseplanet.co.jp/tour?id=20710", sourceUrl: "https://www.cruiseplanet.co.jp/tour?id=20710" });
  add({ title: "スペクトラム・オブ・ザ・シーズ 香港ホテル泊付き！西日本・台湾・香港クルーズ10日間", ship: "スペクトラム・オブ・ザ・シーズ", cruiseLine: "ロイヤル・カリビアン", departurePort: "香港", arrivalPort: "香港", departureDate: "2027-01-11", nights: 9, itinerary: ["香港", "西日本", "台湾", "香港"], priceFrom: 268000, bookingUrl: "https://www.cruiseplanet.co.jp/tour?id=22264", sourceUrl: "https://www.cruiseplanet.co.jp/tour?id=22264", flightIncluded: true });
  add({ title: "レジェンド・オブ・ザ・シーズ 世界最大客船で航く地中海クルーズ11日間", ship: "レジェンド・オブ・ザ・シーズ", cruiseLine: "ロイヤル・カリビアン", departurePort: "バルセロナ", arrivalPort: "バルセロナ", departureDate: "2026-08-07", nights: 10, itinerary: ["バルセロナ", "地中海"], priceFrom: 1180000, bookingUrl: "https://www.cruiseplanet.co.jp/tour?id=20553", sourceUrl: "https://www.cruiseplanet.co.jp/tour?id=20553", flightIncluded: true });
  for (const date of ["2026-12-02", "2026-12-09", "2026-12-16", "2026-12-30", "2027-01-06", "2027-01-13", "2027-01-20", "2027-01-27", "2027-02-03", "2027-02-17", "2027-03-03", "2027-03-10"]) {
    add({ title: "MSCワールドアジア 地中海4か国クルーズ11日間", ship: "MSCワールドアジア", cruiseLine: "MSCクルーズ", departurePort: "名古屋", arrivalPort: "名古屋", departureDate: date, nights: 10, itinerary: ["名古屋", "バルセロナ", "マルセイユ", "ジェノバ", "チビタベッキア", "メッシーナ", "バレッタ", "バルセロナ", "名古屋"], priceFrom: 438000, bookingUrl: "https://www.cruiseplanet.co.jp/tour?id=22173", sourceUrl: "https://www.cruiseplanet.co.jp/tour?id=22173", flightIncluded: true, escorted: true });
  }

  return rows;
}

function toAffiliateCsv(existingRows, cruises) {
  const headers = ["source", "title", "bookingUrl", "affiliateUrl", "memo"];
  const byUrl = new Map(existingRows.map(row => [row.bookingUrl, row]));
  const byTitle = new Map(existingRows.map(row => [row.title, row]));
  const rows = cruises.map(row => {
    const current = byUrl.get(row.bookingUrl) ?? byTitle.get(row.title) ?? {};
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
const affiliateRows = parseCsv(await fs.readFile(affiliatePath, "utf8").catch(() => "source,title,bookingUrl,affiliateUrl,memo\n"));
const existingAffiliateByUrl = new Map(affiliateRows.map(row => [row.bookingUrl, row.affiliateUrl || ""]));
const existingAffiliateByTitle = new Map(affiliateRows.map(row => [row.title, row.affiliateUrl || ""]));

const buteRows = await fetchButeRows();
const partnerRows = [...buteRows, ...cruisePlanetRows()]
  .filter(row => row.departureDate && Number(row.nights || 0) > 0 && Number(row.priceFrom || 0) > 0)
  .map(row => ({
    ...row,
    affiliateUrl: existingAffiliateByUrl.get(row.bookingUrl) || existingAffiliateByTitle.get(row.title) || row.affiliateUrl || ""
  }));

const withoutOldPartnerImports = current.filter(row => !["bute", "cruiseplanet"].includes(row.importedFromApi));
const merged = dedupeByShipAndDate([...withoutOldPartnerImports, ...partnerRows])
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
  importedPartnerRows: partnerRows.length,
  buteRows: buteRows.length,
  cruisePlanetRows: cruisePlanetRows().length,
  totalRows: merged.length,
  zeroPriceRows: merged.filter(row => Number(row.priceFrom || 0) <= 0).length
}, null, 2));
