/**
 * Fresh load on an iPhone 12 Pro Max viewport: holding the gas pedal
 * must actually drive, on several seeds including a winter spawn.
 *   node test/launch.mjs
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
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

const seeds = [6, 1, 4, 42, 99];
const server = await serve(root);
const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--use-gl=angle", "--use-angle=swiftshader"],
});
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (err) => errors.push(String(err)));

for (const [width, height, label] of [[926, 428, "landscape"], [428, 926, "portrait"]]) {
  await page.setViewport({ width, height, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  for (const seed of seeds) {
    await page.goto(`http://127.0.0.1:${server.address().port}/index.html?seed=${seed}`, { waitUntil: "networkidle0", timeout: 30000 });
    await page.waitForFunction(() => window.__CAR__ && window.__CAR__.ready);
    const laid = await page.evaluate(() => {
      const gas = document.getElementById("gas").getBoundingClientRect();
      const cx = gas.left + gas.width / 2;
      const cy = gas.top + gas.height / 2;
      const hit = document.elementFromPoint(cx, cy);
      const menu = document.getElementById("worldmenu");
      const wheels = getComputedStyle(document.getElementById("wheels"));
      const r = window.__CAR__.report();
      return {
        hit: hit && hit.id,
        menuOpen: menu.classList.contains("open"),
        seedInMenu: (document.getElementById("seedline").textContent || "").includes("СИД"),
        wheels: wheels.display,
        surf: r.wheels[0].surface,
        contact: r.wheels.filter((w) => w.inContact).length,
        nan: !Number.isFinite(r.pos.x + r.pos.y + r.speed),
        biome: window.__CAR__.biomeAt(r.pos.z),
      };
    });
    check(`${label} seed ${seed} gas is the pedal`, laid.hit === "gas", laid.hit);
    check(`${label} seed ${seed} seed stays in the menu`, laid.seedInMenu && !laid.menuOpen, `open ${laid.menuOpen}`);
    check(`${label} seed ${seed} telemetry hidden`, laid.wheels === "none", laid.wheels);
    check(`${label} seed ${seed} spawn planted`, laid.contact === 4 && laid.surf === "asphalt" && !laid.nan, `${laid.surf} contact ${laid.contact}`);
    const box = await (await page.$("#gas")).boundingBox();
    await page.touchscreen.touchStart(box.x + box.width / 2, box.y + box.height / 2);
    await new Promise((r) => setTimeout(r, 5000));
    const moved = await page.evaluate(() => {
      const r = window.__CAR__.report();
      return { kmh: r.speed * 3.6, t: r.time, nan: !Number.isFinite(r.speed + r.pos.z) };
    });
    await page.touchscreen.touchEnd();
    check(`${label} seed ${seed} gas 5s exceeds 20 km/h`, moved.kmh > 20 && !moved.nan, `${moved.kmh.toFixed(1)} km/h after ${moved.t.toFixed(1)}s sim (${laid.biome})`);
  }
}
check("no page errors", errors.length === 0, errors[0] || "");

await browser.close();
server.close();
if (failures.length) {
  console.log(`\n${failures.length} failed`);
  process.exit(1);
}
console.log("\nlaunch checks passed");
