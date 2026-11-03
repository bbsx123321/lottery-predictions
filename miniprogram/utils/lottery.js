/**
 * 彩种元信息 + 号码规则 —— 前端唯一定义处
 *
 * 规则必须和云端 cloudfunctions/api/sources.js 的 LOTTERIES 保持一致：
 * 号码个数、取值范围、有序性对不上，渲染出来的球就会错。
 */

/** 支持的彩种（顺序即顶部切换菜单顺序） */
const LOTTERIES = [
  {
    key: "ssq",
    name: "双色球",
    badge: "福彩",
    mainLabel: "红球",
    extraLabel: "蓝球",
    mainCount: 6,
    mainMin: 1,
    mainMax: 33,
    extraCount: 1,
    extraMin: 1,
    extraMax: 16,
    // 号码是集合，展示时升序
    ordered: false,
    ballMain: "red",
    ballExtra: "blue",
  },
  {
    key: "fc3d",
    name: "福彩3D",
    badge: "福彩",
    mainLabel: "号码",
    extraLabel: "",
    mainCount: 3,
    mainMin: 0,
    mainMax: 9,
    extraCount: 0,
    extraMin: 0,
    extraMax: 0,
    // 百/十/个位有位置意义，保留开奖顺序
    ordered: true,
    ballMain: "red",
    ballExtra: "blue",
  },
  {
    key: "kl8",
    name: "快乐8",
    badge: "福彩",
    mainLabel: "号码",
    extraLabel: "",
    mainCount: 20,
    mainMin: 1,
    mainMax: 80,
    extraCount: 0,
    extraMin: 0,
    extraMax: 0,
    ordered: false,
    ballMain: "red",
    ballExtra: "blue",
  },
  {
    key: "dlt",
    name: "大乐透",
    badge: "体彩",
    mainLabel: "前区",
    extraLabel: "后区",
    mainCount: 5,
    mainMin: 1,
    mainMax: 35,
    extraCount: 2,
    extraMin: 1,
    extraMax: 12,
    ordered: false,
    ballMain: "red",
    ballExtra: "blue",
  },
];

/** 按 key 取彩种元信息 */
function meta(key) {
  for (let i = 0; i < LOTTERIES.length; i++) {
    if (LOTTERIES[i].key === key) return LOTTERIES[i];
  }
  return LOTTERIES[0];
}

/** 两位补零，号码球上的数字用 */
function pad2(n) {
  const s = String(n);
  return s.length >= 2 ? s : "0" + s;
}

/**
 * 把一条开奖记录拆成渲染用的球数组。
 * @param {object} draw 开奖记录 {numbers:[], extras:[]}
 * @returns {{main:Array, extra:Array}} 每项 {n:number, text:string}
 */
function ballsOf(draw) {
  const main = (draw && draw.numbers) || [];
  const extra = (draw && draw.extras) || [];
  return {
    main: main.map(function (n) {
      return { n: n, text: pad2(n) };
    }),
    extra: extra.map(function (n) {
      return { n: n, text: pad2(n) };
    }),
  };
}

/** 号码区全部取值（主区 + 副区），做统计分析时用 */
function allNumbers(draw) {
  const main = (draw && draw.numbers) || [];
  const extra = (draw && draw.extras) || [];
  return main.concat(extra);
}

/** 该彩种一次要选几个号（幸运选号 / 模拟选号用） */
function pickCount(m) {
  return m.mainCount + m.extraCount;
}

/**
 * 从 [min,max] 里随机取 count 个不重复号。
 * 有序彩种（3D）保持随机顺序，其余升序。
 */
function randomNumbers(m, count, random) {
  const rnd = random || Math.random;
  const pool = [];
  for (let i = m.mainMin; i <= m.mainMax; i++) pool.push(i);
  const picked = [];
  const need = Math.min(count, pool.length);
  for (let i = 0; i < need; i++) {
    const idx = Math.floor(rnd() * pool.length);
    picked.push(pool.splice(idx, 1)[0]);
  }
  return m.ordered ? picked : picked.sort(function (a, b) { return a - b; });
}

module.exports = {
  LOTTERIES: LOTTERIES,
  meta: meta,
  pad2: pad2,
  ballsOf: ballsOf,
  allNumbers: allNumbers,
  pickCount: pickCount,
  randomNumbers: randomNumbers,
};
