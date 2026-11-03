/**
 * 「我的」页授权卡的尺寸探针
 *
 * 现象：未登录态的 `.mavatar-pick`（open-type="chooseAvatar" 的 button）
 * 渲染出来是一个**椭圆**，不是正圆，而且里面的「+」跑到了顶端。
 *
 * 疑点：button 在小程序里有默认样式（padding / line-height / display），
 * 类选择器不一定能完全盖住。这里把按钮和内部占位块的**实际渲染尺寸**打出来，
 * 用数据定位是谁把盒子撑变形了。
 *
 * 用法：node probe-mine-size.js --project <项目根> [--ws ws://...]
 */
const { join, resolve } = require("node:path");

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const projectRoot = resolve(arg("--project", join(__dirname, "..")));
const wsEndpoint = arg("--ws", "ws://127.0.0.1:9420");

const automator = require(join(projectRoot, "scripts", "node_modules", "miniprogram-automator"));

async function report(page, selector) {
  const el = await page.$(selector);
  if (!el) {
    console.log("  " + selector.padEnd(18) + " -> 不存在");
    return;
  }
  const size = await el.size();
  const box = await el.offset();
  const pick = (name) => {
    try {
      return el.style(name);
    } catch (e) {
      return "?";
    }
  };
  const style = {};
  for (const name of [
    "width",
    "height",
    "min-width",
    "max-width",
    "padding-left",
    "padding-right",
    "border-left-width",
    "border-radius",
    "line-height",
    "display",
    "position",
    "box-sizing",
  ]) {
    style[name] = await pick(name);
  }
  console.log(
    "  " +
      selector.padEnd(18) +
      " -> size " +
      JSON.stringify(size) +
      "  offset " +
      JSON.stringify(box && { left: box.left, top: box.top })
  );
  console.log("      style " + JSON.stringify(style));
}

async function main() {
  const mp = await automator.connect({ wsEndpoint: wsEndpoint });
  try {
    await mp.switchTab("/pages/mine/index");
    await new Promise(function (r) {
      setTimeout(r, 2000);
    });

    let page = await mp.currentPage();
    let data = await page.data();

    if (data.logged) {
      console.log("已登录态的头像按钮：");
      await report(page, ".mavatar-btn");
      await report(page, ".mavatar");
      console.log("");
    }

    if (data.logged) {
      const logoutEl = await page.$(".mlogout");
      if (logoutEl) {
        await logoutEl.tap();
        await new Promise(function (r) {
          setTimeout(r, 1500);
        });
        page = await mp.currentPage();
      }
    }

    console.log("未登录授权卡的渲染尺寸：");
    await report(page, ".mavatar-ring");
    await report(page, ".mavatar-pick");
    await report(page, ".mavatar-ph");
    await report(page, ".mavatar-img");
    await report(page, ".mavatar-ph-icon");
    await report(page, ".mcard--login");
    await report(page, ".mfield");
    await report(page, ".mlogin-btn");

    const pick = await page.$(".mavatar-pick");
    if (pick) {
      console.log("");
      console.log("按钮的实际渲染结构：");
      console.log((await pick.outerWxml()).slice(0, 1200));
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
