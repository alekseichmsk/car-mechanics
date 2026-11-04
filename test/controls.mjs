/**
 * iPhone 12 Pro Max checks for the hotfix:
 * - canvas CSS size, renderer size, and camera aspect stay locked together
 *   across a portrait → landscape change
 * - right input (keyboard, touch button, clockwise wheel) turns the car right
 *   on the chase camera, rotates the wheel clockwise, and points the front wheels right
 * - gas is the right-hand pedal and accelerates; brake slows the car
 *
 *   node test/controls.mjs
 * Requires puppeteer-core on NODE_PATH and Chrome (CHROME_PATH optional).
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

function assertAspect(m, w, h, label) {
  const aspect = w / h;
  check(`${label} css size`, Math.abs(m.cssW - w) <= 2 && Math.abs(m.cssH - h) <= 2, `${m.cssW}x${m.cssH}`);
  check(`${label} style matches renderer`, m.styleW === m.rendererW && m.styleH === m.rendererH, `${m.styleW}x${m.styleH} vs ${m.rendererW}x${m.rendererH}`);
  check(`${label} camera aspect`, Math.abs(m.aspect - aspect) < 0.01, `aspect ${m.aspect.toFixed(4)} want ${aspect.toFixed(4)}`);
  const bufAspect = m.bufW / m.bufH;
  check(`${label} buffer aspect`, Math.abs(bufAspect - aspect) < 0.02, `buffer ${m.bufW}x${m.bufH}`);
  check(`${label} pixel ratio cap`, m.pr === 2, `pr ${m.pr}`);
  check(`${label} buffer is css * pr`, Math.abs(m.bufW - Math.floor(m.rendererW * m.pr)) <= 1 && Math.abs(m.bufH - Math.floor(m.rendererH * m.pr)) <= 1, "");
}

const server = await serve(root);
const port = server.address().port;
const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--use-gl=angle", "--use-angle=swiftshader"],
});
const page = await browser.newPage();
page.on("pageerror", (err) => console.log("PAGEERROR", String(err)));
page.on("console", (msg) => {
  if (msg.type() === "error") console.log("CONSOLE", msg.text());
});

async function boot(width, height) {
  await page.setViewport({ width, height, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  await page.goto(`http://127.0.0.1:${port}/index.html?manual=1`, { waitUntil: "networkidle0", timeout: 30000 });
  await page.waitForFunction(() => window.__CAR__ && window.__CAR__.ready, { timeout: 20000 });
  const err = await page.$eval("#err", (el) => el.textContent);
  if (err) throw new Error(err);
}

function release() {
  return page.evaluate(() => {
    window.__CAR__.clearInput();
    for (const code of ["KeyA", "KeyD", "KeyW", "KeyS", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Space"]) {
      window.dispatchEvent(new KeyboardEvent("keyup", { code, bubbles: true }));
    }
    for (const id of ["steerL", "steerR", "gas", "brake", "handbrake", "wheel"]) {
      document.getElementById(id).dispatchEvent(new PointerEvent("pointerup", {
        bubbles: true, pointerId: 1, pointerType: "touch", isPrimary: true,
      }));
      document.getElementById(id).dispatchEvent(new PointerEvent("pointerup", {
        bubbles: true, pointerId: 2, pointerType: "touch", isPrimary: true,
      }));
    }
  });
}

async function straight() {
  await release();
  return page.evaluate(() => {
    window.__CAR__.reset({ x: 0, z: -32, speed: 14 });
    window.__CAR__.runSeconds(0.05);
    return window.__CAR__.screenHeading();
  });
}

try {
  await boot(428, 926);
  let metrics = await page.evaluate(() => window.__CAR__.viewMetrics());
  assertAspect(metrics, 428, 926, "portrait");

  await page.setViewport({ width: 926, height: 428, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  await page.evaluate(() => window.dispatchEvent(new Event("orientationchange")));
  await new Promise((r) => setTimeout(r, 450));
  metrics = await page.evaluate(() => window.__CAR__.viewMetrics());
  assertAspect(metrics, 926, 428, "landscape");
  check("build marker", (await page.evaluate(() => window.__CAR__.build)) === "voyage-5432e", await page.evaluate(() => window.__CAR__.build));

  await straight();
  fs.mkdirSync("/opt/cursor/artifacts", { recursive: true });
  await page.screenshot({ path: "/opt/cursor/artifacts/hotfix-landscape-straight.png" });

  function turnGain(origin, heading) {
    const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
    // The chase camera yaws with the car, so compare the new heading to the
    // screen-right axis captured before the camera followed the turn.
    return dot(heading.fwd, origin.camRight) - dot(origin.fwd, origin.camRight);
  }

  async function turn(name, setup) {
    const origin = await straight();
    await page.evaluate(setup);
    const controls = await page.evaluate(() => window.__CAR__.controls());
    const heading = await page.evaluate(() => {
      window.__CAR__.runSeconds(1.15);
      return window.__CAR__.screenHeading();
    });
    const nose = turnGain(origin, heading);
    const fl = heading.fl.dx - origin.fl.dx;
    const fr = heading.fr.dx - origin.fr.dx;
    check(`${name} input is right`, controls.steer > 0.5, `steer ${controls.steer.toFixed(3)}`);
    check(`${name} car turns screen-right`, nose > 0.15, `gain ${nose.toFixed(4)}`);
    check(`${name} front wheels point screen-right`, fl > 0.01 && fr > 0.01, `dfl ${fl.toFixed(4)} dfr ${fr.toFixed(4)}`);
    check(`${name} wheel clockwise`, heading.wheelClockwise > 0.25, `angle ${heading.wheelClockwise.toFixed(3)}`);
    return heading;
  }

  await turn("keyboard D", () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyD", bubbles: true }));
  });
  await release();
  await turn("keyboard ArrowRight", () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "ArrowRight", bubbles: true }));
  });
  await release();
  await turn("touch steer right", () => {
    document.getElementById("steerR").dispatchEvent(new PointerEvent("pointerdown", {
      bubbles: true, pointerId: 1, pointerType: "touch", isPrimary: true, button: 0, clientX: 20, clientY: 20,
    }));
  });
  await release();

  const originWheel = await straight();
  await page.evaluate(() => {
    const wheel = document.getElementById("wheel");
    const r = wheel.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const down = (x, y) => wheel.dispatchEvent(new PointerEvent("pointerdown", {
      bubbles: true, pointerId: 2, pointerType: "touch", isPrimary: true, button: 0, clientX: x, clientY: y,
    }));
    const move = (x, y) => wheel.dispatchEvent(new PointerEvent("pointermove", {
      bubbles: true, pointerId: 2, pointerType: "touch", isPrimary: true, clientX: x, clientY: y,
    }));
    down(cx, cy - 48);
    move(cx + 48, cy);
  });
  const wheelControls = await page.evaluate(() => window.__CAR__.controls());
  const wheelHeading = await page.evaluate(() => {
    window.__CAR__.runSeconds(1.15);
    return window.__CAR__.screenHeading();
  });
  const wheelNose = turnGain(originWheel, wheelHeading);
  check("clockwise drag is right input", wheelControls.steer > 0.3, `steer ${wheelControls.steer.toFixed(3)}`);
  check("clockwise drag turns screen-right", wheelNose > 0.15, `gain ${wheelNose.toFixed(4)}`);
  check("clockwise drag points wheels right", wheelHeading.fl.dx - originWheel.fl.dx > 0.01 && wheelHeading.fr.dx - originWheel.fr.dx > 0.01, "");
  check("clockwise drag rotates the wheel clockwise", wheelHeading.wheelClockwise > 0.2, `angle ${wheelHeading.wheelClockwise.toFixed(3)}`);
  await page.screenshot({ path: "/opt/cursor/artifacts/hotfix-steer-right.png" });
  await release();

  const originLeft = await straight();
  await page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyA", bubbles: true }));
  });
  const left = await page.evaluate(() => {
    window.__CAR__.runSeconds(1.15);
    return window.__CAR__.screenHeading();
  });
  const leftNose = turnGain(originLeft, left);
  check("keyboard A turns screen-left", leftNose < -0.15, `gain ${leftNose.toFixed(4)}`);
  check("keyboard A wheel is counterclockwise", left.wheelClockwise < -0.25, `angle ${left.wheelClockwise.toFixed(3)}`);
  await release();

  const pedals = await page.evaluate(() => {
    const box = (id) => {
      const r = document.getElementById(id).getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top };
    };
    return { gas: box("gas"), brake: box("brake") };
  });
  check("gas sits to the right of brake", pedals.gas.left > pedals.brake.right - 4, `gas ${pedals.gas.left.toFixed(0)} brake ${pedals.brake.right.toFixed(0)}`);

  await release();
  const gasRun = await page.evaluate(() => {
    window.__CAR__.reset({ x: 0, z: -32, speed: 0 });
    document.getElementById("gas").dispatchEvent(new PointerEvent("pointerdown", {
      bubbles: true, pointerId: 1, pointerType: "touch", isPrimary: true, button: 0, clientX: 30, clientY: 30,
    }));
    const controls = window.__CAR__.controls();
    const before = window.__CAR__.report();
    window.__CAR__.runSeconds(1.4);
    const after = window.__CAR__.report();
    return { controls, before: before.speed, after: after.speed, vz: after.vel.z, gear: after.gear };
  });
  check("gas pedal is throttle", gasRun.controls.throttle > 0.9 && gasRun.controls.brake === 0, JSON.stringify(gasRun.controls));
  check("gas accelerates forward", gasRun.after > 4 && gasRun.vz > 2 && gasRun.gear > 0, `speed ${gasRun.before.toFixed(2)} -> ${gasRun.after.toFixed(2)} vz ${gasRun.vz.toFixed(2)}`);
  await release();

  const brakeRun = await page.evaluate(() => {
    window.__CAR__.reset({ x: 0, z: -32, speed: 16 });
    document.getElementById("brake").dispatchEvent(new PointerEvent("pointerdown", {
      bubbles: true, pointerId: 1, pointerType: "touch", isPrimary: true, button: 0, clientX: 30, clientY: 30,
    }));
    const controls = window.__CAR__.controls();
    const before = window.__CAR__.report().speed;
    window.__CAR__.runSeconds(0.45);
    const after = window.__CAR__.report();
    return { controls, before, after: after.speed, gear: after.gear };
  });
  check("brake pedal is brake", brakeRun.controls.brake > 0.9 && brakeRun.controls.throttle === 0, JSON.stringify(brakeRun.controls));
  check("brake slows the car", brakeRun.after < brakeRun.before - 2 && brakeRun.gear > 0, `speed ${brakeRun.before.toFixed(2)} -> ${brakeRun.after.toFixed(2)} gear ${brakeRun.gear}`);

  await release();
  const orbit = await page.evaluate(() => {
    window.__CAR__.reset({ x: 0, z: -32, speed: 6 });
    const before = window.__CAR__.orbitState();
    const canvas = document.getElementById("view");
    const r = canvas.getBoundingClientRect();
    const x = r.left + r.width * 0.5;
    const y = r.top + r.height * 0.42;
    const ev = (type, cx, cy) => canvas.dispatchEvent(new PointerEvent(type, {
      bubbles: true, pointerId: 7, pointerType: "mouse", button: 0, clientX: cx, clientY: cy,
    }));
    ev("pointerdown", x, y);
    ev("pointermove", x + 90, y - 30);
    const mid = window.__CAR__.orbitState();
    const controls = window.__CAR__.controls();
    ev("pointerup", x + 90, y - 30);
    const wheel = document.getElementById("wheel");
    const wr = wheel.getBoundingClientRect();
    wheel.dispatchEvent(new PointerEvent("pointerdown", {
      bubbles: true, pointerId: 8, pointerType: "touch", button: 0,
      clientX: wr.left + wr.width / 2, clientY: wr.top + 16,
    }));
    wheel.dispatchEvent(new PointerEvent("pointermove", {
      bubbles: true, pointerId: 8, pointerType: "touch",
      clientX: wr.left + wr.width - 8, clientY: wr.top + wr.height / 2,
    }));
    const steered = window.__CAR__.controls();
    wheel.dispatchEvent(new PointerEvent("pointerup", {
      bubbles: true, pointerId: 8, pointerType: "touch", clientX: wr.left + wr.width - 8, clientY: wr.top + wr.height / 2,
    }));
    return { before: before.yaw, mid: mid.yaw, pitch: mid.pitch, steer: controls.steer, wheelSteer: steered.steer };
  });
  check("empty-screen drag orbits the camera", Math.abs(orbit.mid - orbit.before) > 0.08, `yaw ${orbit.before.toFixed(3)} -> ${orbit.mid.toFixed(3)}`);
  check("orbit drag does not steer", Math.abs(orbit.steer) < 0.05, `steer ${orbit.steer.toFixed(3)}`);
  check("wheel drag still steers", orbit.wheelSteer > 0.2, `steer ${orbit.wheelSteer.toFixed(3)}`);

  await page.setViewport({ width: 428, height: 926, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  await page.evaluate(() => window.dispatchEvent(new Event("orientationchange")));
  await new Promise((r) => setTimeout(r, 450));
  metrics = await page.evaluate(() => window.__CAR__.viewMetrics());
  assertAspect(metrics, 428, 926, "back to portrait");
  await page.evaluate(() => {
    window.__CAR__.clearInput();
    window.__CAR__.reset({ x: 0, z: -32, speed: 8 });
    window.__CAR__.runSeconds(0.05);
  });
  await page.screenshot({ path: "/opt/cursor/artifacts/hotfix-portrait.png" });
} finally {
  await browser.close();
  server.close();
}

if (failures.length) {
  console.log(`\n${failures.length} failed`);
  process.exit(1);
}
console.log("\nall controls and aspect checks passed");
