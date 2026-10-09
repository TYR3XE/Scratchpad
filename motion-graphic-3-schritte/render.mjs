// Rendert index.html Frame für Frame (transparent) und exportiert Videos mit Alphakanal.
//
//   node render.mjs                                  # alle Formate, beide Varianten
//   node render.mjs --formats 9x16 --variants blurred --fps 25
//
// Ausgabe in ./export/<format>/
import { chromium } from "playwright";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : def;
};
const formats = arg("formats", "9x16,4x5,1x1,16x9").split(",");
const variants = arg("variants", "blurred,sharp").split(",");
const fps = Number(arg("fps", "30"));
const outRoot = path.resolve(here, arg("out", "export"));
const keepFrames = process.argv.includes("--keep-frames");

const NAME = "3-Schritte";
const VARIANT_SUFFIX = { blurred: "", sharp: "_Text-scharf" };

function ffmpeg(args) {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: "inherit" });
  if (r.status !== 0) throw new Error("ffmpeg failed: " + args.join(" "));
}

const launchOpts = {};
const sysChromium = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
if (existsSync(sysChromium)) launchOpts.executablePath = sysChromium;
const browser = await chromium.launch(launchOpts);

for (const format of formats) {
  for (const variant of variants) {
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    const url = pathToFileURL(path.join(here, "index.html")).href + `?render&format=${format}&variant=${variant}`;
    await page.goto(url);
    await page.evaluate(() => window.__ready);
    const { w, h, duration } = await page.evaluate(() => ({ w: window.__FMT.w, h: window.__FMT.h, duration: window.__CONFIG.duration }));
    await page.setViewportSize({ width: w, height: h });

    const frameDir = path.join(here, ".frames", `${format}_${variant}`);
    rmSync(frameDir, { recursive: true, force: true });
    mkdirSync(frameDir, { recursive: true });

    const total = Math.round(duration * fps);
    process.stdout.write(`${format} ${variant}: ${total} Frames `);
    for (let f = 0; f < total; f++) {
      await page.evaluate(t => window.__render(t), f / fps);
      await page.screenshot({
        path: path.join(frameDir, `f_${String(f).padStart(4, "0")}.png`),
        omitBackground: true,
      });
      if (f % 15 === 0) process.stdout.write(".");
    }
    process.stdout.write("\n");
    await page.close();

    const outDir = path.join(outRoot, format);
    mkdirSync(outDir, { recursive: true });
    const base = path.join(outDir, `${NAME}_${format}${VARIANT_SUFFIX[variant]}`);
    const input = ["-framerate", String(fps), "-i", path.join(frameDir, "f_%04d.png")];

    // 1) ProRes 4444 mit Alphakanal – Premiere, After Effects, Final Cut, DaVinci.
    //    8-Bit-Alpha + qscale 8 ist visuell verlustfrei (~56 dB PSNR) bei ~1/3 der Dateigröße.
    //    Die Text-scharf-Variante bekommt ProRes nur mit --prores-all (hält das Repo schlank).
    if (variant === "blurred" || process.argv.includes("--prores-all")) {
      ffmpeg([...input, "-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le",
        "-alpha_bits", "8", "-qscale:v", "8", "-vendor", "apl0", "-r", String(fps), `${base}_ALPHA_ProRes4444.mov`]);
    }

    // 2) WebM VP9 mit Alphakanal – Web, Browser, einige Social-Tools
    ffmpeg([...input, "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-b:v", "0", "-crf", "18",
      "-row-mt", "1", "-auto-alt-ref", "0", `${base}_ALPHA.webm`]);

    if (variant === "blurred") {
      // 3) Schwarzer Hintergrund (H.264) – für Editoren ohne Alpha: Ebenenmodus "Negativ multiplizieren"/"Screen"
      ffmpeg(["-f", "lavfi", "-i", `color=c=black:s=${w}x${h}:r=${fps}`, ...input,
        "-filter_complex", "[0][1]overlay=shortest=1:format=auto,format=yuv420p",
        "-c:v", "libx264", "-crf", "14", "-preset", "slow", "-movflags", "+faststart",
        `${base}_SCHWARZ.mp4`]);
    }

    // 4) Vorschau über einem bewegten Demo-Hintergrund (nur zur Ansicht)
    ffmpeg(["-f", "lavfi", "-i",
      `gradients=s=${w}x${h}:r=${fps}:n=3:c0=0x55657a:c1=0x1d2530:c2=0x0b0e13:speed=0.012:type=radial:x0=${Math.round(w * 0.3)}:y0=${Math.round(h * 0.2)}:x1=${w}:y1=${h}`,
      ...input,
      "-filter_complex", "[0]vignette=PI/5[bg];[bg][1]overlay=shortest=1:format=auto,format=yuv420p",
      "-c:v", "libx264", "-crf", "20", "-preset", "medium", "-movflags", "+faststart",
      `${base}_VORSCHAU.mp4`]);

    if (!keepFrames) rmSync(frameDir, { recursive: true, force: true });
    console.log("  →", readdirSync(outDir).filter(n => n.startsWith(path.basename(base))).join(", "));
  }
}

await browser.close();
if (!keepFrames) rmSync(path.join(here, ".frames"), { recursive: true, force: true });
