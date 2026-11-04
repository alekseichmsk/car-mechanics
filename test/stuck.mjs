/**
 * Full throttle should not sit still on mud, water, or grass, and the
 * recovery button puts a stuck car back on the road.
 *   node test/stuck.mjs
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

const server = await serve(root);
const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--use-gl=angle", "--use-angle=swiftshader"],
  protocolTimeout: 180000,
});
const page = await browser.newPage();
page.setDefaultTimeout(120000);
const errors = [];
page.on("pageerror", (err) => errors.push(String(err)));
await page.goto(`http://127.0.0.1:${server.address().port}/index.html?manual=1`, { waitUntil: "networkidle0", timeout: 30000 });
await page.waitForFunction(() => window.__CAR__ && window.__CAR__.ready);

const rows = await page.evaluate(() => {
  const car = window.__CAR__;
  const seeds = [6, 1, 42, 11];
  const modes = ["AWD", "RWD"];
  const out = [];
  function spot(seed, kind) {
    car.setSeed(seed, { force: true, rebuild: false });
    car.setWeather("auto");
    for (let z = 110; z < 2400; z += 20) {
      const water = car.waterDepth(car.roadX(z), z);
      const surf = car.surfaceAt(car.roadX(z), z);
      const hit = kind === "water" ? water > 0.08 : surf === kind;
      if (hit) return z + 10;
    }
    return 0;
  }
  function run(seed, kind, mode, z) {
    car.setDrive(mode);
    car.setScene({ engineOn: true, fuel: 1, coolant: 0.34 });
    car.clearRuts();
    car.reset({ x: car.roadX(z), z, speed: 0, yaw: car.roadHeading(z) });
    let slow = 0;
    let maxK = 0;
    for (let t = 0; t < 5; t += 0.25) {
      const pre = car.report();
      const aim = car.roadHeading(pre.pos.z);
      const have = Math.atan2(pre.fwd.x, pre.fwd.z);
      let err = aim - have;
      while (err > Math.PI) err -= Math.PI * 2;
      while (err < -Math.PI) err += Math.PI * 2;
      const lat = pre.pos.x - car.roadX(pre.pos.z);
      car.setInput({ throttle: 1, brake: 0, steer: Math.max(-0.8, Math.min(0.8, err * 1.5 + lat * 0.2)) });
      const r = car.runSeconds(0.25);
      const kmh = r.speed * 3.6;
      if (kmh > maxK) maxK = kmh;
      if (kmh < 2) slow += 0.25;
      else slow = 0;
    }
    const end = car.report();
    return { seed, kind, mode, slow: +slow.toFixed(2), maxK: +maxK.toFixed(1), kmh: +(end.speed * 3.6).toFixed(1), surf: end.wheels[0].surface };
  }
  for (const seed of seeds) {
    for (const kind of ["water", "mud", "grass", "sand"]) {
      const z = spot(seed, kind);
      if (!z) continue;
      for (const mode of modes) out.push(run(seed, kind, mode, z));
    }
  }
  car.setScene({ engineOn: false, fuel: 1 });
  car.setInput({ throttle: 1, brake: 0, steer: 0 });
  car.reset({ x: 0, z: 4, speed: 0, yaw: 0 });
  car.runSeconds(5.3);
  const shown = document.getElementById("unstick").classList.contains("show");
  const before = car.report().pos.z;
  car.recoverCar();
  const after = car.report();
  return { out, shown, before, afterZ: after.pos.z, afterX: after.pos.x, roadX: car.roadX(after.pos.z), kmh: after.speed * 3.6 };
});

for (const r of rows.out) {
  check(`${r.mode} seed ${r.seed} ${r.kind} does not sit still`, r.slow < 3 && r.maxK > 2, `slow ${r.slow}s max ${r.maxK} end ${r.kmh} ${r.surf}`);
}
check("unstick appears after 5s stuck", rows.shown, "");
check("unstick moves the car ahead", rows.afterZ > rows.before + 6, `${rows.before.toFixed(1)} -> ${rows.afterZ.toFixed(1)}`);
check("recovered car is on the road center", Math.abs(rows.afterX - rows.roadX) < 1.5, `x ${rows.afterX.toFixed(2)} road ${rows.roadX.toFixed(2)}`);
check("no page errors", errors.length === 0, errors[0] || "");

await browser.close();
server.close();
if (failures.length) {
  console.log(`\n${failures.length} failed`);
  process.exit(1);
}
console.log("\nstuck checks passed");
