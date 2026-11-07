const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const root = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(root, "assets", f), "utf8");
const toOff = (svg) => svg.replaceAll("#0068FF", "#5C6B82").replaceAll("#4D94FF", "#8A97AA");

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  for (const size of [16, 32, 48, 128]) {
    const svg = size === 16 ? read("logo-16.svg") : read("logo.svg");
    for (const [suffix, src] of [["", svg], ["-off", toOff(svg)]]) {
      await page.setViewportSize({ width: size, height: size });
      const sized = src.replace(/width="48" height="48"/, `width="${size}" height="${size}"`);
      await page.setContent(`<html><body style="margin:0;background:transparent">${sized}</body></html>`);
      const out = path.join(root, "icons", `z${suffix}-${size}.png`);
      await page.locator("svg").screenshot({ path: out, omitBackground: true });
      console.log("wrote", path.relative(root, out));
    }
  }
  await browser.close();
})();
