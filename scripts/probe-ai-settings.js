/**
 * AI 设置页冒烟探针
 *
 * 走完整链路：
 *   我的 → AI 设置 → 拉取预置配置（云函数 getAIConfig）→ 测试连接（真实调一次模型）
 *
 * 用法：node probe-ai-settings.js --project <项目根> [--ws ws://...]
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
    console.log("1) 进「我的」页");
    await mp.switchTab("/pages/mine/index");
    await sleep(2000);
    let page = await mp.currentPage();

    const entry = await page.$(".msetting");
    console.log("   AI 设置入口: " + (entry ? "有" : "没有"));

    console.log("2) 点进 AI 设置页");
    await entry.tap();
    await sleep(2500);
    page = await mp.currentPage();
    console.log("   当前页: " + (await pathOf(page)));

    let data = await page.data();
    console.log("   baseUrl: " + data.baseUrl);
    console.log("   model  : " + data.model);
    console.log("   有密钥 : " + data.hasKey);
    console.log("   模型列表: " + (data.modelNames || []).join(" / "));

    console.log("3) 拉取预置配置（云函数 getAIConfig）");
    const presetBtn = await page.$(".apreset");
    await presetBtn.tap();
    await sleep(4000);
    data = await page.data();
    console.log("   baseUrl : " + data.baseUrl);
    console.log("   model   : " + data.model);
    console.log("   有密钥  : " + data.hasKey);
    console.log("   密钥长度: " + (data.apiKey || "").length);
    console.log("   error   : " + (data.error || "无"));

    console.log("4) 测试连接（真实调一次模型）");
    const btns = await page.$$(".lbtn");
    // 第 2 个 .lbtn 是「测试连接」（第 1 个是「拉取预置配置」）
    let testBtn = null;
    for (let i = 0; i < btns.length; i++) {
      const t = await btns[i].text();
      if (t && t.indexOf("测试连接") > -1) {
        testBtn = btns[i];
        break;
      }
    }
    if (!testBtn) {
      console.log("   找不到「测试连接」按钮");
      process.exit(1);
    }

    const t0 = Date.now();
    await testBtn.tap();

    // 轮询等结果，最多 60 秒
    let result = "";
    let meta = "";
    let err = "";
    while (Date.now() - t0 < 60000) {
      await sleep(2000);
      data = await page.data();
      if (data.result || data.error) {
        result = data.result || "";
        meta = data.resultMeta || "";
        err = data.error || "";
        break;
      }
    }

    console.log("   耗时    : " + (Date.now() - t0) + "ms");
    console.log("   模型回复: " + (result || "(无)"));
    console.log("   元信息  : " + (meta || "(无)"));
    console.log("   error   : " + (err || "无"));

    const shot = join(projectRoot, "design", "screenshot-ai-settings.png");
    await mp.screenshot({ path: shot });
    console.log("   截图    : " + shot);

    console.log("");
    console.log(err || !result ? "结论：连接没打通" : "结论：链路已打通");
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
