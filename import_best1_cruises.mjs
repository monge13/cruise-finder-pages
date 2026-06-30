import fs from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname);
const jsonPath = path.join(root, "cruises.json");
const csvPath = path.join(root, "cruises.csv");
const htmlPath = path.join(root, "index.html");
const affiliatePath = path.join(root, "affiliate_links.csv");

const pageSize = Number(process.env.BEST1_PAGE_SIZE || 1000);
const maxPages = Number(process.env.BEST1_MAX_PAGES || 80);
const today = new Date().toISOString().slice(0, 10);
const now = new Date().toISOString();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function stripHtml(value) {
  return String(value ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
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

function toCruiseCsv(rows) {
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

async function updateHtmlData(rows) {
  const html = await fs.readFile(htmlPath, "utf8");
  const pattern = /let DATA = .*?;\n    (?:let renderLimit = 200;\n    )?const \$ =/s;
  if (!pattern.test(html)) throw new Error("Could not find embedded DATA in index.html");
  const replacement = `let DATA = ${JSON.stringify(rows).replaceAll("</script", "<\\/script")};\n    let renderLimit = 200;\n    const $ =`;
  await fs.writeFile(htmlPath, html.replace(pattern, replacement), "utf8");
}

function dateFromBest1(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  const match = String(raw ?? "").match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!match) return "";
  return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
}

function best1DateValue(row) {
  try {
    return JSON.parse(row.sub_large_image13 || "[]");
  } catch {
    return row.sub_large_image13;
  }
}

function durationFromText(text) {
  const match = String(text).match(/(\d+)泊(\d+)日/);
  return match ? Number(match[1]) : null;
}

function splitComment(row) {
  return String(row.comment3 || "").split(",").map(part => part.trim()).filter(Boolean);
}

function titleWithoutOnlineMark(title) {
  return String(title || "").replace(/^【オンライン予約可】/, "").trim();
}

function detectClubRoom(cruiseLine, ship, text) {
  const haystack = `${cruiseLine} ${ship} ${text}`.toLowerCase();
  if (/msc|ヨットクラブ|yacht club/.test(haystack)) return ["MSCヨットクラブ", "MSC Yacht Club相当をクラブルーム級として扱います。対象客室・特典は販売会社で確認してください。"];
  if (/ノルウェージャン|norwegian|ncl|haven/.test(haystack)) return ["The Haven級", "NCLのThe Haven相当をクラブルーム級として扱います。対象客室・特典は販売会社で確認してください。"];
  if (/ロイヤル.?カリビアン|royal caribbean|suite class/.test(haystack)) return ["Royal Suite Class級", "ロイヤル・カリビアンのスイート特典対象をクラブルーム級として扱います。対象客室・特典は販売会社で確認してください。"];
  if (/プリンセス|princess/.test(haystack)) return ["スイート/リザーブ・コレクション級", "プリンセスの上位客室をクラブルーム級として扱います。対象客室・特典は販売会社で確認してください。"];
  if (/キュナード|cunard|グリル|grill/.test(haystack)) return ["プリンセス/クイーンズ・グリル級", "キュナードのグリル級をクラブルーム級として扱います。対象客室・特典は販売会社で確認してください。"];
  if (/ディズニー|disney|コンシェルジュ|concierge/.test(haystack)) return ["コンシェルジュ/スイート級", "ディズニーのコンシェルジュ/スイート級をクラブルーム級として扱います。対象客室・特典は販売会社で確認してください。"];
  if (/飛鳥|三井|mitsui|にっぽん丸|オーシャニア|リージェント|シルバーシー|seabourn|シーボーン/.test(haystack)) return ["上位スイート級", "日本船・ラグジュアリー船の上位客室をクラブルーム級候補として扱います。対象客室・特典は販売会社で確認してください。"];
  return ["", ""];
}

function familyScoreFor(text, cruiseLine) {
  if (/ディズニー|ロイヤル.?カリビアン|MSC|コスタ/.test(`${text} ${cruiseLine}`)) return "S";
  if (/大型船|ファミリー|プリンセス|ノルウェージャン/.test(`${text} ${cruiseLine}`)) return "A";
  return "B";
}

function regionFor(rawRegion, text) {
  const value = `${rawRegion} ${text}`;
  if (/日本|横浜|東京|神戸|大阪|那覇|博多|鹿児島|清水|長崎/.test(value)) return "日本発着";
  if (/地中海|エーゲ|アドリア|ヨーロッパ|バルセロナ|ローマ|ベニス|アテネ/.test(value)) return "地中海";
  if (/アラスカ|バンクーバー|シアトル/.test(value)) return "アラスカ";
  if (/カリブ|バハマ|フォート.?ローダデール|マイアミ|ポートカナベラル/.test(value)) return "カリブ海";
  if (/アジア|シンガポール|台湾|基隆|香港|釜山|済州|上海/.test(value)) return "アジア";
  if (/ハワイ|ホノルル/.test(value)) return "ハワイ";
  if (/北欧|バルト|フィヨルド|イギリス|英国|アイスランド|グリーンランド|サウサンプトン|コペンハーゲン|ハンブルグ|レイキャビク/.test(value)) return "北欧";
  if (/カナダ|ニューイングランド|ニューヨーク|ボストン|ノーフォーク|ボルチモア/.test(value)) return "北米";
  if (/リバークルーズ|ライン川|ドナウ川|セーヌ川/.test(value)) return "リバークルーズ";
  if (/南極|オセアニア|オーストラリア|ニュージーランド/.test(value)) return "オセアニア";
  return "その他";
}

function portFromText(rawPort, title) {
  const cleaned = String(rawPort || "").replace(/発.*$/, "").replace(/[()（）].*$/, "").trim();
  if (cleaned) return cleaned;
  const match = String(title).match(/-([^-\s]+?)発/);
  return match ? match[1] : "要確認";
}

function shipFromTitle(title, fallback) {
  const match = String(title || "").match(/(.+?)号で行く/);
  if (match) return `${match[1].replace(/^【オンライン予約可】/, "").trim()}号`;
  return fallback || "要確認";
}

function cruiseLineFromParts(parts, ship, fullText) {
  const candidates = parts.slice(3, 9).filter(part =>
    part &&
    part !== ship &&
    !/発[（(]/.test(part) &&
    !/客船/.test(part) &&
    !/地中海|エーゲ|カリブ|アラスカ|日本|アジア|北欧|ハワイ|バハマ|東海岸|西海岸|リバークルーズ/.test(part)
  );
  return candidates.find(part => /クルーズ|ライン|カーニバル|プリンセス|ホーランド|キュナード|MSC|コスタ|ロイヤル|ノルウェージャン|セレブリティ|オーシャニア|リージェント|シルバーシー|ディズニー/.test(part))
    || candidates[0]
    || "要確認";
}

function departurePartFromParts(parts, title) {
  return parts.slice(3).find(part => /発[（(]/.test(part)) || String(title).match(/-([^-\s]+?)発/)?.[1] || "";
}

function regionPartFromParts(parts, title) {
  const candidate = parts.slice(3, 10).find(part =>
    /地中海|エーゲ|カリブ|アラスカ|日本|アジア|北欧|ハワイ|バハマ|東海岸|西海岸|リバークルーズ|オセアニア|イギリス|英国|カナダ|ニューイングランド|アイスランド|グリーンランド/.test(part) &&
    !/発[（(]/.test(part)
  );
  return candidate || String(title).match(/行く\s+(.+?)クルーズ/)?.[1] || "";
}

function priceFromRow(row) {
  for (const key of ["sub_large_image15", "sub_large_image16"]) {
    const value = Number(String(row[key] ?? "").replace(/[^\d]/g, ""));
    if (value > 1) return value;
  }
  for (const key of ["sub_title29", "sub_comment27"]) {
    const value = Number(stripHtml(row[key]).replace(/[^\d]/g, ""));
    if (value > 1) return value;
  }
  return 0;
}

function best1Url(row) {
  const code = row.sub_comment26;
  const brand = String(code || "").split("__")[1]?.split("_")[0] || String(row.sub_large_image21 || "").slice(0, 3) || "B1";
  return `https://www.best1cruise.com/B/${brand}/${code || row.product_id}.html`;
}

function normalizeDedupValue(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[・\s　]/g, "")
    .replace(/号$/g, "")
    .trim();
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

function mapBest1Row(row) {
  const parts = splitComment(row);
  const title = titleWithoutOnlineMark(row.name || parts[0]);
  const nights = durationFromText(parts[2] || row.name) ?? 0;
  const ship = shipFromTitle(row.name || parts[0], parts[4]);
  const cruiseLine = cruiseLineFromParts(parts, ship, `${row.name} ${row.comment3}`);
  const rawPort = departurePartFromParts(parts, row.name) || row.sub_large_image6 || "";
  const rawRegion = regionPartFromParts(parts, row.name);
  const fullText = `${row.name} ${row.comment3}`;
  const [clubRoomLabel, clubRoomNote] = detectClubRoom(cruiseLine, ship, fullText);
  const tags = [
    regionFor(rawRegion, fullText),
    cruiseLine,
    parts[6],
    ...(clubRoomLabel ? ["クラブルーム級"] : [])
  ].filter(Boolean);
  return {
    source: "ベストワンクルーズ",
    sourceProductId: row.product_id,
    title,
    ship,
    cruiseLine,
    region: regionFor(rawRegion, fullText),
    departurePort: portFromText(rawPort, row.name),
    arrivalPort: portFromText(rawPort, row.name),
    departureDate: dateFromBest1(best1DateValue(row)),
    nights,
    itinerary: parts.slice(16, 32).filter(part => !/入港|出港|--:--/.test(part)).slice(0, 8),
    priceFrom: priceFromRow(row),
    currency: "JPY",
    cabinType: clubRoomLabel ? `${clubRoomLabel}候補` : "通常客室目安",
    flightIncluded: /航空券|添乗員|日本発着ではない/.test(fullText),
    escorted: /添乗員/.test(fullText),
    familyScore: familyScoreFor(fullText, cruiseLine),
    luxuryTier: /ラグジュアリー|高級|飛鳥|三井|キュナード|リージェント|シルバーシー|シーボーン/.test(fullText) ? "高級" : "スタンダード",
    status: "API取得",
    tags,
    notes: "ベストワンクルーズの一覧APIから取得。料金・空席・寄港地・客室条件は詳細ページで最終確認。",
    bookingUrl: best1Url(row),
    affiliateUrl: "",
    sourceUrl: best1Url(row),
    lastChecked: today,
    autoUpdatedAt: now,
    sourceReachable: true,
    sourceHttpStatus: 200,
    sourcePageTitle: "ベストワンクルーズ一覧API",
    sourceFinalUrl: best1Url(row),
    updateNote: "自動取得: ベストワンクルーズ一覧APIから取得。価格・空席・日程は予約ページで最終確認。",
    clubRoom: Boolean(clubRoomLabel),
    clubRoomLabel,
    clubRoomNote,
    importedFromApi: "best1"
  };
}

async function fetchBest1Page(page) {
  const url = `https://www.best1cruise.com/products/list.php?mode=json&disp_number=${pageSize}&pageno=${page}`;
  const response = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 (compatible; HTMLTools Cruise Finder local importer)",
      "accept": "application/json,text/html,*/*",
      "referer": "https://www.best1cruise.com/"
    }
  });
  if (!response.ok) throw new Error(`Best1 API returned ${response.status} on page ${page}`);
  const json = await response.json();
  return Object.values(json).filter(value => value && typeof value === "object" && value.product_id);
}

const current = JSON.parse(await fs.readFile(jsonPath, "utf8"));
const affiliateRows = parseCsv(await fs.readFile(affiliatePath, "utf8").catch(() => "source,title,bookingUrl,affiliateUrl,memo\n"));
const existingAffiliateByUrl = new Map(affiliateRows.map(row => [row.bookingUrl, row.affiliateUrl || ""]));
const existingAffiliateByTitle = new Map(affiliateRows.map(row => [row.title, row.affiliateUrl || ""]));

const seen = new Set();
const imported = [];

for (let page = 1; page <= maxPages; page++) {
  const rows = await fetchBest1Page(page);
  let added = 0;
  for (const row of rows) {
    if (seen.has(row.product_id)) continue;
    seen.add(row.product_id);
    const mapped = mapBest1Row(row);
    if (!mapped.departureDate || !mapped.nights || !mapped.bookingUrl || Number(mapped.priceFrom || 0) <= 0) continue;
    mapped.affiliateUrl = existingAffiliateByUrl.get(mapped.bookingUrl) || existingAffiliateByTitle.get(mapped.title) || "";
    imported.push(mapped);
    added++;
  }
  console.log(JSON.stringify({ page, fetched: rows.length, added, total: imported.length }));
  if (rows.length < pageSize || added === 0) break;
  await sleep(900);
}

const nonBest1 = current.filter(row => row.source !== "ベストワンクルーズ" && row.importedFromApi !== "best1");
const merged = dedupeByShipAndDate([...nonBest1, ...imported]).sort((a, b) =>
  String(a.departureDate).localeCompare(String(b.departureDate)) ||
  Number(a.priceFrom || 0) - Number(b.priceFrom || 0) ||
  String(a.title).localeCompare(String(b.title), "ja")
);

await fs.writeFile(jsonPath, JSON.stringify(merged, null, 2), "utf8");
await fs.writeFile(csvPath, toCruiseCsv(merged), "utf8");
await fs.writeFile(affiliatePath, toAffiliateCsv(affiliateRows, merged), "utf8");
await updateHtmlData(merged);

console.log(JSON.stringify({
  importedBest1Rows: imported.length,
  totalRows: merged.length,
  nonBest1Rows: nonBest1.length
}, null, 2));
