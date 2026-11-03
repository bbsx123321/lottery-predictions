/**
 * AI 分析页冒烟探针
 *
 * 走完整链路：
 *   首页工具箱 → AI 分析 → 选彩种/期数 → 本地算指标 → 真实调模型 → 出解读
 *
 * 用法：node probe-ai-analysis.js --project <项目根> [--ws ws://...]
 */
const { join, resolve } = require("node:path");

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const projectRoot = resolve(arg("--project", join(__dirname, "..")));
const wsEndpoint = arg("--ws", "ws://127.0.0.1:9420");

const automator = require(join(projectRoot, "scripts", "node_modules", "miniprogram-automator"));

function sleep(ms) {
  return new Promise(function (r) {
    setTimeout(r, ms);
  });
}

async function pathOf(page) {
  return typeof page.path === "function" ? await page.path() : page.path;
}

async function main() {
  const mp = await automator.connect({ wsEndpoint: wsEndpoint });
  try {
    console.log("1) 回首页，找 AI 分析入口");
    await mp.switchTab("/pages/index/index");
    await sleep(2500);
    let page = await mp.currentPage();

    const tools = await page.$$(".tool-item");
    console.log("   工具格: " + tools.length + " 个");

    let entry = null;
    for (let i = 0; i < tools.length; i++) {
      const t = await tools[i].text();
      if (t && t.indexOf("AI") > -1) {
        entry = tools[i];
        console.log("   找到入口: " + t.replace(/\s+/g, " "));
        break;
      }
    }
    if (!entry) {
      console.log("   找不到 AI 分析入口");
      process.exit(1);
    }

    console.log("2) 进 AI 分析页");
    await entry.tap();
    await sleep(3000);
    page = await mp.currentPage();
    console.log("   当前页: " + (await pathOf(page)));

    let data = await page.data();
    console.log("   有 AI 配置: " + data.hasAI);
    console.log("   统计指标条数: " + (data.stats || []).length);
    console.log("   热号: " + (data.hot || []).map(function (x) { return x.text; }).join(" "));
    console.log("   冷号: " + (data.cold || []).map(function (x) { return x.text; }).join(" "));
    console.log("   prompt 长度: " + (data.promptText || "").length);

    console.log("3) 切到大乐透 + 30 期，验证会重算");
    const tabs = await page.$$(".ltab");
    for (let i = 0; i < tabs.length; i++) {
      const t = await tabs[i].text();
      if (t && t.indexOf("大乐透") > -1) {
        await tabs[i].tap();
        break;
      }
    }
    await sleep(3000);
    data = await page.data();
    console.log("   彩种: " + data.lotteryKey + "  指标条数: " + (data.stats || []).length);

    console.log("4) 回到双色球 + 50 期");
    const tabs2 = await page.$$(".ltab");
    for (let i = 0; i < tabs2.length; i++) {
      const t = await tabs2[i].text();
      if (t && t.indexOf("双色球") > -1) {
        await tabs2[i].tap();
        break;
      }
    }
    await sleep(3000);

    console.log("5) 点「生成 AI 分析」（真实调模型）");
    const btns = await page.$$(".lbtn");
    let genBtn = null;
    for (let i = 0; i < btns.length; i++) {
      const t = await btns[i].text();
      if (t && t.indexOf("生成 AI 分析") > -1) {
        genBtn = btns[i];
        break;
      }
    }
    if (!genBtn) {
      console.log("   找不到「生成 AI 分析」按钮");
      process.exit(1);
    }

    const t0 = Date.now();
    await genBtn.tap();

    let result = "";
    let meta = "";
    let err = "";
    while (Date.now() - t0 < 90000) {
      await sleep(2500);
      data = await page.data();
      result = data.result || "";
      meta = data.resultMeta || "";
      err = data.error || "";
      if (result || err) break;
    }

    console.log("   耗时    : " + (Date.now() - t0) + "ms");
    console.log("   元信息  : " + (meta || "(无)"));
    console.log("   error   : " + (err || "无"));
    console.log("   回复长度: " + result.length + " 字符");
    console.log("   回复前 200 字：");
    console.log("   " + result.slice(0, 200).replace(/\n/g, "\n   "));

    const shot = join(projectRoot, "design", "screenshot-ai-analysis.png");
    await mp.screenshot({ path: shot });
    console.log("   截图    : " + shot);

    console.log("");
    console.log(err || !result ? "结论：没打通" : "结论：链路已打通");
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
