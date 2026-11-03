/**
 * 小程序自动化验证
 *
 * 在微信开发者工具的模拟器里跑真实小程序，逐页断言渲染、数据与交互，并出截图。
 *
 * 覆盖：
 *   1. 首页（彩种切换 / 最新开奖 / 工具箱 / 近 10 期）
 *   2. 切换彩种
 *   3. 四个工具页（走势图 / 往期开奖 / 选号 / 数据分析）
 *   4. 底部 tab（首页 / 开奖 / 我的）：tab 切换 + 登录授权 + 模拟选号记录
 *   5. AI 设置：入口 / 预置配置 / 真实调一次模型
 *   6. AI 分析：统计指标 / prompt / 真实生成一次解读
 *   7. 环境自检页
 *
 * 用法：
 *   node verify-miniprogram.js --project <项目根>
 *                               [--out design/screenshot-index.png] [--ws ws://127.0.0.1:9420]
 *
 * 前提：
 *   1. 开发者工具已打开项目并登录
 *   2. 已开自动化通道：cli.bat auto --project <项目根> --port 24501 --auto-port 9420
 *   3. cd scripts && npm install
 */
const { existsSync, mkdirSync, readFileSync } = require("node:fs");
const { dirname, join, resolve } = require("node:path");
const { execFileSync } = require("node:child_process");

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const projectRoot = resolve(arg("--project", join(__dirname, "..")));
const outShot = resolve(arg("--out", join(projectRoot, "design", "screenshot-index.png")));
const shotDir = dirname(outShot);
const wsEndpoint = arg("--ws", "ws://127.0.0.1:9420");

const results = [];

function record(name, ok, detail) {
  results.push({ name: name, ok: ok, detail: detail });
  console.log("  [" + (ok ? "PASS" : "FAIL") + "] " + name + (detail ? " -> " + detail : ""));
}

function readProp(obj, key) {
  return obj ? obj[key] : undefined;
}

function requireAutomator(root) {
  const candidates = [
    "miniprogram-automator",
    join(root, "scripts", "node_modules", "miniprogram-automator"),
    join(root, "node_modules", "miniprogram-automator"),
  ];
  let lastError = null;
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError || new Error("找不到 miniprogram-automator");
}

async function pathOf(page) {
  return typeof page.path === "function" ? await page.path() : page.path;
}

async function dataOf(page) {
  return typeof page.data === "function" ? await page.data() : page.data;
}

/**
 * 模拟器刚重建 / 刚打开时，automator 的命令会返回
 * "timeout waiting for automator response" —— 通道本身是通的，只是对面还在忙。
 * 这里对可重试的错误做有限次退避重试。
 */
async function withRetry(fn, label, times, delayMs) {
  const n = times || 5;
  const wait = delayMs || 2000;
  let lastError = null;

  for (let i = 0; i < n; i++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      const msg = (e && e.message) || "";
      const retryable =
        msg.indexOf("timeout waiting for automator response") > -1 ||
        msg.indexOf("timeout") > -1 ||
        // reLaunch 之后 currentPage 可能短暂拿不到页面节点
        msg.indexOf("page node not found") > -1 ||
        msg.indexOf("not found") > -1;
      if (!retryable) throw e;
      console.log("     (重试 " + (i + 1) + "/" + n + "：" + label + " -> " + msg + ")");
      await new Promise(function (r) {
        setTimeout(r, wait);
      });
    }
  }
  throw lastError;
}

async function waitForPath(miniProgram, want, timeoutMs) {
  const until = Date.now() + (timeoutMs || 8000);
  let path = "";
  while (Date.now() < until) {
    await new Promise(function (r) {
      setTimeout(r, 300);
    });
    const p = await withRetry(() => miniProgram.currentPage(), "currentPage");
    path = await pathOf(p);
    if (path === want) return path;
  }
  return path;
}

/** 等页面 loading 结束 */
async function waitForLoadingDone(page, timeoutMs) {
  let data = await withRetry(() => dataOf(page), "page.data");
  const until = Date.now() + (timeoutMs || 10000);
  while (readProp(data, "loading") === true && Date.now() < until) {
    await new Promise(function (r) {
      setTimeout(r, 400);
    });
    data = await withRetry(() => dataOf(page), "page.data");
  }
  return data;
}

/** 等某个字段变成非空；返回整份 page data */
async function waitForField(page, field, timeoutMs) {
  const until = Date.now() + (timeoutMs || 12000);
  let data = await withRetry(() => dataOf(page), "page.data");
  while (Date.now() < until) {
    const value = readProp(data, field);
    if (value && (!Array.isArray(value) || value.length)) return data;
    await new Promise(function (r) {
      setTimeout(r, 400);
    });
    data = await withRetry(() => dataOf(page), "page.data");
  }
  return data;
}

/** 等某个条件成立（自定义谓词）；返回整份 page data */
async function waitForData(page, predicate, timeoutMs) {
  const until = Date.now() + (timeoutMs || 12000);
  let data = await withRetry(() => dataOf(page), "page.data");
  while (Date.now() < until) {
    if (predicate(data)) return data;
    await new Promise(function (r) {
      setTimeout(r, 400);
    });
    data = await withRetry(() => dataOf(page), "page.data");
  }
  return data;
}

