/**
 * 把小程序各页面的设计图合成一个 .pen 画廊
 *
 * 为什么不用 pen CLI 出稿：CLI 跑一轮要 3~5 分钟，而且 agent 会自作主张
 * 加东西。这里直接生成 .pen JSON —— 结构完全可控，几秒钟出结果。
 *
 * 关键点（都是踩过的坑）：
 *   1. .pen 里没有 "image" 这种节点类型。图片是 **frame 的 fill**：
 *      { type:"frame", fill:{ type:"image", url:"xxx.png", mode:"fill" } }
 *      直接 Insert 一个 {type:"image"} 节点会报 Unknown node type。
 *   2. url 用**相对路径**，基准是 .pen 文件自己所在的目录。
 *      （证据：newobj2\Wasteland Scavenger\大厅页面设计.pen 里写的是
 *      "./images/generated-xxx.png"，图片确实在同级的 images\ 下）
 *   3. 圆角靠 frame 的 cornerRadius 裁(fill 会被裁到圆角内)。
 *   4. 变量名不能以 $ 开头，$ 只是引用时的前缀。
 *
 * 用法：
 *   node build-pen-gallery.js [--project <项目根>] [--out <输出.pen>]
 */
const { readFileSync, writeFileSync, existsSync } = require("node:fs");
const { join, resolve, basename } = require("node:path");

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const projectRoot = resolve(arg("--project", join(__dirname, "..")));
const designDir = join(projectRoot, "design");
const outFile = resolve(arg("--out", join(designDir, "all-pages.pen")));
const sourcePen = join(designDir, "home.pen");

/* ------------------------------------------------------------------ *
 * 画廊内容：顺序 = 展示顺序
 * file   图片（相对 design/ 的路径）
 * name   标题
 * desc   副标题（一句话说明这一屏干什么）
 * route  对应的页面路由
 * ------------------------------------------------------------------ */
const CELLS = [
  {
    file: "home.png",
    files: ["home.png", "screenshot-home.png"],
    name: "01 · 首页",
    desc: "左=pen.dev 设计稿，右=代码实拍；下面的色值和间距都是从左这张稿子里提取的",
    route: "design/home.pen ↔ pages/index/index",
  },
  {
    file: "screenshot-draws.png",
    name: "02 · 开奖",
    desc: "底部 tab 第二个入口：四个彩种的全部开奖号码，可加载更多",
    route: "pages/draws/index",
  },
  {
    file: "screenshot-mine.png",
    files: ["screenshot-mine.png", "screenshot-mine-auth.png"],
    name: "03 · 我的",
    desc: "底部 tab 第三个入口：左=已登录（昵称头像来自用户自己），右=未登录时的授权卡",
    route: "pages/mine/index",
  },
  {
    file: "screenshot-ai-settings.png",
    name: "04 · AI 设置",
    desc: "最多 3 套模型配置可切换；模型 / 端点 / 密钥 / 温度 / 分析风格，客户端直连 MiniMax",
    route: "pages/tools/ai-settings/index",
  },
  {
    file: "screenshot-ai-analysis-top.png",
    files: [
      "screenshot-ai-analysis-top.png",
      "screenshot-ai-analysis-btn.png",
      "screenshot-ai-analysis.png",
    ],
    name: "05 · AI 分析",
    desc: "左=参数 + 8 个统计指标（一次最多取 500 期），中=「生成 AI 分析」按钮（文字居中），右=模型解读正文",
    route: "pages/tools/ai-analysis/index",
  },
  {
    file: "screenshot-trend-menu.png",
    name: "06 · 走势图选择页",
    desc: "全国 / 地方 两个范围，按彩种分组列出全部走势算法",
    route: "pages/tools/trend/index",
  },
  {
    file: "screenshot-trend.png",
    name: "07 · 走势图详情页",
    desc: "期次/星期固定列 + 号码遗漏矩阵，命中红圈，底部可开画线",
    route: "pages/tools/trend/detail",
  },
  {
    file: "screenshot-history.png",
    name: "08 · 往期开奖",
    desc: "历史期次表格，20 条 / 页，最多 300 期",
    route: "pages/tools/history/index",
  },
  {
    file: "screenshot-pick.png",
    name: "09 · 幸运选号 / 模拟选号",
    desc: "三种策略：热号优先 / 纯随机 / 按历史形态过滤，生成后自动存入「我的」",
    route: "pages/tools/pick/index",
  },
  {
    file: "screenshot-analysis.png",
    name: "10 · 吉号分析",
    desc: "频次 / 当前遗漏 / 和值 / 跨度 / 奇偶比 / 大小比",
    route: "pages/tools/analysis/index?mode=lucky",
  },
  {
    file: "screenshot-analysis-pattern.png",
    name: "11 · 智能规律",
    desc: "自动发现 8 类规律，每条带出现概率",
    route: "pages/tools/analysis/index?mode=pattern",
  },
  {
    file: "screenshot-analysis-dist.png",
    name: "12 · 选号分布",
    desc: "区间分布 + 尾数分布",
    route: "pages/tools/analysis/index?mode=dist",
  },
  {
    file: "screenshot-debug.png",
    name: "13 · 环境自检",
    desc: "云函数 / 数据源 / 同步状态诊断页",
    route: "pages/debug/index",
  },
];

