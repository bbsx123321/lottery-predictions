/**
 * 探针：拍首页（用于临时摆出图标候选做对比）
 *
 * 用法：node probe-home-shot.js --project <项目根> [--out <png>] [--ws ws://...]
 */
const { join, resolve } = require("node:path");

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const projectRoot = resolve(arg("--project", join(__dirname, "..")));
const wsEndpoint = arg("--ws", "ws://127.0.0.1:9420");
const outShot = resolve(arg("--out", join(projectRoot, "design", "screenshot-home.png")));

const automator = require(join(projectRoot, "scripts", "node_modules", "miniprogram-automator"));

function sleep(ms) {
  return new Promise(function (r) {
    setTimeout(r, ms);
  });
}

async function main() {
  const mp = await automator.connect({ wsEndpoint: wsEndpoint });
  try {
    await mp.switchTab("/pages/index/index");
    await sleep(3000);
    const page = await mp.currentPage();
    const cands = await page.$$(".icand");
    console.log("候选行数: " + cands.length);
    await mp.screenshot({ path: outShot });
    console.log("截图: " + outShot);
  } finally {
    try {
      await mp.disconnect();
    } catch (e) {
      /* ignore */
    }
  }
}

main().catch(function (err) {
  console.error("探针中断: " + ((err && err.message) || err));
  process.exit(1);
});
