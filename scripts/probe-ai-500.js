/**
 * 探针：AI 分析页选「近 500 期」，云库里到底有没有 500 期
 *
 * 背景：
 *   云函数返回的 syncMeta.count 是「拉了多少期」，不一定等于「入库了多少期」。
 *   真正的验证是让页面去拉 500 期，看 prompt 里的统计区间是不是真的 500 期。
 *
 * 用法：node probe-ai-500.js --project <项目根> [--ws ws://...]
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
    await sleep(4000);
    page = await mp.currentPage();
    console.log("   当前页: " + (typeof page.path === "function" ? await page.path() : page.path));

    let d = await page.data();
    console.log("   期数选项: " + (d.periods || []).join(" / "));
    console.log("   默认选中: " + (d.periods || [])[d.periodIndex]);

    console.log("2) 选「近 500 期」");
    const items = await page.$$(".lseg-item");
    let picked = false;
    for (let i = 0; i < items.length; i++) {
      const t = await items[i].text();
      if (t && t.replace(/\s+/g, "").indexOf("500期") > -1) {
        await items[i].tap();
        picked = true;
        break;
      }
    }
    if (!picked) {
      console.log("   找不到「近 500 期」选项");
      process.exit(1);
    }
    await sleep(3500);

    d = await page.data();
    const prompt = d.promptText || "";
    const m = prompt.match(/【统计区间】([^\n]+)/);
    console.log("   统计区间: " + (m ? m[1] : "(没解析出来)"));
    console.log("   prompt 长度: " + prompt.length + " 字");
    console.log("   指标条数: " + (d.stats || []).length);
    console.log("   热号: " + (d.hot || []).map(function (x) { return x.text; }).join(" "));
    console.log("   冷号: " + (d.cold || []).map(function (x) { return x.text; }).join(" "));

    const got500 = prompt.indexOf("近 500 期") > -1;
    console.log("");
    console.log(got500 ? "结论：云库够 500 期 ✓" : "结论：云库不足 500 期 ✗");
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
