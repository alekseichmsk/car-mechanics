/**
 * The road keeps generating for 2 km and the scene stays bounded.
 *   node test/endless.mjs
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
const errors = [];
page.on("pageerror", (err) => errors.push(String(err)));
await page.goto(`http://127.0.0.1:${server.address().port}/index.html?manual=1`, { waitUntil: "networkidle0", timeout: 30000 });

page.setDefaultTimeout(120000);
await page.evaluate(() => {
  const car = window.__CAR__;
  car.setDrive("AWD");
  car.setScene({ engineOn: true, fuel: 1, rain: false, lights: 0 });
  car.reset({ x: 0, z: 4, speed: 10, yaw: 0 });
  car.__end = { dist: 0, road: 0, maxZ: 4, last: car.report().pos, max: car.countObjects(), start: car.countObjects(), marks: [], stuck: 0, rut: 0, realign: 0 };
});

let result = null;
for (let step = 0; step < 160; step++) {
  result = await page.evaluate(() => {
    const car = window.__CAR__;
    const bag = car.__end;
    for (let n = 0; n < 8 && bag.road < 2100; n++) {
      const pre = car.report();
      const aim = car.roadHeading(pre.pos.z);
      const have = Math.atan2(pre.fwd.x, pre.fwd.z);
      let err = aim - have;
      while (err > Math.PI) err -= Math.PI * 2;
      while (err < -Math.PI) err += Math.PI * 2;
      const lat = pre.pos.x - car.roadX(pre.pos.z);
      const off = Math.abs(lat);
      if (off > 11 || Math.abs(err) > 1.15) {
        const z = Math.max(pre.pos.z, bag.maxZ);
        car.reset({ x: car.roadX(z), z, speed: 12, yaw: car.roadHeading(z) });
        bag.realign++;
        bag.last = { x: car.roadX(z), z };
        continue;
      }
      car.setInput({ throttle: 0.85, brake: 0, steer: Math.max(-0.8, Math.min(0.8, err * 1.7 + lat * 0.2)) });
      const r = car.runSeconds(0.35);
      const hop = Math.hypot(r.pos.x - bag.last.x, r.pos.z - bag.last.z);
      bag.dist += hop;
      if (r.pos.z > bag.maxZ) {
        bag.road += r.pos.z - bag.maxZ;
        bag.maxZ = r.pos.z;
      }
      bag.last = { x: r.pos.x, z: r.pos.z };
      if (hop < 0.15) bag.stuck++;
      const count = car.countObjects();
      if (count > bag.max) bag.max = count;
      if (r.wheels.some((w) => w.surface === "sand" || w.surface === "mud" || w.surface === "drift")) {
        bag.rut = Math.max(bag.rut || 0, car.rutDepthAt(r.pos.x, r.pos.z));
      }
      if (bag.marks.length === 0 || bag.road - bag.marks[bag.marks.length - 1].road > 350) {
        bag.marks.push({ road: Math.round(bag.road), z: Math.round(r.pos.z), count, surf: r.wheels[0].surface, kmh: Math.round(r.speed * 3.6) });
      }
      if (!Number.isFinite(r.pos.z) || r.blewUp) bag.dist = 99999;
    }
    return {
      dist: Math.round(bag.dist), road: Math.round(bag.road), maxCount: bag.max, startCount: bag.start,
      endCount: car.countObjects(), marks: bag.marks, blew: car.report().blewUp, stuck: bag.stuck, rut: bag.rut, realign: bag.realign,
      z: Math.round(car.report().pos.z),
    };
  });
  if (result.road >= 2000 || result.blew) break;
}
console.log("progress z", result.z, "road", result.road, "dist", result.dist, "stuckSteps", result.stuck);

console.log(JSON.stringify(result, null, 2));
check("drove at least 2 km", result.road >= 2000, `${result.road} m along the road`);
check("no page errors", errors.length === 0, errors[0] || "");
check("car stayed finite", !result.blew, "");
check("scene count stayed bounded", result.endCount <= result.startCount + 80 && result.maxCount <= result.startCount + 120, `start ${result.startCount} max ${result.maxCount} end ${result.endCount}`);
check("soft chunks kept ruts", result.rut > 0.004, `rut ${result.rut}`);
check("stayed on the road", result.realign < 25, `${result.realign} realigns`);

await browser.close();
server.close();
if (failures.length) {
  console.log(`\n${failures.length} failed`);
  process.exit(1);
}
console.log("\nendless road checks passed");
