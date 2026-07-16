const path = require("path");
const {
  collectKdocsSource,
  loadConfig
} = require("../automation-server");

async function main() {
  const reason = process.argv[2] || "timer";
  const config = loadConfig();
  const collections = [];

  for (const source of config.kdocsSources || []) {
    const result = collectKdocsSource(source.id);
    const imagePaths = result?.session?.latestImagePaths || [];
    collections.push({
      id: source.id,
      imported: Number(result?.imported?.imported || 0),
      evidencePath: toPublicPath(imagePaths[0] || ""),
      cloudSync: result?.cloudSync || null
    });
  }

  const firstEvidence = collections.find((item) => item.evidencePath)?.evidencePath || "";
  process.stdout.write(JSON.stringify({
    ok: true,
    reason,
    finishedAt: new Date().toISOString(),
    imported: collections.reduce((total, item) => total + item.imported, 0),
    addedLeads: 0,
    evidencePath: firstEvidence,
    cloudSync: collections.find((item) => item.cloudSync)?.cloudSync || null,
    collections
  }));
}

function toPublicPath(imagePath) {
  if (!imagePath) return "";
  const root = path.resolve(__dirname, "..");
  const absolutePath = path.resolve(imagePath);
  if (!absolutePath.startsWith(root)) return "";
  return `/${path.relative(root, absolutePath).replace(/\\/g, "/")}`;
}

main().catch((error) => {
  process.stdout.write(JSON.stringify({ ok: false, error: error.message }));
  process.exitCode = 1;
});
