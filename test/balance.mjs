/**
 * Surface balance. Prints a table and fails if a surface traps the car.
 *   node test/balance.mjs
 */
import http from "http";
import fs from "fs";
import path from "path";
import puppeteer from "puppeteer-core";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const chrome = process.env.CHROME_PATH
  || ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable"].find((p) => fs.existsSync(p));
if (!chrome) throw new Error("Chrome not found");

function serve(dir) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      const file = path.join(dir, decodeURIComponent(url.pathname));
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
});
const page = await browser.newPage();
page.on("pageerror", (err) => console.log("PAGEERROR", String(err)));
await page.goto(`http://127.0.0.1:${server.address().port}/index.html?manual=1`, { waitUntil: "networkidle0", timeout: 30000 });

page.setDefaultTimeout(120000);
await page.evaluate(() => {
  window.__balanceOne = (kind, mode) => {
    const car = window.__CAR__;
    const spot = car.roadSpot(kind);
    const lane = spot.lane || 0;
    const z0 = spot.z + (mode === "RWD" ? 8 : 0);
    function place(z, speed) {
      car.reset({
        x: car.roadX(z) + lane,
        z,
        speed,
        yaw: car.roadHeading(z),
      });
    }
    function follow(throttle, brake, steerBias) {
      const pre = car.report();
      const aim = car.roadHeading(pre.pos.z);
      const have = Math.atan2(pre.fwd.x, pre.fwd.z);
      let err = aim - have;
      while (err > Math.PI) err -= Math.PI * 2;
      while (err < -Math.PI) err += Math.PI * 2;
      const lat = pre.pos.x - (car.roadX(pre.pos.z) + lane);
      const steer = Math.max(-0.85, Math.min(0.85, err * 1.7 + lat * 0.22 + (steerBias || 0)));
      car.setInput({ throttle, brake, steer });
    }
    car.clearRuts();
    car.setDrive(mode);
    car.setScene({ timeOfDay: 0.5, rain: false, lights: 0, engineOn: true, fuel: 1, coolant: 0.34 });
    place(z0, 0);
    const want = kind === "rocks" ? "gravel" : kind;
    const onIt = (r) => r.wheels.filter((w) => w.surface === want || (kind === "water" && w.surface === "water")).length >= 3;
    let dist = 0;
    let last = car.report().pos;
    let maxKmh = 0;
    let t50 = null;
    let t = 0;
    let rut = 0;
    while (t < 16) {
      follow(1, 0, 0);
      const r = car.runSeconds(0.25);
      t += 0.25;
      if (Math.abs(r.pos.z - z0) > 48) {
        place(z0, r.speed);
        last = car.report().pos;
        continue;
      }
      const here = onIt(r);
      if (here) {
        dist += Math.hypot(r.pos.x - last.x, r.pos.z - last.z);
        const kmh = r.speed * 3.6;
        if (kmh > maxKmh) maxKmh = kmh;
        if (t50 == null && kmh >= 50) t50 = t;
        last = r.pos;
        if (kind === "sand" || kind === "mud" || kind === "drift") {
          rut = Math.max(rut, car.rutDepthAt(r.pos.x, r.pos.z));
        }
      } else last = r.pos;
    }
    car.clearRuts();
    place(z0, 40 / 3.6);
    car.setInput({ throttle: 0, brake: 1, steer: 0 });
    let bdist = 0;
    let bprev = car.report().pos;
    let bt = 0;
    const b0 = car.report().speed * 3.6;
    while (bt < 14) {
      const r = car.runSeconds(0.1);
      bt += 0.1;
      bdist += Math.hypot(r.pos.x - bprev.x, r.pos.z - bprev.z);
      bprev = r.pos;
      if (r.speed < 0.45) break;
    }
    car.clearRuts();
    const cornerSpeed = Math.min(30 / 3.6, Math.max(4, maxKmh / 3.6 * 0.75));
    place(z0, cornerSpeed);
    const h0 = Math.atan2(car.report().fwd.x, car.report().fwd.z);
    car.setInput({ throttle: 0.35, brake: 0, steer: 0.55 });
    car.runSeconds(1.6);
    const h1 = Math.atan2(car.report().fwd.x, car.report().fwd.z);
    let turn = h1 - h0;
    while (turn > Math.PI) turn -= Math.PI * 2;
    while (turn < -Math.PI) turn += Math.PI * 2;
    return {
      kind, mode,
      dist: +dist.toFixed(1),
      maxKmh: +maxKmh.toFixed(1),
      t50: t50 == null ? null : +t50.toFixed(1),
      brakeFrom: +b0.toFixed(1),
      brakeM: +bdist.toFixed(1),
      turnDeg: +((turn * 180) / Math.PI).toFixed(0),
      rut: +rut.toFixed(3),
    };
  };
});

const kinds = ["asphalt", "dirt", "grass", "rocks", "sand", "mud", "drift", "pack", "ice", "water"];
const table = [];
for (const kind of kinds) {
  for (const mode of ["AWD", "RWD"]) {
    const row = await page.evaluate((k, m) => window.__balanceOne(k, m), kind, mode);
    table.push(row);
    console.log("row", kind, mode, row.maxKmh, "km/h", row.dist, "m");
  }
}

console.log("surface   drive  0-50s  topKmh  dist14s  brakeFrom  brakeM  turnDeg");
const failures = [];
for (const r of table) {
  console.log(
    `${r.kind.padEnd(9)} ${r.mode.padEnd(5)} ${String(r.t50 ?? "—").padStart(6)} ${String(r.maxKmh).padStart(7)} ${String(r.dist).padStart(8)} ${String(r.brakeFrom).padStart(10)} ${String(r.brakeM).padStart(7)} ${String(r.turnDeg).padStart(8)}`,
  );
  const minDist = r.kind === "water" ? 8 : r.kind === "ice" ? 6 : 12;
  if (r.mode === "AWD" && r.dist < minDist) failures.push(`${r.kind} 4x4 only ${r.dist} m`);
  const rwdMin = r.kind === "water" || r.kind === "ice" ? 4 : 8;
  if ((r.kind === "sand" || r.kind === "mud" || r.kind === "drift") && r.mode === "AWD" && r.rut < 0.004) {
    failures.push(`${r.kind} left no rut (${r.rut})`);
  }
  if (r.mode === "RWD" && r.dist < rwdMin) failures.push(`${r.kind} RWD only ${r.dist} m`);
}
const awd = Object.fromEntries(table.filter((r) => r.mode === "AWD").map((r) => [r.kind, r]));
if (awd.asphalt.t50 == null || awd.asphalt.t50 > 9) failures.push(`asphalt 0-50 was ${awd.asphalt.t50}`);
if (awd.asphalt.maxKmh < awd.drift.maxKmh) failures.push("asphalt slower than deep snow");
if (awd.ice.brakeM < awd.drift.brakeM) failures.push("ice stopped shorter than deep snow");

await browser.close();
server.close();
if (failures.length) {
  console.log("\n" + failures.join("\n"));
  process.exit(1);
}
console.log("\n" + JSON.stringify(table));
console.log("\nbalance checks passed");
