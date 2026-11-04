/**
 * Many seeds stay inside the drivable road limits and do not repeat each other.
 *   node test/seeds.mjs
 */
import http from "http";
import fs from "fs";
import path from "path";
import puppeteer from "puppeteer-core";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const chrome = process.env.CHROME_PATH
  || ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable"].find((p) => fs.existsSync(p));
if (!chrome) throw new Error("Chrome not found");

const failures = [];
function check(name, ok, detail) {
  const line = `${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`;
  console.log(line);
  if (!ok) failures.push(line);
}

function serve(dir) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const file = path.join(dir, decodeURIComponent(new URL(req.url, "http://127.0.0.1").pathname));
      if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404); res.end("no"); return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

const server = await serve(root);
const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--use-gl=angle", "--use-angle=swiftshader"],
});
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (err) => errors.push(String(err)));
await page.goto(`http://127.0.0.1:${server.address().port}/index.html?manual=1`, { waitUntil: "networkidle0", timeout: 30000 });
page.setDefaultTimeout(120000);

const rows = await page.evaluate(() => {
  const out = [];
  for (let i = 0; i < 24; i++) out.push(window.__CAR__.auditSeed(1009 + i * 7919));
  return out;
});

check("no page errors", errors.length === 0, errors[0] || "");
const xs = new Set();
let curved = 0;
let variedBiomes = 0;
for (const r of rows) {
  xs.add(Math.round(r.xAt900 * 10) / 10);
  if (r.xSpread > 4) curved++;
  if (r.biomes.length >= 2) variedBiomes++;
  check(`${r.seed} heading`, r.maxAbsHeading <= 0.4, r.maxAbsHeading.toFixed(3));
  check(`${r.seed} slope`, r.maxAbsSlope <= 0.055, r.maxAbsSlope.toFixed(3));
  check(`${r.seed} water`, r.maxWater <= 0.4, r.maxWater.toFixed(3));
  check(`${r.seed} drift center`, r.maxDriftCenter <= 0.02, r.maxDriftCenter.toFixed(3));
  check(`${r.seed} drift side`, r.maxDriftSide <= 0.46, r.maxDriftSide.toFixed(3));
  check(`${r.seed} lane rocks`, r.maxLaneRock <= 0.05, r.maxLaneRock.toFixed(3));
  check(`${r.seed} dunes`, r.maxSand <= 0.22, r.maxSand.toFixed(3));
}
check("seeds do not share one road", xs.size >= 18, `${xs.size} distinct`);
check("most seeds meander", curved >= 18, `${curved}/24`);
check("auto biomes change along the road", variedBiomes >= 18, `${variedBiomes}/24`);

await browser.close();
server.close();
if (failures.length) {
  console.log(`\n${failures.length} failed`);
  process.exit(1);
}
console.log("\nseed checks passed");
