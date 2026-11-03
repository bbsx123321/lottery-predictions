/**
 * 探针：AI 设置页的多配置交互
 *
 * 验证：
 *   1. 配置列表能渲染
 *   2. 能新增到 3 套，第 4 套加不了（按钮消失 + addConfig 返回 null）
 *   3. 点卡片能切换当前配置
 *   4. 切换后表单跟着换
 *   5. 删除当前配置后自动选第一套
 *
 * 用法：node probe-ai-configs.js --project <项目根> [--ws ws://...]
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

let failures = 0;
function ok(cond, label, extra) {
  if (cond) {
    console.log("  [PASS] " + label + (extra ? "  " + extra : ""));
  } else {
    failures++;
    console.log("  [FAIL] " + label + (extra ? "  " + extra : ""));
  }
}

async function main() {
  const mp = await automator.connect({ wsEndpoint: wsEndpoint });
  try {
    console.log("1) 进 AI 设置页");
    await mp.reLaunch("/pages/tools/ai-settings/index");
    await sleep(4000);
    const page = await mp.currentPage();
    console.log("   当前页: " + (typeof page.path === "function" ? await page.path() : page.path));

    let d = await page.data();
    console.log("   现有配置: " + JSON.stringify((d.configs || []).map(function (c) { return c.name; })));
    console.log("   当前: " + d.configName + " / " + d.model + "  hasKey=" + d.hasKey);

    const cards = await page.$$(".acfg");
    ok(cards.length >= 1, "配置卡片已渲染", cards.length + " 张");

    console.log("2) 新增配置到 3 套");
    for (let i = 0; i < 3; i++) {
      const addBtn = await page.$(".acfg--add");
      if (!addBtn) break;
      await addBtn.tap();
      await sleep(1500);
    }
    d = await page.data();
    const names = (d.configs || []).map(function (c) { return c.name; });
    console.log("   现在: " + JSON.stringify(names));
    ok(d.configs.length === 3, "一共 3 套", d.configs.length + " 套");
    ok(d.canAdd === false, "canAdd 已关（不能再加）");

    const addGone = await page.$(".acfg--add");
    ok(!addGone, "「新增」卡片已隐藏");

    console.log("3) 点第 1 张卡切换");
    const cards2 = await page.$$(".acfg");
    await cards2[0].tap();
    await sleep(1500);
    d = await page.data();
    ok((d.configs || [])[0].active === true, "第 1 套变成当前");
    ok(d.configName === (d.configs || [])[0].name, "表单跟着换成第 1 套", d.configName);
    console.log("   当前: " + d.configName + " / " + d.model);

    console.log("4) 删除当前配置");
    const delBtn = await page.$$(".abtn");
    let deleted = false;
    for (let i = 0; i < delBtn.length; i++) {
      const t = await delBtn[i].text();
      if (t && t.indexOf("删除当前配置") > -1) {
        await delBtn[i].tap();
        deleted = true;
        break;
      }
    }
    ok(deleted, "找到「删除当前配置」按钮");
    await sleep(1500);
    d = await page.data();
    ok(d.configs.length === 2, "删完剩 2 套", d.configs.length + " 套");
    ok((d.configs || [])[0].active === true, "自动选回第一套");

    console.log("5) 截图");
    await mp.screenshot({ path: outShot });
    console.log("   " + outShot);

    console.log("");
    console.log(failures ? "有 " + failures + " 项未通过" : "全部通过");
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
