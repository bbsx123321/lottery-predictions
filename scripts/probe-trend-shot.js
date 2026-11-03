/**
 * 走势图详情页的截图探针
 *
 * 现象：automator 的 miniProgram.screenshot() 在走势图详情页上超时，
 * 而且超时之后整个通道会乱掉（后面的页面断言也跟着失败）。
 * 这个脚本把「进入表格页 → 截图 → 开画线 → 截图」拆开，
 * 逐步确认是哪一步把截图搞挂的。
 *
 * 用法：node probe-trend-shot.js --project <项目根> [--ws ws://...]
 */
const { existsSync, mkdirSync } = require("node:fs");
const { join, resolve } = require("node:path");

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const projectRoot = resolve(arg("--project", join(__dirname, "..")));
const wsEndpoint = arg("--ws", "ws://127.0.0.1:9420");
const shotDir = join(projectRoot, "design");

const automator = require(join(projectRoot, "scripts", "node_modules", "miniprogram-automator"));

const t0 = Date.now();
function ts() {
  return (Date.now() - t0) / 1000;
}

async function shot(mp, name) {
  const path = join(shotDir, "probe-" + name + ".png");
  const start = Date.now();
  try {
    await mp.screenshot({ path: path });
    console.log("  [OK]   " + name + "  用时 " + (Date.now() - start) + "ms");
    return true;
  } catch (e) {
    console.log("  [FAIL] " + name + "  用时 " + (Date.now() - start) + "ms  " + ((e && e.message) || e));
    return false;
  }
}

async function main() {
  if (!existsSync(shotDir)) mkdirSync(shotDir, { recursive: true });
  const mp = await automator.connect({ wsEndpoint: wsEndpoint });
  try {
    console.log("1) 进走势图详情页");
    await mp.reLaunch("/pages/tools/trend/detail?lottery=dlt&algo=consecutive");
    await new Promise(function (r) { setTimeout(r, 4000); });

    console.log("2) 表格刚渲染完就截图");
    const a = await shot(mp, "a-table");

    console.log("3) 点开画线");
    const page = await mp.currentPage();
    const bar = await page.$$(".tbar-item");
    console.log("   底栏按钮 " + bar.length + " 个");
    if (bar.length >= 2) {
      await bar[1].tap();
      await new Promise(function (r) { setTimeout(r, 1500); });
      const segs = await page.$$(".tline-seg");
      console.log("   线段 " + segs.length + " 条");
    }

    console.log("4) 画线后再截图");
    const b = await shot(mp, "b-lines");

    console.log("5) 切到别的页面再截图（看通道有没有被搞坏）");
    await mp.reLaunch("/pages/tools/pick/index");
    await new Promise(function (r) { setTimeout(r, 3000); });
    const c = await shot(mp, "c-pick");

    console.log("");
    console.log("表格截图 " + (a ? "成功" : "失败") + " / 画线截图 " + (b ? "成功" : "失败") + " / 后续页面截图 " + (c ? "成功" : "失败"));
  } finally {
    try { await mp.disconnect(); } catch (e) { /* ignore */ }
  }
}

main().catch(function (err) {
  console.error("探针中断: " + ((err && err.message) || err));
  process.exit(1);
});
