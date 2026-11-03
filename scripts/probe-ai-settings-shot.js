/**
 * 探针：把 AI 设置页摆成「三套有名配置」的样子并截图
 *
 * 纯为截图好看 + 顺带验证「配置名称」这个输入框真的能存下来。
 *
 * 用法：node probe-ai-settings-shot.js --project <项目根> [--ws ws://...]
 */
const { join, resolve } = require("node:path");

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const projectRoot = resolve(arg("--project", join(__dirname, "..")));
const wsEndpoint = arg("--ws", "ws://127.0.0.1:9420");
const outShot = resolve(arg("--out", join(projectRoot, "design", "screenshot-ai-settings.png")));

const automator = require(join(projectRoot, "scripts", "node_modules", "miniprogram-automator"));

function sleep(ms) {
  return new Promise(function (r) {
    setTimeout(r, ms);
  });
}

async function main() {
  const mp = await automator.connect({ wsEndpoint: wsEndpoint });
  try {
    await mp.reLaunch("/pages/tools/ai-settings/index");
    await sleep(4000);
    const page = await mp.currentPage();

    // 名字输入框是 .afield-input 的第一个
    async function rename(text) {
      const inputs = await page.$$(".afield-input");
      if (!inputs[0]) return;
      await inputs[0].input(text);
      await sleep(500);
      // 触发 blur 让草稿落库
      await inputs[0].tap();
      await sleep(300);
      const btns = await page.$$(".lbtn");
      for (let i = 0; i < btns.length; i++) {
        const t = await btns[i].text();
        if (t && t.indexOf("保存设置") > -1) {
          await btns[i].tap();
          await sleep(1200);
          break;
        }
      }
    }

    const cards = await page.$$(".acfg-item");
    console.log("现有配置: " + cards.length + " 套");

    if (cards.length) {
      await cards[0].tap();
      await sleep(1200);
      await rename("日常快用");
    }

    const cards2 = await page.$$(".acfg-item");
    if (cards2.length > 1) {
      await cards2[1].tap();
      await sleep(1200);
      await rename("深度分析");
    }

    // 补到 3 套
    for (let i = 0; i < 3; i++) {
      const add = await page.$(".acfg--add");
      if (!add) break;
      await add.tap();
      await sleep(1400);
      await rename("自有 Key");
    }

    const d = await page.data();
    console.log("现在: " + JSON.stringify((d.configs || []).map(function (c) { return c.name; })));

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