/* ------------------------- 画布排版参数 ------------------------- */
const PHONE_W = 375;
const PHONE_H = 812;
/* 13 格排 4×4（最后一行放「环境自检」），比 5 列的 5+5+2 齐整 */
const COLS = 4;
const GAP_X = 32;
const GAP_ROW = 40;
/* 同一格里并排多张手机截图（比如「我的」的两个状态）时的间距 */
const PHONE_GAP = 24;
const PAD_X = 64;
const PAD_TOP = 48;
const PAD_BOTTOM = 64;
const HEAD_GAP = 32;
const LABEL_H = 20;
const LABEL_GAP = 10;
const CAPTION_GAP = 10;
const CAPTION_H = 18;

/* ------------------------- 小工具 ------------------------- */
const IDS = new Set();
function nid() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let id = "";
  do {
    id = "";
    for (let i = 0; i < 5; i++) id += chars[Math.floor(Math.random() * chars.length)];
  } while (IDS.has(id));
  IDS.add(id);
  return id;
}

function text(name, content, size, weight, fill, extra) {
  return Object.assign(
    {
      type: "text",
      id: nid(),
      name: name,
      fill: fill,
      content: content,
      fontFamily: "$fontcn",
      fontSize: size,
      fontWeight: weight,
    },
    extra || {}
  );
}

function frame(name, props, children) {
  const node = Object.assign({ type: "frame", id: nid(), name: name }, props || {});
  if (children && children.length) node.children = children;
  return node;
}

/* ------------------------- 主流程 ------------------------- */
if (!existsSync(sourcePen)) {
  console.error("找不到 " + sourcePen + "（设计 token 的来源）");
  process.exit(2);
}

const missing = [];
CELLS.forEach(function (c) {
  (c.files || [c.file]).forEach(function (f) {
    if (!existsSync(join(designDir, f))) missing.push(f);
  });
});
if (missing.length) {
  console.error("缺少图片：");
  missing.forEach(function (m) {
    console.error("  " + m);
  });
  process.exit(2);
}

// token 变量直接沿用 home.pen，这样 $bg / $ink / $fontcn 都能解析
const srcJson = JSON.parse(readFileSync(sourcePen, "utf8"));
const variables = srcJson.variables || {};

/** 一个手机外框 */
function phoneFrame(cell, file) {
  return frame(
    "手机 · " + cell.name.replace(/^\d+ · /, "") + " · " + file.replace(/^screenshot-|\.png$/g, ""),
    {
      width: PHONE_W,
      height: PHONE_H,
      fill: {
        type: "image",
        enabled: true,
        url: "./" + file,
        mode: "fill",
      },
      cornerRadius: 28,
      stroke: "#e6e8ec",
      strokeWidth: 1,
      effect: {
        type: "shadow",
        shadowType: "outer",
        color: "#1b1e2314",
        offset: { x: 0, y: 8 },
        blur: 24,
      },
    }
  );
}

