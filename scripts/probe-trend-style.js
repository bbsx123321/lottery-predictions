/**
 * 走势图详情页「命中格计算样式」探针
 *
 * 目的：确认 automator 的 Element.style() 能不能读到 WXSS 的最终计算值，
 * 这样就能在验证脚本里加一条「命中球必须是白字」的断言，
 * 而不是靠肉眼看截图。
 *
 * 用法：node probe-trend-style.js --project <项目根> [--ws ws://...]
 */
const { join, resolve } = require("node:path");

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const projectRoot = resolve(arg("--project", join(__dirname, "..")));
const wsEndpoint = arg("--ws", "ws://127.0.0.1:9420");

const automator = require(join(projectRoot, "scripts", "node_modules", "miniprogram-automator"));

async function main() {
  const mp = await automator.connect({ wsEndpoint: wsEndpoint });
  try {
    await mp.reLaunch("/pages/tools/trend/detail?lottery=dlt&algo=consecutive");
    await new Promise(function (r) {
      setTimeout(r, 5000);
    });

    const page = await mp.currentPage();
    const hits = await page.$$(".tc--hit");
    console.log("命中格 " + hits.length + " 个");
    if (!hits.length) return;

    const el = hits[0];
    console.log("class      : " + (await el.attribute("class")));
    console.log("text       : " + (await el.text()));
    console.log("size       : " + JSON.stringify(await el.size()));

    for (const prop of ["color", "background-color", "border-radius", "font-size", "width", "height"]) {
      let v = "";
      try {
        v = await el.style(prop);
      } catch (e) {
        v = "!! " + ((e && e.message) || e);
      }
      console.log("style." + prop.padEnd(18) + ": " + v);
    }

    // 热号列的未命中格
    const warm = await page.$(".tc--warm");
    if (warm) {
      console.log("");
      console.log("热号格 class : " + (await warm.attribute("class")));
      console.log("热号格 color : " + (await warm.style("color")));
    }

    // 表头里的热号列
    const hotHead = await page.$(".tc--col.tc--hot");
    if (hotHead) {
      console.log("");
      console.log("热号表头 class : " + (await hotHead.attribute("class")));
      console.log("热号表头 color : " + (await hotHead.style("color")));
    }
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
