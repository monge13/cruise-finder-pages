import fs from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname);
const jsonPath = path.join(root, "cruises.json");
const csvPath = path.join(root, "cruises.csv");
const htmlPath = path.join(root, "index.html");
const affiliatePath = path.join(root, "affiliate_links.csv");

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

async function updateHtmlData(rows) {
  const html = await fs.readFile(htmlPath, "utf8");
  const pattern = /let DATA = .*?;\n    (?:let renderLimit = 200;\n    )?const \$ =/s;
  if (!pattern.test(html)) {
    throw new Error("Could not find embedded DATA in index.html");
  }
  const replacement = `let DATA = ${JSON.stringify(rows).replaceAll("</script", "<\\/script")};\n    let renderLimit = 200;\n    const $ =`;
  const updated = html.replace(pattern, replacement);
  await fs.writeFile(htmlPath, updated, "utf8");
}

const cruises = JSON.parse(await fs.readFile(jsonPath, "utf8"));
const affiliateRows = parseCsv(await fs.readFile(affiliatePath, "utf8"));
const byTitle = new Map(affiliateRows.map(row => [row.title, row]));
const byBookingUrl = new Map(affiliateRows.map(row => [row.bookingUrl, row]));

let applied = 0;
const updatedCruises = cruises.map(row => {
  const affiliateRow = byTitle.get(row.title) ?? byBookingUrl.get(row.bookingUrl);
  const affiliateUrl = affiliateRow?.affiliateUrl?.trim() ?? "";
  if (affiliateUrl) applied++;
  return {
    ...row,
    affiliateUrl
  };
});

await fs.writeFile(jsonPath, JSON.stringify(updatedCruises, null, 2), "utf8");
await fs.writeFile(csvPath, toCsv(updatedCruises), "utf8");
await updateHtmlData(updatedCruises);

console.log(JSON.stringify({
  rows: updatedCruises.length,
  appliedAffiliateLinks: applied
}, null, 2));
