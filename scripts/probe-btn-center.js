/**
 * 探针：AI 分析页按钮文字是否居中
 *
 * 背景：
 *   全局 .lbtn 是照着 <button> 写的 —— <button> 的文字原生居中。
 *   AI 分析页的按钮用的是 <view>，文字默认靠左，
 *   所以给 .aabtn 补了 flex 居中（见 ai-analysis/index.wxss）。
 *
 * 这个探针做两件事：
 *   1. 读 .aabtn 的计算样式，确认 display/justify-content 真的生效了
 *   2. 截一张图，肉眼看文字是不是在按钮中间
 *
 * 用法：node probe-btn-center.js --project <项目根> [--ws ws://...]
 */
const { join, resolve } = require("node:path");

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const projectRoot = resolve(arg("--project", join(__dirname, "..")));
const wsEndpoint = arg("--ws", "ws://127.0.0.1:9420");
const outShot = resolve(arg("--out", join(projectRoot, "design", "screenshot-ai-analysis-btn.png")));

const automator = require(join(projectRoot, "scripts", "node_modules", "miniprogram-automator"));

function sleep(ms) {
  return new Promise(function (r) {
    setTimeout(r, ms);
  });
}

async function pathOf(page) {
  return typeof page.path === "function" ? await page.path() : page.path;
}

/** automator 有些方法对 <view> 会抛错（比如 text/style），单独兜住好定位 */
async function safe(fn, fallback) {
  try {
    const v = await fn();
    return v === undefined || v === null ? fallback : v;
  } catch (e) {
    return fallback;
  }
}

async function main() {
  const mp = await automator.connect({ wsEndpoint: wsEndpoint });
  try {
    console.log("1) 进 AI 分析页");
    await mp.switchTab("/pages/index/index");
    await sleep(2500);
    let page = await mp.currentPage();

    const tools = await page.$$(".tool-item");
    let entry = null;
    for (let i = 0; i < tools.length; i++) {
      const t = await tools[i].text();
      if (t && t.indexOf("AI") > -1) {
        entry = tools[i];
        break;
      }
    }
    if (!entry) {
      console.log("   找不到 AI 分析入口");
      process.exit(1);
    }
    await entry.tap();
    await sleep(3500);
    page = await mp.currentPage();
    console.log("   当前页: " + (await pathOf(page)));

    console.log("2) 读 .aabtn 计算样式");
    const btns = await page.$$(".aabtn");
    console.log("   .aabtn 数量: " + btns.length);
    for (let i = 0; i < btns.length; i++) {
      const el = btns[i];
      const txt = await safe(() => el.text(), "?");
      const sz = await safe(() => el.size(), null);
      const display = await safe(() => el.style("display"), "?");
      const jc = await safe(() => el.style("justify-content"), "?");
      const ai = await safe(() => el.style("align-items"), "?");
      const ta = await safe(() => el.style("text-align"), "?");
      console.log(
        "   [" + i + "] " + JSON.stringify(String(txt).replace(/\s+/g, " ").trim()) +
          "  尺寸 " + (sz ? sz.width + "×" + sz.height : "?") +
          "  display=" + display +
          "  justify-content=" + jc +
          "  align-items=" + ai +
          "  text-align=" + ta
      );
    }

    console.log("3) 滚到底部再截图");
    await safe(() => mp.callWxMethod("pageScrollTo", { scrollTop: 9999, duration: 0 }), null);
    await sleep(1200);
    await mp.screenshot({ path: outShot });
    console.log("   " + outShot);
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
