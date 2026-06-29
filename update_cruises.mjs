import fs from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname);
const jsonPath = path.join(root, "cruises.json");
const csvPath = path.join(root, "cruises.csv");
const htmlPath = path.join(root, "index.html");

const today = new Date().toISOString().slice(0, 10);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function decodeHtml(text) {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function extractTitle(html) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) return "";
  return decodeHtml(match[1].replace(/\s+/g, " ").trim()).slice(0, 160);
}

async function fetchSnapshot(url) {
  const started = Date.now();
  try {
    const response = await fetch(url, {
      redirect: "follow",
      headers: {
        "user-agent": "HTMLTools Cruise Finder updater/1.0 (+local user scheduled check)",
        "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      }
    });
    const text = await response.text();
    return {
      reachable: response.ok,
      httpStatus: response.status,
      finalUrl: response.url,
      pageTitle: extractTitle(text),
      checkedAt: today,
      elapsedMs: Date.now() - started
    };
  } catch (error) {
    return {
      reachable: false,
      httpStatus: null,
      finalUrl: url,
      pageTitle: "",
      checkedAt: today,
      elapsedMs: Date.now() - started,
      error: error.message
    };
  }
}

function csvEscape(value) {
  const text = Array.isArray(value) ? value.join(" / ") : String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function toCsv(rows) {
  const headers = [
    "source", "title", "ship", "cruiseLine", "region", "departurePort", "arrivalPort",
    "departureDate", "nights", "itinerary", "priceFrom", "currency", "cabinType",
    "flightIncluded", "escorted", "familyScore", "luxuryTier", "status", "tags",
    "notes", "bookingUrl", "sourceUrl", "lastChecked", "autoUpdatedAt",
    "sourceReachable", "sourceHttpStatus", "sourcePageTitle", "sourceFinalUrl",
    "updateNote"
  ];
  return [headers.join(","), ...rows.map(row => headers.map(h => csvEscape(row[h])).join(","))].join("\n");
}

async function updateHtmlData(rows) {
  const html = await fs.readFile(htmlPath, "utf8");
  const replacement = `let DATA = ${JSON.stringify(rows).replaceAll("</script", "<\\/script")};\n    const $ =`;
  const updated = html.replace(/let DATA = .*?;\n    const \$ =/s, replacement);
  if (updated === html) {
    throw new Error("Could not replace embedded DATA in index.html");
  }
  await fs.writeFile(htmlPath, updated, "utf8");
}

const cruises = JSON.parse(await fs.readFile(jsonPath, "utf8"));
const uniqueUrls = [...new Set(cruises.flatMap(row => [row.sourceUrl, row.bookingUrl]).filter(Boolean))];
const snapshots = new Map();

for (const url of uniqueUrls) {
  snapshots.set(url, await fetchSnapshot(url));
  await sleep(900);
}

const updatedCruises = cruises.map(row => {
  const sourceSnapshot = snapshots.get(row.sourceUrl) ?? snapshots.get(row.bookingUrl);
  const bookingSnapshot = snapshots.get(row.bookingUrl) ?? sourceSnapshot;
  const reachable = Boolean(sourceSnapshot?.reachable || bookingSnapshot?.reachable);
  return {
    ...row,
    lastChecked: today,
    autoUpdatedAt: new Date().toISOString(),
    sourceReachable: reachable,
    sourceHttpStatus: sourceSnapshot?.httpStatus ?? bookingSnapshot?.httpStatus ?? null,
    sourcePageTitle: sourceSnapshot?.pageTitle || bookingSnapshot?.pageTitle || "",
    sourceFinalUrl: sourceSnapshot?.finalUrl || bookingSnapshot?.finalUrl || row.sourceUrl || row.bookingUrl,
    updateNote: reachable
      ? "自動更新: 参照ページ到達確認済み。価格・空席・日程は予約ページで最終確認。"
      : "自動更新: 参照ページに到達できませんでした。URLまたは販売状況を確認。"
  };
});

await fs.writeFile(jsonPath, JSON.stringify(updatedCruises, null, 2), "utf8");
await fs.writeFile(csvPath, toCsv(updatedCruises), "utf8");
await updateHtmlData(updatedCruises);

const ok = updatedCruises.filter(row => row.sourceReachable).length;
console.log(JSON.stringify({
  checkedAt: today,
  rows: updatedCruises.length,
  reachableRows: ok,
  unreachableRows: updatedCruises.length - ok,
  uniqueUrls: uniqueUrls.length
}, null, 2));
