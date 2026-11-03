/**
 * 探针：把云库回填到 500 期 / 彩种
 *
 * 背景：
 *   云库里每个彩种只有 100 期，AI 分析要能看 500 期就得先把历史灌进去。
 *   灌数据的动作是云函数 `syncAll`（幂等，只补不删），
 *   入口在自检页的「同步开奖」按钮。
 *
 * 为什么不用 syncAll(500) 一把梭：
 *   云函数超时 3 秒。4 个彩种虽然并发，但每个要拉 5 页上游 + 写 400 条，
 *   有可能撞超时。先试一把，失败再按彩种分开来。
 *
 * 用法：node probe-sync-backfill.js --project <项目根> [--ws ws://...]
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
    console.log("1) 进环境自检页");
    await mp.reLaunch("/pages/debug/index");
    await sleep(4000);
    const page = await mp.currentPage();
    console.log("   当前页: " + (typeof page.path === "function" ? await page.path() : page.path));

    console.log("2) 找「同步开奖」按钮");
    const btns = await page.$$(".btn");
    let syncBtn = null;
    for (let i = 0; i < btns.length; i++) {
      const t = await btns[i].text();
      if (t && t.indexOf("同步开奖") > -1) {
        syncBtn = btns[i];
        break;
      }
    }
    if (!syncBtn) {
      console.log("   找不到「同步开奖」按钮");
      process.exit(1);
    }

    console.log("3) 点同步（云函数里拉 500 期 × 4 彩种）");
    const t0 = Date.now();
    await syncBtn.tap();

    // 等 syncing 结束
    let syncing = true;
    while (Date.now() - t0 < 90000) {
      await sleep(2000);
      const d = await page.data();
      if (d.syncing === false) {
        syncing = false;
        break;
      }
    }
    console.log("   耗时 " + (Date.now() - t0) + "ms" + (syncing ? "  （还在跑）" : "  （已完成）"));

    console.log("4) 读各彩种入库情况");
    const d = await page.data();
    const lots = d.lotteries || [];
    lots.forEach(function (l) {
      console.log(
        "   " + String(l.name || l.lottery).padEnd(8) +
          " 最新 " + String(l.latestPeriod || "-").padEnd(10) +
          " 入库 " + String(l.count || l.total || "-") + " 期" +
          "  " + (l.date || "")
      );
    });

    console.log("5) 重新检测");
    const recheck = await page.$$(".btn");
    for (let i = 0; i < recheck.length; i++) {
      const t = await recheck[i].text();
      if (t && t.indexOf("重新检测") > -1) {
        await recheck[i].tap();
        break;
      }
    }
    await sleep(8000);
    const d2 = await page.data();
    (d2.checks || []).forEach(function (c) {
      console.log("   [" + (c.statusText || "") + "] " + c.label + " —— " + c.detail);
    });
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
