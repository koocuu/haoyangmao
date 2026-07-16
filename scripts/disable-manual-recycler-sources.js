const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const statePath = path.join(root, "data", "state.json");
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
const disabledNames = new Set(["小鸽", "踏浪"]);
const disabledQuotes = state.quotes.filter((quote) => disabledNames.has(String(quote.sourceName || "").trim()));
const activeQuotes = state.quotes.filter((quote) => !disabledNames.has(String(quote.sourceName || "").trim()));

if (disabledQuotes.length) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const archivePath = path.join(root, "data", `disabled-manual-sources-${stamp}.json`);
  fs.writeFileSync(archivePath, `${JSON.stringify({ archivedAt: new Date().toISOString(), quotes: disabledQuotes }, null, 2)}\n`, "utf8");
  state.quotes = activeQuotes;
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  process.stdout.write(JSON.stringify({ removed: disabledQuotes.length, remaining: activeQuotes.length, archivePath }));
} else {
  process.stdout.write(JSON.stringify({ removed: 0, remaining: activeQuotes.length, archivePath: "" }));
}