/** 一格的宽度：并排 n 张手机就是 n 倍宽 */
function cellWidth(cell) {
  const n = (cell.files || [cell.file]).length;
  return n * PHONE_W + (n - 1) * PHONE_GAP;
}

/* 组装每一格 */
function buildCell(cell) {
  const files = cell.files || [cell.file];
  const phoneRow = frame(
    "手机组 · " + cell.name,
    {
      layout: "horizontal",
      gap: PHONE_GAP,
      alignItems: "flex_start",
    },
    files.map(function (f) {
      return phoneFrame(cell, f);
    })
  );

  return frame(
    "格 · " + cell.name,
    {
      width: cellWidth(cell),
      layout: "vertical",
      gap: CAPTION_GAP,
      alignItems: "flex_start",
    },
    [
      text("标题", cell.name, 14, "bold", "$ink"),
      text("说明", cell.desc, 11, "normal", "$ink3", {
        width: cellWidth(cell),
        lineHeight: 1.35,
      }),
      phoneRow,
      text("路由", cell.route, 10, "normal", "$ink3"),
    ]
  );
}

const rows = [];
for (let i = 0; i < CELLS.length; i += COLS) {
  const slice = CELLS.slice(i, i + COLS);
  rows.push(
    frame(
      "第 " + (rows.length + 1) + " 行",
      {
        width: "fill_container",
        gap: GAP_X,
        alignItems: "flex_start",
      },
      slice.map(buildCell)
    )
  );
}

const cellHeight =
  LABEL_H + CAPTION_GAP + 26 /* 说明两行 */ + CAPTION_GAP + PHONE_H + CAPTION_GAP + CAPTION_H;

const headHeight = 40 + 10 + 20;
/* 画布宽度取最宽的一行（「我的」那格是双状态，比别的格宽） */
let rowContentW = 0;
for (let i = 0; i < CELLS.length; i += COLS) {
  const slice = CELLS.slice(i, i + COLS);
  const w =
    slice.reduce(function (sum, c) {
      return sum + cellWidth(c);
    }, 0) + (slice.length - 1) * GAP_X;
  if (w > rowContentW) rowContentW = w;
}
const totalW = PAD_X * 2 + rowContentW;
const totalH =
  PAD_TOP + headHeight + HEAD_GAP + rows.length * cellHeight + (rows.length - 1) * GAP_ROW + PAD_BOTTOM;

const root = frame(
  "彩票预测 · 全页面设计",
  {
    x: 0,
    y: 0,
    width: totalW,
    height: totalH,
    fill: "$bg",
    layout: "vertical",
    gap: 0,
    padding: [PAD_TOP, PAD_X, PAD_BOTTOM, PAD_X],
    clip: true,
  },
  [
    frame(
      "标题区",
      {
        width: "fill_container",
        layout: "vertical",
        gap: 10,
        alignItems: "flex_start",
      },
      [
        text("大标题", "彩票预测小程序 · 全页面设计预览", 30, "bold", "$ink"),
        text(
          "副标题",
          "底部 tab 三页（首页 / 开奖 / 我的）+ 7 个工具页（含 AI 设置 / AI 分析）+ 环境自检，" +
            "共 11 个页面 + 1 张设计稿 · 375×812 · 数据来自官方开奖接口",
          14,
          "normal",
          "$ink2"
        ),
      ]
    ),
    ...rows,
  ]
);

const out = {
  version: srcJson.version || "2.21",
  children: [root],
  variables: variables,
  fileToken: require("node:crypto").randomUUID(),
};

writeFileSync(outFile, JSON.stringify(out, null, 2), "utf8");

console.log("画廊已生成");
console.log("  输出      : " + outFile);
console.log("  画布      : " + totalW + " × " + totalH);
console.log("  画格      : " + CELLS.length + " 张（" + rows.length + " 行）");
console.log("  图片      : " + CELLS.map(function (c) { return (c.files || [c.file]).join("+"); }).join(", "));
