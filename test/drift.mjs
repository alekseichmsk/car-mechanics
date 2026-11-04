/**
 * Deep-snow (СУГРОБ) progress and braking.
 *   node test/drift.mjs
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
      const url = new URL(req.url, "http://127.0.0.1");
      const file = path.join(dir, decodeURIComponent(url.pathname));
      if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404);
        res.end("no");
        return;
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

const result = await page.evaluate(() => {
  const car = window.__CAR__;
  function drive(mode) {
    car.clearRuts();
    car.setDrive(mode);
    car.setScene({ timeOfDay: 0.48, rain: false, lights: 0, engineOn: true, fuel: 1, wear: 0 });
    car.clearInput();
    const spot = car.roadSpot("drift");
    const z0 = mode === "AWD" ? spot.z : spot.z + 18;
    car.reset({ x: car.roadX(z0), z: z0, speed: 0, yaw: car.roadHeading(z0) });
    car.setInput({ throttle: 1, brake: 0, steer: 0 });
    let dist = 0;
    let last = car.report().pos;
    let maxKmh = 0;
    let minContact = 4;
    const samples = [];
    for (let t = 0; t < 10; t += 0.25) {
      const pre = car.report();
      const aim = car.roadHeading(pre.pos.z);
      const have = Math.atan2(pre.fwd.x, pre.fwd.z);
      let err = aim - have;
      while (err > Math.PI) err -= Math.PI * 2;
      while (err < -Math.PI) err += Math.PI * 2;
      const lat = pre.pos.x - car.roadX(pre.pos.z);
      car.setInput({ throttle: 1, brake: 0, steer: Math.max(-0.8, Math.min(0.8, err * 1.8 + lat * 0.25)) });
      const r = car.runSeconds(0.25);
      dist += Math.hypot(r.pos.x - last.x, r.pos.z - last.z);
      last = r.pos;
      const kmh = r.speed * 3.6;
      const onDrift = r.wheels.every((w) => w.surface === "drift");
      if (onDrift && kmh > maxKmh) maxKmh = kmh;
      const contact = r.wheels.filter((w) => w.inContact).length;
      if (onDrift && contact < minContact) minContact = contact;
      if (Math.round(t * 4) % 8 === 0) samples.push({ t: +t.toFixed(1), kmh: +kmh.toFixed(1), z: +r.pos.z.toFixed(1), sink: +Math.max(...r.wheels.map((w) => w.sinkDepth)).toFixed(2) });
    }
    const end = car.report();
    return {
      mode,
      dist: +dist.toFixed(1),
      maxKmh: +maxKmh.toFixed(1),
      endKmh: +(end.speed * 3.6).toFixed(1),
      z: +end.pos.z.toFixed(1),
      surf: end.wheels[0].surface,
      minContact,
      sink: +Math.max(...end.wheels.map((w) => w.sinkDepth)).toFixed(2),
      samples,
    };
  }
  function brake() {
    car.clearRuts();
    car.setDrive("AWD");
    car.setScene({ timeOfDay: 0.48, rain: false, engineOn: true, fuel: 1 });
    car.clearInput();
    const spot = car.roadSpot("drift");
    const z0 = spot.z + 40;
    car.reset({ x: car.roadX(z0), z: z0, speed: 40 / 3.6, yaw: car.roadHeading(z0) });
    car.setInput({ throttle: 0, brake: 1, steer: 0 });
    const start = car.report().pos;
    let dist = 0;
    let last = start;
    let guard = 0;
    let sink = 0;
    while (guard < 8) {
      const r = car.runSeconds(0.1);
      dist += Math.hypot(r.pos.x - last.x, r.pos.z - last.z);
      last = r.pos;
      sink = Math.max(sink, ...r.wheels.map((w) => w.sinkDepth));
      guard += 0.1;
      if (r.speed < 0.4) break;
    }
    return { meters: +dist.toFixed(2), seconds: +guard.toFixed(2), sink: +sink.toFixed(2), kmh: +(car.report().speed * 3.6).toFixed(1) };
  }
  const awd = drive("AWD");
  const rwd = drive("RWD");
  const stop = brake();
  return { awd, rwd, stop };
});

console.log(JSON.stringify(result, null, 2));
check("4x4 reaches 15-25 km/h", result.awd.maxKmh >= 15 && result.awd.maxKmh <= 26, `${result.awd.maxKmh} km/h`);
check("4x4 keeps moving through the drift", result.awd.endKmh >= 12, `${result.awd.endKmh} km/h, ${result.awd.dist} m`);
check("4x4 covers the drift", result.awd.dist >= 50, `${result.awd.dist} m, z=${result.awd.z}`);
check("4x4 keeps wheels planted", result.awd.minContact >= 3, `min contact ${result.awd.minContact}`);
check("RWD is slower than 4x4", result.rwd.maxKmh < result.awd.maxKmh - 2 && result.rwd.dist < result.awd.dist, `RWD ${result.rwd.maxKmh} km/h, ${result.rwd.dist} m`);
check("RWD is not stuck", result.rwd.dist >= 12 && result.rwd.maxKmh >= 5, `RWD ${result.rwd.maxKmh} km/h, ${result.rwd.dist} m`);
check("brake from 40 km/h stops in 4-8 m", result.stop.meters >= 4 && result.stop.meters <= 8, `${result.stop.meters} m in ${result.stop.seconds}s, sink ${result.stop.sink}`);

await browser.close();
server.close();
if (failures.length) {
  console.log(`\n${failures.length} failed`);
  process.exit(1);
}
console.log("\ndrift checks passed");