/**
 * 截图。
 *
 * 注意：开发者工具侧的 automator 响应超时是固定的 10 秒左右，
 * 而本机 `App.captureScreenshot` 在走势图这种重表格页面上要 9 秒多 —— 卡在临界线上，
 * 偶发就会超时。所以这里必须重试，而且失败要打日志
 * （早前静默 catch 让人误以为「截图没变化」，其实根本没写文件）。
 *
 * 重试的等待要够长：超时的请求其实还在 IDE 侧排着队，
 * 等 1.5 秒就重试只会让排队更长。等 6 秒再试命中率就高了。
 * 三次都失败时退回 wechatide 的原生截图（不走 automator 通道）。
 */
async function shoot(miniProgram, name) {
  const path = join(shotDir, "screenshot-" + name + ".png");
  for (let i = 0; i < 3; i++) {
    try {
      await miniProgram.screenshot({ path: path });
      return path;
    } catch (e) {
      const msg = (e && e.message) || String(e);
      console.log("     (截图重试 " + (i + 1) + "/3：" + name + " -> " + msg + ")");
      await new Promise(function (r) {
        setTimeout(r, 6000);
      });
    }
  }

  // 兜底：用开发者工具自己的截图工具（原生实现，不受 automator 超时限制）
  try {
    execFileSync(
      "wechatide",
      [
        "-c", "MiniMaxCode",
        "simulator_screenshot",
        "--project", projectRoot,
        "--path", path,
        "--optimize", "false",
      ],
      { stdio: "ignore", timeout: 90000 }
    );
    console.log("     (截图兜底成功：" + name + ")");
  } catch (e) {
    console.log("     (截图最终失败：" + name + ")");
  }
  return path;
}

async function main() {
  console.log("小程序自动化验证");
  console.log("项目    : " + projectRoot);
  console.log("端点    : " + wsEndpoint);
  console.log("");

  let automator;
  try {
    automator = requireAutomator(projectRoot);
  } catch (e) {
    console.error("未安装 miniprogram-automator，请先执行：");
    console.error("  cd " + join(projectRoot, "scripts") + " && npm install");
    process.exit(2);
  }

  let miniProgram;
  try {
    miniProgram = await automator.connect({ wsEndpoint: wsEndpoint });
  } catch (err) {
    console.error("无法连接自动化端点: " + err.message);
    console.error("请确认已执行：cli.bat auto --project <项目根> --port 24501 --auto-port 9420");
    process.exit(2);
  }

  try {
    if (!existsSync(shotDir)) mkdirSync(shotDir, { recursive: true });

    /* ============ 1. 首页 ============ */
    console.log("1) 首页");
    await withRetry(() => miniProgram.reLaunch("/pages/index/index"), "reLaunch");
    const homePath = await waitForPath(miniProgram, "pages/index/index");
    record("首页已打开", homePath === "pages/index/index", homePath);

    let page = await withRetry(() => miniProgram.currentPage(), "currentPage");
    let data = await waitForField(page, "latest");
    const tabs = readProp(data, "tabs") || [];
    const latest = readProp(data, "latest");
    const recent = readProp(data, "recent") || [];
    const tools = readProp(data, "tools") || [];

    record("彩种切换菜单 4 项", tabs.length === 4, tabs.map(function (t) { return readProp(t, "name"); }).join(" / "));
    record(
      "最新一期有号码球",
      !!latest && (readProp(latest, "main") || []).length > 0,
      latest ? readProp(latest, "period") + " 期 " + (readProp(latest, "mainText") || "") : "无"
    );
    record(
      "最新一期有销量/奖池",
      !!latest && !!readProp(latest, "sales") && !!readProp(latest, "pool"),
      latest ? "销量 " + readProp(latest, "sales") + " / 奖池 " + readProp(latest, "pool") : "无"
    );
    record("工具箱 8 个工具", tools.length === 8, tools.map(function (t) { return readProp(t, "label"); }).join(" "));
    record("近期开奖 10 期", recent.length === 10, recent.length + " 期");

    const tabEls = await page.$$(".ltab");
    record("切换菜单已渲染", tabEls.length === 4, tabEls.length + " 个");
    const toolEls = await page.$$(".tool-item");
    record("工具格已渲染", toolEls.length === 8, toolEls.length + " 个");

    await shoot(miniProgram, "home");

    /* ============ 2. 切换彩种 ============ */
    console.log("");
    console.log("2) 切换彩种");
    const beforePeriod = readProp(latest, "period");
    if (tabEls.length === 4) {
      await tabEls[3].tap();
      await new Promise(function (r) {
        setTimeout(r, 2500);
      });
      const after = await dataOf(page);
      const afterLatest = readProp(after, "latest");
      record(
        "切到大乐透后数据变了",
        readProp(after, "lotteryKey") === "dlt" && readProp(afterLatest, "period") !== beforePeriod,
        "lotteryKey=" + readProp(after, "lotteryKey") + " 期号 " + readProp(afterLatest, "period")
      );
      record(
        "大乐透号码区正确",
        (readProp(afterLatest, "main") || []).length === 5 && (readProp(afterLatest, "extra") || []).length === 2,
        (readProp(afterLatest, "mainText") || "") + " | " + (readProp(afterLatest, "extraText") || "")
      );
      // 切回双色球
      const tabs2 = await page.$$(".ltab");
      if (tabs2.length === 4) {
        await tabs2[0].tap();
        await new Promise(function (r) {
          setTimeout(r, 2000);
        });
      }
    }

    /* ============ 3. 工具页 ============ */
    console.log("");
    console.log("3) 工具页");

    // 3.1 走势图选择页
    await withRetry(() => miniProgram.navigateTo("/pages/tools/trend/index"), "navigateTo");
    await waitForPath(miniProgram, "pages/tools/trend/index");
    page = await withRetry(() => miniProgram.currentPage(), "currentPage");
    const menuData = await waitForField(page, "groups");
    const menuGroups = readProp(menuData, "groups") || [];
    const menuTotal = menuGroups.reduce(function (a, g) {
      return a + (readProp(g, "items") || []).length;
    }, 0);
    record("走势图选择页 4 个彩种", menuGroups.length === 4, menuGroups.map(function (g) { return readProp(g, "name"); }).join(" / "));
    record(
      "大乐透 18 种算法",
      menuGroups.some(function (g) {
        return readProp(g, "key") === "dlt" && (readProp(g, "items") || []).length === 18;
      }),
      menuTotal + " 个算法入口"
    );
    const menuBtns = await page.$$(".tbtn");
    record("算法按钮已渲染", menuBtns.length === menuTotal, menuBtns.length + " / " + menuTotal);
    await shoot(miniProgram, "trend-menu");

    // 3.2 走势图详情页（表格）
    await withRetry(
      () => miniProgram.navigateTo("/pages/tools/trend/detail?lottery=dlt&algo=consecutive"),
      "navigateTo"
    );
    await waitForPath(miniProgram, "pages/tools/trend/detail");
    page = await withRetry(() => miniProgram.currentPage(), "currentPage");
    // 等表格算完（fav 在 rebuild 成功后才有值）
    const detailData = await waitForField(page, "fav");
    const table = readProp(detailData, "table") || {};
    const tRows = readProp(table, "rows") || [];
    const tCols = readProp(table, "columns") || [];
    const tGroups = readProp(table, "groups") || [];
    record("走势图表格有数据", tRows.length > 0, tRows.length + " 行 × " + tCols.length + " 列");
    record(
      "表头分组已渲染",
      tGroups.length > 0,
      tGroups.map(function (g) { return readProp(g, "label"); }).join(" / ")
    );
    const spanSum = tGroups.reduce(function (a, g) { return a + (readProp(g, "span") || 0); }, 0);
    record("分组跨度与列数一致", spanSum === tCols.length, spanSum + " vs " + tCols.length);

    const fixedEls = await page.$$(".tc--fix");
    record("期次/星期固定列已渲染", fixedEls.length >= 2, fixedEls.length + " 个固定列");

    // 用户报的原始问题：走势图内容横向溢出容器
    const scrollEl = await page.$(".tscroll");
    const scrollSize = scrollEl ? await scrollEl.size() : null;
    const viewWidth = readProp(detailData, "viewWidth") || 0;
    record(
      "表格区没有横向溢出",
      !!scrollSize && !!viewWidth && scrollSize.width <= viewWidth + 1,
      "容器 " + (scrollSize ? Math.round(scrollSize.width) : "?") + "px / 视口 " + viewWidth + "px"
    );

    const hitCells = await page.$$(".tc--hit");
    record("命中号码有红圈", hitCells.length > 0, hitCells.length + " 个命中");

    // 命中球的文字必须是白色（曾经是灰字：.tc.matrix 的优先级压过了 .tc--hit）
    if (hitCells.length) {
      const hitEl = hitCells[0];
      const hitColor = await hitEl.style("color");
      const hitSize = await hitEl.size();
      record(
        "命中球文字是白色",
        String(hitColor).replace(/\s/g, "") === "rgb(255,255,255)",
        "color=" + hitColor
      );
      record(
        "命中球是正圆",
        Math.round(Number(hitSize.width)) === Math.round(Number(hitSize.height)),
        hitSize.width + " × " + hitSize.height
      );
    }

    // 先按「默认状态」截图 —— 画线默认是关的，交付图要跟用户实际打开时一致
    await shoot(miniProgram, "trend");

    // 开启画线 → 线段层应该出现
    const lineBtn = await page.$$(".tbar-item");
    if (lineBtn.length >= 2) {
      await withRetry(() => lineBtn[1].tap(), "tap 开启画线");
      await new Promise(function (r) { setTimeout(r, 1200); });
      const segs = await page.$$(".tline-seg");
      record("开启画线后线段已渲染", segs.length > 0, segs.length + " 段折线");

      // 关回去，保持页面默认状态（截图已拍完，这里只是复位）
      await withRetry(() => lineBtn[1].tap(), "tap 关闭画线");
      await new Promise(function (r) { setTimeout(r, 600); });
      const segsAfter = await page.$$(".tline-seg");
      record("关闭画线后线段消失", segsAfter.length === 0, segsAfter.length + " 段残留");
    }
    await withRetry(() => miniProgram.navigateBack(), "navigateBack");
    await withRetry(() => miniProgram.navigateBack(), "navigateBack");

    // 3.2 往期开奖
    await withRetry(() => miniProgram.navigateTo("/pages/tools/history/index"), "navigateTo");
    await waitForPath(miniProgram, "pages/tools/history/index");
    page = await withRetry(() => miniProgram.currentPage(), "currentPage");
    const histData = await waitForField(page, "list");
    const histList = readProp(histData, "list");
    record(
      "往期开奖有记录",
      Array.isArray(histList) && histList.length > 0,
      histList ? histList.length + " 期（首期 " + readProp(histList[0], "period") + "）" : "无"
    );
    await shoot(miniProgram, "history");
    await withRetry(() => miniProgram.navigateBack(), "navigateBack");

    // 3.3 选号
    await withRetry(() => miniProgram.navigateTo("/pages/tools/pick/index"), "navigateTo");
    await waitForPath(miniProgram, "pages/tools/pick/index");
    page = await withRetry(() => miniProgram.currentPage(), "currentPage");
    const pickData = await waitForField(page, "groups");
    const groups = readProp(pickData, "groups");
    record(
      "选号已生成",
      Array.isArray(groups) && groups.length > 0,
      groups ? groups.length + " 组" : "无"
    );
    const groupEls = await page.$$(".pgroup");
    record("号码组已渲染", groupEls.length > 0, groupEls.length + " 组");
    await shoot(miniProgram, "pick");
    await withRetry(() => miniProgram.navigateBack(), "navigateBack");

    // 3.4 数据分析
    await withRetry(() => miniProgram.navigateTo("/pages/tools/analysis/index"), "navigateTo");
    await waitForPath(miniProgram, "pages/tools/analysis/index");
    page = await withRetry(() => miniProgram.currentPage(), "currentPage");

    // 显式切到双色球：彩种是持久化的，不切的话会继承上一个会话选中的彩种
    // （跑出来是快乐8，80 个号码），画廊里几个彩种混着不好看
    const anaTabs = await page.$$(".ltab");
    if (anaTabs.length === 4) {
      await withRetry(() => anaTabs[0].tap(), "tap 双色球");
      await new Promise(function (r) {
        setTimeout(r, 2000);
      });
      page = await withRetry(() => miniProgram.currentPage(), "currentPage");
    }

    const anaData = await waitForField(page, "freqRows");
    const freqRows = readProp(anaData, "freqRows");
    record("吉号分析频次表", Array.isArray(freqRows) && freqRows.length > 0, freqRows ? freqRows.length + " 个号码" : "无");
    record("分析页彩种为双色球", readProp(anaData, "lotteryKey") === "ssq", "lotteryKey=" + readProp(anaData, "lotteryKey"));
    await shoot(miniProgram, "analysis");

    const segs = await page.$$(".lseg-item");
    if (segs.length >= 3) {
      await withRetry(() => segs[1].tap(), "tap 智能规律");
      await new Promise(function (r) {
        setTimeout(r, 1200);
      });
      const pats = await dataOf(page);
      const patterns = readProp(pats, "patterns") || [];
      record("智能规律已产出", patterns.length > 0, patterns.length + " 条规律");
      await shoot(miniProgram, "analysis-pattern");

      await withRetry(() => segs[2].tap(), "tap 选号分布");
      await new Promise(function (r) {
        setTimeout(r, 1200);
      });
      const dist = await dataOf(page);
      record("选号分布已产出", (readProp(dist, "zones") || []).length > 0, (readProp(dist, "zones") || []).length + " 个区间");
      await shoot(miniProgram, "analysis-dist");
    }
    await withRetry(() => miniProgram.navigateBack(), "navigateBack");

    /* ============ 4. 底部 tab（首页 / 开奖 / 我的） ============ */
    console.log("");
    console.log("4) 底部 tab");

    // 4.1 tab 配置
    const appJson = JSON.parse(readFileSync(join(projectRoot, "miniprogram", "app.json"), "utf8"));
    const tabList = (appJson.tabBar && appJson.tabBar.list) || [];
    record(
      "底部 tab 配置 3 项",
      tabList.length === 3 && tabList[0].text === "首页" && tabList[1].text === "开奖" && tabList[2].text === "我的",
      tabList.map(function (t) { return t.text; }).join(" / ")
    );
    const iconMissing = tabList.filter(function (t) {
      return !existsSync(join(projectRoot, "miniprogram", t.iconPath)) || !existsSync(join(projectRoot, "miniprogram", t.selectedIconPath));
    });
    record("tab 图标齐全", iconMissing.length === 0, iconMissing.length ? "缺 " + iconMissing.length + " 个" : tabList.length * 2 + " 个文件");

    // 4.2 开奖页
    await withRetry(() => miniProgram.switchTab("/pages/draws/index"), "switchTab 开奖");
    const drawsPath = await waitForPath(miniProgram, "pages/draws/index");
    record("开奖页已打开", drawsPath === "pages/draws/index", drawsPath);

    page = await withRetry(() => miniProgram.currentPage(), "currentPage");
    const drawsData = await waitForField(page, "list");
    const drawTabs = await page.$$(".ltab");
    const drawRows = await page.$$(".dcard");
    const drawBalls = await page.$$(".dball");
    record("开奖页 4 个彩种", drawTabs.length === 4, drawTabs.length + " 个");
    record("开奖记录有数据", drawRows.length > 0, drawRows.length + " 期");
    record("开奖号码球已渲染", drawBalls.length > 0, drawBalls.length + " 个球");
    await shoot(miniProgram, "draws");

    // 4.3 我的页
    await withRetry(() => miniProgram.switchTab("/pages/mine/index"), "switchTab 我的");
    const minePath = await waitForPath(miniProgram, "pages/mine/index");
    record("我的页已打开", minePath === "pages/mine/index", minePath);

    page = await withRetry(() => miniProgram.currentPage(), "currentPage");
    await new Promise(function (r) { setTimeout(r, 1500); });

    // 先退出登录，保证每次都跑完整的授权流程
    const logoutEl = await page.$(".mlogout");
    if (logoutEl) {
      await withRetry(() => logoutEl.tap(), "tap 退出登录");
      await new Promise(function (r) { setTimeout(r, 1200); });
    }

    // 未登录的授权卡长什么样 —— 单独存一份，登录后那张就被覆盖了
    await shoot(miniProgram, "mine-auth");

    // 授权控件必须齐全
    const pickBtn = await page.$(".mavatar-pick");
    const nickInput = await page.$(".mfield-input");
    const loginBtn = await page.$(".mlogin-btn");
    record("授权头像按钮已渲染", !!pickBtn, pickBtn ? "有" : "无");
    record("昵称输入框已渲染", !!nickInput, nickInput ? "有" : "无");
    record("授权登录按钮已渲染", !!loginBtn, loginBtn ? "有" : "无");

    // 头像圆环必须是正圆 —— button 默认样式曾把 176rpx 的圆撑成 184×91 的椭圆
    const ring = await page.$(".mavatar-ring");
    if (ring) {
      const rs = await ring.size();
      const rw = parseFloat(rs.width);
      const rh = parseFloat(rs.height);
      record("头像圆环是正圆", isFinite(rw) && isFinite(rh) && Math.abs(rw - rh) < 1, rw + " × " + rh);
    }

    // 头像必须走 open-type="chooseAvatar"（wx.getUserProfile 已废弃，
    // 只有这个 button 能拿到用户自己的头像）
    if (pickBtn) {
      const openType = await pickBtn.attribute("open-type");
      record("头像按钮是 chooseAvatar", openType === "chooseAvatar", openType);
    }

    // 填昵称 —— 模拟用户填写
    const NICK = "彩友1234";
    if (nickInput) {
      await nickInput.input(NICK);
      await new Promise(function (r) { setTimeout(r, 400); });
      const draftData = await dataOf(page);
      record("昵称已填入", readProp(draftData, "nicknameDraft") === NICK, readProp(draftData, "nicknameDraft"));
    }

    // 点授权登录
    if (loginBtn) {
      await withRetry(() => loginBtn.tap(), "tap 微信授权登录");
      // 云函数登录 + 拉记录，给足时间
      await new Promise(function (r) { setTimeout(r, 4500); });
    }

    const mineData = await dataOf(page);
    const profile = readProp(mineData, "profile") || {};
    const records = readProp(mineData, "records") || [];
    record("微信登录授权成功", readProp(mineData, "logged") === true && !!readProp(profile, "maskedOpenid"), "openid=" + (readProp(profile, "maskedOpenid") || "无"));
    record("昵称已存为数据", readProp(profile, "nickname") === NICK, "nickname=" + (readProp(profile, "nickname") || "无"));

    // 头像占位要显示昵称首字 —— WXML 里不能调 .slice()，必须在 JS 里算好
    const initialEl = await page.$(".mavatar--empty");
    if (initialEl) {
      const initialText = (await initialEl.text()) || "";
      record("头像占位显示昵称首字", initialText === NICK.slice(0, 1), "显示=" + initialText);
    }
    record("模拟选号记录已加载", records.length > 0, records.length + " 条");

    const recEls = await page.$$(".mrec");
    const recBalls = await page.$$(".mball");
    record("记录卡片已渲染", recEls.length > 0, recEls.length + " 张");
    record("记录里的号码球已渲染", recBalls.length > 0, recBalls.length + " 个球");
    await shoot(miniProgram, "mine");

    // 4.4 回首页
    await withRetry(() => miniProgram.switchTab("/pages/index/index"), "switchTab 首页");
    const backHomePath = await waitForPath(miniProgram, "pages/index/index");
    record("切回首页", backHomePath === "pages/index/index", backHomePath);
    await shoot(miniProgram, "home");

    /* ============ 5. AI 设置（客户端直连模型） ============ */
    console.log("");
    console.log("5) AI 设置");

    // 5.1 「我的」页有入口
    await withRetry(() => miniProgram.switchTab("/pages/mine/index"), "switchTab 我的");
    await waitForPath(miniProgram, "pages/mine/index");
    const minePage = await withRetry(() => miniProgram.currentPage(), "currentPage");
    const aiEntry = await minePage.$(".msetting");
    record("AI 设置入口已渲染", !!aiEntry, aiEntry ? "有" : "无");

    // 5.2 进设置页
    if (aiEntry) {
      await withRetry(() => aiEntry.tap(), "tap AI 设置");
      await new Promise(function (r) { setTimeout(r, 2500); });
    }
    const aiPage = await withRetry(() => miniProgram.currentPage(), "currentPage");
    const aiPath = await pathOf(aiPage);
    record("AI 设置页已打开", aiPath === "pages/tools/ai-settings/index", aiPath);

    let aiData = await dataOf(aiPage);
    const aiBaseUrl = readProp(aiData, "baseUrl") || "";
    record("AI 端点已填", aiBaseUrl.indexOf("api.minimaxi.com") > -1, aiBaseUrl);
    const aiModelNames = readProp(aiData, "modelNames") || [];
    record("模型列表已加载", aiModelNames.length >= 2, aiModelNames.length + " 个");

    // 5.3 拉服务端预置配置（云函数 getAIConfig）
    const presetBtn = await aiPage.$(".apreset");
    if (presetBtn) {
      await withRetry(() => presetBtn.tap(), "tap 拉取预置配置");
      await new Promise(function (r) { setTimeout(r, 4500); });
    }
    aiData = await dataOf(aiPage);
    record(
      "预置配置已拉取",
      readProp(aiData, "hasKey") === true,
      "key 长度 " + (readProp(aiData, "apiKey") || "").length
    );

    // 5.4 多配置：最多 3 套，可切换
    // 注意测完要把状态还原 —— 后面 5.5 的真实调用依赖「当前那套有密钥」
    const origConfigs = readProp(aiData, "configs") || [];
    const origCount = origConfigs.length;
    const origActiveId = readProp(aiData, "activeId") || "";

    for (let i = 0; i < 3; i++) {
      const addBtn = await aiPage.$(".acfg--add");
      if (!addBtn) break;
      await withRetry(() => addBtn.tap(), "tap 新增配置");
      await new Promise(function (r) { setTimeout(r, 1200); });
    }
    aiData = await dataOf(aiPage);
    const cfgList = readProp(aiData, "configs") || [];
    record("配置最多 3 套", cfgList.length === 3, cfgList.length + " 套");
    record("第 4 套加不了", !(await aiPage.$(".acfg--add")), "新增按钮已隐藏");

    // 切到第 1 套
    const cfgCards = await aiPage.$$(".acfg-item");
    if (cfgCards.length) {
      await withRetry(() => cfgCards[0].tap(), "tap 第 1 套配置");
      await new Promise(function (r) { setTimeout(r, 1200); });
    }
    aiData = await dataOf(aiPage);
    const afterSwitch = readProp(aiData, "configs") || [];
    record(
      "能切换当前配置",
      afterSwitch.length > 0 && readProp(afterSwitch[0], "active") === true,
      "当前 = " + (readProp(aiData, "configName") || "")
    );

    // 还原：删到原来的套数，再把当前切回原来那套
    for (let i = 0; i < 4; i++) {
      aiData = await dataOf(aiPage);
      const list = readProp(aiData, "configs") || [];
      if (list.length <= origCount) break;
      // 选中最后一套，再删掉它
      const items = await aiPage.$$(".acfg-item");
      const lastIdx = list.length - 1;
      if (items[lastIdx]) {
        await withRetry(() => items[lastIdx].tap(), "tap 最后一套配置");
        await new Promise(function (r) { setTimeout(r, 1000); });
      }
      const delBtns = await aiPage.$$(".abtn");
      for (let j = 0; j < delBtns.length; j++) {
        const t = await delBtns[j].text();
        if (t && t.indexOf("删除当前配置") > -1) {
          await withRetry(() => delBtns[j].tap(), "tap 删除当前配置");
          await new Promise(function (r) { setTimeout(r, 1200); });
          break;
        }
      }
    }
    // 切回原来那套
    aiData = await dataOf(aiPage);
    const finalList = readProp(aiData, "configs") || [];
    let restoreIdx = -1;
    for (let i = 0; i < finalList.length; i++) {
      if (readProp(finalList[i], "id") === origActiveId) {
        restoreIdx = i;
        break;
      }
    }
    if (restoreIdx > -1) {
      const restore = await aiPage.$$(".acfg-item");
      if (restore[restoreIdx]) {
        await withRetry(() => restore[restoreIdx].tap(), "tap 恢复原配置");
        await new Promise(function (r) { setTimeout(r, 1000); });
      }
    }
    aiData = await dataOf(aiPage);
    record(
      "配置状态已还原",
      (readProp(aiData, "configs") || []).length === origCount &&
        readProp(aiData, "activeId") === origActiveId,
      (readProp(aiData, "configs") || []).length + " 套"
    );

    // 5.5 测试连接 —— 真实调一次模型（这一步依赖外网和额度）
    const aiBtns = await aiPage.$$(".lbtn");
    let testBtn = null;
    for (let i = 0; i < aiBtns.length; i++) {
      const t = await aiBtns[i].text();
      if (t && t.indexOf("测试连接") > -1) {
        testBtn = aiBtns[i];
        break;
      }
    }
    if (testBtn) {
      await withRetry(() => testBtn.tap(), "tap 测试连接");
      // 模型要思考几秒，轮询等结果
      const deadline = Date.now() + 45000;
      let reply = "";
      while (Date.now() < deadline) {
        await new Promise(function (r) { setTimeout(r, 2000); });
        aiData = await dataOf(aiPage);
        reply = readProp(aiData, "result") || "";
        if (reply || readProp(aiData, "error")) break;
      }
      const aiErr = readProp(aiData, "error") || "";
      record(
        "模型调用成功",
        !!reply && !aiErr,
        aiErr ? "失败：" + aiErr : reply.slice(0, 30)
      );

      const resultEls = await aiPage.$$(".aresult");
      record("模型回复已渲染", resultEls.length > 0, resultEls.length + " 块");
    }

    await shoot(miniProgram, "ai-settings");

    // 5.5 回首页
    await withRetry(() => miniProgram.navigateBack(), "navigateBack");
    await new Promise(function (r) { setTimeout(r, 1200); });

    /* ============ 6. AI 分析（统计指标 + 真实模型解读） ============ */
    console.log("");
    console.log("6) AI 分析");

    // 6.1 从首页工具箱进 AI 分析
    await withRetry(() => miniProgram.switchTab("/pages/index/index"), "switchTab 首页");
    await waitForPath(miniProgram, "pages/index/index");
    const homePage = await withRetry(() => miniProgram.currentPage(), "currentPage");
    const toolItems = await homePage.$$(".tool-item");
    record("工具箱 8 个工具", toolItems.length === 8, toolItems.length + " 个");

    let aiTool = null;
    for (let i = 0; i < toolItems.length; i++) {
      const t = await toolItems[i].text();
      if (t && t.indexOf("AI") > -1) {
        aiTool = toolItems[i];
        break;
      }
    }
    record("工具箱有 AI 分析入口", !!aiTool, aiTool ? "有" : "无");

    if (aiTool) {
      await withRetry(() => aiTool.tap(), "tap AI 分析");
      await new Promise(function (r) { setTimeout(r, 3500); });
    }
    const aaPage = await withRetry(() => miniProgram.currentPage(), "currentPage");
    const aaPath = await pathOf(aaPage);
    record("AI 分析页已打开", aaPath === "pages/tools/ai-analysis/index", aaPath);

    // 指标是云函数返回后异步算出来的，冷启动可能要好几秒，等它就位再断言
    let aaData = await waitForField(aaPage, "stats", 25000);
    const aaStats = readProp(aaData, "stats") || [];
    record("统计指标已算出", aaStats.length === 8, aaStats.length + " 条");
    const aaPrompt = readProp(aaData, "promptText") || "";
    record("prompt 已生成", aaPrompt.length > 200, aaPrompt.length + " 字");
    const aaHot = readProp(aaData, "hot") || [];
    record("冷热号已算出", aaHot.length === 5, aaHot.length + " 个");

    // 6.2 换彩种会重算
    const aaTabs = await aaPage.$$(".ltab");
    for (let i = 0; i < aaTabs.length; i++) {
      const t = await aaTabs[i].text();
      if (t && t.indexOf("大乐透") > -1) {
        await aaTabs[i].tap();
        break;
      }
    }
    await new Promise(function (r) { setTimeout(r, 3000); });
    // 不只看 lotteryKey：等 prompt 真的换成大乐透，才算「重算过」
    aaData = await waitForData(
      aaPage,
      function (d) {
        return readProp(d, "lotteryKey") === "dlt" && (readProp(d, "promptText") || "").indexOf("大乐透") > -1;
      },
      25000
    );
    record(
      "切换彩种会重算",
      readProp(aaData, "lotteryKey") === "dlt" && (readProp(aaData, "promptText") || "").indexOf("大乐透") > -1,
      readProp(aaData, "lotteryKey") + " / " + (readProp(aaData, "promptText") || "").slice(0, 14)
    );

    // 换回双色球
    const aaTabs2 = await aaPage.$$(".ltab");
    for (let i = 0; i < aaTabs2.length; i++) {
      const t = await aaTabs2[i].text();
      if (t && t.indexOf("双色球") > -1) {
        await aaTabs2[i].tap();
        break;
      }
    }
    await new Promise(function (r) { setTimeout(r, 3000); });
    // 等 prompt 换回双色球（双色球走本地缓存，重算是同步的）
    aaData = await waitForData(
      aaPage,
      function (d) {
        return readProp(d, "lotteryKey") === "ssq" && (readProp(d, "promptText") || "").indexOf("双色球") > -1;
      },
      15000
    );

    // 6.3 期数上限 500 期（云库每个彩种已回填到 500 期）
    const aaPeriods = readProp(aaData, "periods") || [];
    record("期数选项到 500 期", aaPeriods.indexOf(500) > -1, aaPeriods.join(" / "));

    const aaSegs = await aaPage.$$(".lseg-item");
    let pick500 = null;
    for (let i = 0; i < aaSegs.length; i++) {
      const t = (await aaSegs[i].text()).replace(/\s+/g, "");
      if (t.indexOf("500期") > -1) {
        pick500 = aaSegs[i];
        break;
      }
    }
    if (pick500) {
      await withRetry(() => pick500.tap(), "tap 近 500 期");
      await new Promise(function (r) { setTimeout(r, 2500); });
    }
    aaData = await waitForData(
      aaPage,
      function (d) {
        return (readProp(d, "promptText") || "").indexOf("近 500 期") > -1;
      },
      20000
    );
    const aaPrompt500 = readProp(aaData, "promptText") || "";
    const aaRange = aaPrompt500.match(/【统计区间】([^\n]+)/);
    record(
      "500 期真能取到",
      aaPrompt500.indexOf("近 500 期") > -1,
      aaRange ? aaRange[1] : aaPrompt500.slice(0, 40)
    );
    record("500 期 prompt 没变长", aaPrompt500.length < 900, aaPrompt500.length + " 字（100 期时是 605 字）");

    // 6.4 真实生成一次分析（模型可能要思考半分钟）
    // 先拍一张「页面顶部」—— 参数 + 8 个指标
    await shoot(miniProgram, "ai-analysis-top");

    const aaBtns = await aaPage.$$(".lbtn");
    let genBtn = null;
    for (let i = 0; i < aaBtns.length; i++) {
      const t = await aaBtns[i].text();
      if (t && t.indexOf("生成 AI 分析") > -1) {
        genBtn = aaBtns[i];
        break;
      }
    }
    if (genBtn) {
      await withRetry(() => genBtn.tap(), "tap 生成 AI 分析");
      const deadline = Date.now() + 90000;
      let reply = "";
      while (Date.now() < deadline) {
        await new Promise(function (r) { setTimeout(r, 2500); });
        aaData = await dataOf(aaPage);
        reply = readProp(aaData, "result") || "";
        if (reply || readProp(aaData, "error")) break;
      }
      const aaErr = readProp(aaData, "error") || "";
      record(
        "AI 分析生成成功",
        !!reply && !aaErr,
        aaErr ? "失败：" + aaErr : reply.slice(0, 24) + "…（" + reply.length + " 字）"
      );

      const aaResultEls = await aaPage.$$(".aaresult");
      record("AI 解读已渲染", aaResultEls.length > 0, aaResultEls.length + " 块");
    }

    // 「AI 解读」在按钮下面，滚到底再拍才看得到按钮 + 解读正文
    try {
      await miniProgram.callWxMethod("pageScrollTo", { scrollTop: 99999, duration: 0 });
      await new Promise(function (r) { setTimeout(r, 1200); });
    } catch (e) {
      console.log("     (滚动到底失败：" + ((e && e.message) || e) + ")");
    }
    await shoot(miniProgram, "ai-analysis");

    // 6.4 回首页
    await withRetry(() => miniProgram.navigateBack(), "navigateBack");
    await new Promise(function (r) { setTimeout(r, 1200); });

    /* ============ 7. 环境自检页 ============ */
    console.log("");
    console.log("7) 环境自检页");
    await withRetry(() => miniProgram.reLaunch("/pages/debug/index"), "reLaunch");
    const debugPath = await waitForPath(miniProgram, "pages/debug/index");
    record("自检页已打开", debugPath === "pages/debug/index", debugPath);

    page = await withRetry(() => miniProgram.currentPage(), "currentPage");
    data = await waitForLoadingDone(page);
    const checks = readProp(data, "checks") || [];
    const summary = readProp(data, "summary") || {};
    const lotteries = readProp(data, "lotteries") || [];
    const synced = lotteries.filter(function (l) {
      return readProp(l, "latestPeriod");
    });

    record("检查项已生成", checks.length === 7, checks.length + " 项");
    record(
      "汇总与条目数一致",
      readProp(summary, "total") === checks.length,
      "total=" + readProp(summary, "total") + " / checks=" + checks.length
    );
    record("无异常项", readProp(summary, "fail") === 0, "fail=" + readProp(summary, "fail") + " / todo=" + readProp(summary, "todo"));
    record("四个彩种已同步", synced.length === 4, synced.length + "/4 已入库");
    record("数据源探测有结果", !!readProp(data, "sourceText"), readProp(data, "sourceText") || "空");
    record("自动更新已执行", !!readProp(data, "autoText"), readProp(data, "autoText") || "空");

    const debugRows = await page.$$(".check-row");
    record("检查项行已渲染", debugRows.length === 7, debugRows.length + " 行");
    await shoot(miniProgram, "debug");
  } finally {
    try {
      await miniProgram.disconnect();
    } catch (e) {
      /* ignore */
    }
  }

  const failed = results.filter(function (r) {
    return !r.ok;
  });
  console.log("");
  console.log("=".repeat(52));
  console.log("验证完成：" + (results.length - failed.length) + "/" + results.length + " 项通过");
  if (failed.length) {
    failed.forEach(function (f) {
      console.log("  未通过：" + f.name + " -> " + f.detail);
    });
    process.exit(1);
  }
}

main().catch(function (err) {
  console.error("");
  console.error("验证中断: " + err.message);
  process.exit(1);
});
