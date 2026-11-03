/**
 * 走势图算法层 —— 36 种走势算法
 *
 * 所有算法最终都产出同一种**表格结构**，页面只管渲染：
 *
 *   {
 *     groups : [{ label, span }]      表头第一行（分区标题）
 *     columns: [{ label, kind, key }]  表头第二行（列标题）
 *     rows   : [{ period, weekday, cells:[{text, hit, tone}] }]
 *   }
 *
 * 两种列：
 *   kind='matrix' 号码列 —— 单元格显示**遗漏值**，命中的号码用红圈标出
 *                    （和国内彩票走势图的通行画法一致）
 *   kind='value'  统计列 —— 单元格显示一个统计值（和值、跨度、奇偶比…）
 *
 * 号码列的三种变体：
 *   cell='omit'    当前遗漏（默认）
 *   cell='maxOmit' 历史最长遗漏
 *   cell='count'   截至本期的累计出现次数
 *
 * 命中高亮变体 tone：
 *   'none'        普通命中
 *   'consecutive' 连号（与相邻号码成组）用深色
 *   'repeat'      重号（与上期重复）用深色
 *
 * 纯函数，不依赖云函数。
 */

const { pad2 } = require("./lottery.js");

/* ==================== 基础工具 ==================== */

function zoneOf(row, part) {
  const list = part === "extra" ? row.extras : row.numbers;
  return Array.isArray(list) ? list : [];
}

function rangeOf(m, part) {
  return part === "extra"
    ? { min: m.extraMin, max: m.extraMax }
    : { min: m.mainMin, max: m.mainMax };
}

/** 把 [min,max] 均分成 parts 段，余数分给靠前的段 */
function splitRange(min, max, parts) {
  const span = max - min + 1;
  const step = Math.ceil(span / parts);
  const out = [];
  for (let i = 0; i < parts; i++) {
    const from = min + i * step;
    if (from > max) break;
    out.push({ index: i, from: from, to: Math.min(max, from + step - 1) });
  }
  return out;
}

const ZONE_CN = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];
function zoneLabel(i) {
  return (ZONE_CN[i] || i + 1) + "区";
}

/** 星期：1=周一 … 7=周日。date 形如 "2026-10-29" */
function weekdayOf(date) {
  if (!date) return 0;
  const p = String(date).split("-");
  if (p.length < 3) return 0;
  const d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  if (isNaN(d.getTime())) return 0;
  const w = d.getDay();
  return w === 0 ? 7 : w;
}

const PRIME_CACHE = {};
function isPrime(n) {
  if (n < 2) return false;
  if (PRIME_CACHE[n] !== undefined) return PRIME_CACHE[n];
  let r = true;
  for (let i = 2; i * i <= n; i++) {
    if (n % i === 0) { r = false; break; }
  }
  PRIME_CACHE[n] = r;
  return r;
}

/* ==================== 统计函数 ==================== */

function sumOf(list) {
  return list.reduce(function (a, b) { return a + b; }, 0);
}

function spanOf(list) {
  if (!list.length) return 0;
  return Math.max.apply(null, list) - Math.min.apply(null, list);
}

function oddEvenText(list) {
  let odd = 0;
  list.forEach(function (n) { if (n % 2 === 1) odd++; });
  return odd + ":" + (list.length - odd);
}

function bigSmallText(list, m, part) {
  const r = rangeOf(m, part);
  const mid = (r.min + r.max) / 2;
  let big = 0;
  list.forEach(function (n) { if (n > mid) big++; });
  return big + ":" + (list.length - big);
}

function primeRatioText(list) {
  let p = 0;
  list.forEach(function (n) { if (isPrime(n)) p++; });
  return p + ":" + (list.length - p);
}

/** 连续号组数，12/13/14 算 1 组 */
function consecutiveGroups(list) {
  const sorted = list.slice().sort(function (a, b) { return a - b; });
  let groups = 0;
  let run = 0;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - sorted[i - 1] === 1) {
      run++;
    } else {
      if (run > 0) groups++;
      run = 0;
    }
  }
  if (run > 0) groups++;
  return groups;
}

/** 连号明细，如 "12-13"；没有则 "-" */
function consecutiveDetail(list) {
  const sorted = list.slice().sort(function (a, b) { return a - b; });
  const parts = [];
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] - sorted[j] === 1) j++;
    if (j > i) parts.push(pad2(sorted[i]) + "-" + pad2(sorted[j]));
    i = j + 1;
  }
  return parts.length ? parts.join(" ") : "-";
}

/** 与上一期重复的号码 */
function repeatWithPrev(prev, curr) {
  if (!prev || !curr) return [];
  const set = {};
  prev.forEach(function (n) { set[n] = true; });
  return curr.filter(function (n) { return set[n]; }).sort(function (a, b) { return a - b; });
}

/** AC 值 = 不同号码数 - 不同差值数 - 1 */
function acValue(list) {
  if (list.length < 2) return 0;
  const sorted = list.slice().sort(function (a, b) { return a - b; });
  const diffs = {};
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      diffs[sorted[j] - sorted[i]] = true;
    }
  }
  const distinct = {};
  sorted.forEach(function (n) { distinct[n] = true; });
  return Object.keys(distinct).length - Object.keys(diffs).length - 1;
}

/** 尾数形态：本期号码尾数去重排序后拼起来 */
function tailShape(list) {
  const set = {};
  list.forEach(function (n) { set[n % 10] = true; });
  return Object.keys(set).map(Number).sort(function (a, b) { return a - b; }).join("");
}

/* ==================== 号码矩阵构建 ==================== */

/**
 * 生成号码列。
 * @param {object} m 彩种元信息
 * @param {Array} specs 每个 {part, label, filter}
 */
function buildColumns(m, specs) {
  const columns = [];
  const groups = [];
  specs.forEach(function (spec) {
    const r = rangeOf(m, spec.part);
    const start = columns.length;
    for (let n = r.min; n <= r.max; n++) {
      if (spec.filter && !spec.filter(n)) continue;
      columns.push({
        label: pad2(n),
        n: n,
        part: spec.part,
        kind: "matrix",
      });
    }
    if (columns.length > start) {
      groups.push({ label: spec.label, span: columns.length - start });
    }
  });
  return { columns: columns, groups: groups };
}

/**
 * 构建号码矩阵表格。
 * @param {Array} rows 开奖记录（按显示顺序，旧的在前）
 * @param {object} m 彩种元信息
 * @param {object} spec 算法规格
 */
function buildMatrix(rows, m, spec) {
  const parts = spec.parts || ["main"];
  const columns = [];
  const groups = [];

  parts.forEach(function (part) {
    if (part === "extra" && m.extraCount <= 0) return;
    const r = rangeOf(m, part);

    if (spec.zoneParts) {
      // 分区类算法：每个分区一组，表头用分区名
      splitRange(r.min, r.max, spec.zoneParts).forEach(function (z) {
        const start = columns.length;
        for (let n = z.from; n <= z.to; n++) {
          columns.push({ label: pad2(n), n: n, part: part, kind: "matrix" });
        }
        groups.push({ label: zoneLabel(z.index), span: columns.length - start });
      });
    } else if (spec.groupParts) {
      // 尾数 / 012路 / 质数：每个取值一组，组内列出所有落在该取值的号码
      for (let n = r.min; n <= r.max; n++) {
        const v = spec.groupValue(n);
        if (v === null) continue;
        const start = columns.length;
        for (let x = r.min; x <= r.max; x++) {
          if (spec.groupValue(x) !== v) continue;
          columns.push({ label: spec.groupLabel(v), n: x, part: part, kind: "matrix" });
        }
        groups.push({ label: spec.groupLabel(v), span: columns.length - start });
      }
    } else {
      // 普通号码区：主区按三区分组（和国内走势图一致：一区/二区/三区），
      // 副区单独一组
      if (part === "main" && !spec.noZone) {
        splitRange(r.min, r.max, spec.displayZones || 3).forEach(function (z) {
          const start = columns.length;
          for (let n = z.from; n <= z.to; n++) {
            columns.push({ label: pad2(n), n: n, part: part, kind: "matrix" });
          }
          groups.push({ label: zoneLabel(z.index), span: columns.length - start });
        });
      } else {
        const start = columns.length;
        for (let n = r.min; n <= r.max; n++) {
          columns.push({ label: pad2(n), n: n, part: part, kind: "matrix" });
        }
        groups.push({
          label: part === "extra" ? m.extraLabel : m.mainLabel,
          span: columns.length - start,
        });
      }
    }
  });

  /* --- 逐行计算单元格 --- */
  const omission = columns.map(function () { return 0; });
  const maxOmit = columns.map(function () { return 0; });
  const cumCount = columns.map(function () { return 0; });

  const outRows = rows.map(function (row, idx) {
    const prev = idx > 0 ? rows[idx - 1] : null;
    const cells = columns.map(function (col, ci) {
      const nums = zoneOf(row, col.part);
      const hit = nums.indexOf(col.n) > -1;
      if (hit) {
        omission[ci] = 0;
        cumCount[ci]++;
      } else {
        omission[ci]++;
        if (omission[ci] > maxOmit[ci]) maxOmit[ci] = omission[ci];
      }
      return {
        text: hit ? col.label : "",
        hit: hit,
        tone: "none",
        omission: omission[ci],
        maxOmit: maxOmit[ci],
        count: cumCount[ci],
      };
    });

    // 连号高亮：与相邻号码成组的命中用深色
    if (spec.tone === "consecutive") {
      const nums = zoneOf(row, "main");
      const set = {};
      nums.forEach(function (n) { set[n] = true; });
      columns.forEach(function (col, ci) {
        if (!cells[ci].hit) return;
        const near =
          (set[col.n - 1] && col.part === "main") ||
          (set[col.n + 1] && col.part === "main");
        if (near) cells[ci].tone = "strong";
      });
    }
    // 重号高亮：与上期重复的命中用深色
    if (spec.tone === "repeat" && prev) {
      const prevNums = zoneOf(prev, "main").concat(zoneOf(prev, "extra"));
      const set = {};
      prevNums.forEach(function (n) { set[n] = true; });
      columns.forEach(function (col, ci) {
        if (!cells[ci].hit) return;
        if (set[col.n]) cells[ci].tone = "strong";
      });
    }

    return {
      period: row.period,
      date: row.date,
      weekday: weekdayOf(row.date),
      cells: cells,
    };
  });

  /* --- 单元格取值 --- */
  const cellMode = spec.cell || "omit";
  outRows.forEach(function (r) {
    r.cells.forEach(function (c) {
      if (cellMode === "maxOmit") c.text = c.hit ? c.text : String(c.maxOmit);
      else if (cellMode === "count") c.text = String(c.count);
      else if (!c.hit) c.text = String(c.omission);
    });
  });

  return { groups: groups, columns: columns, rows: outRows };
}

/* ==================== 统计表构建 ==================== */

/**
 * 构建统计值表格。
 * @param {Array} rows 开奖记录（旧的在前）
 * @param {object} m 彩种元信息
 * @param {object} spec 算法规格，spec.stats = [{label, group, fn}]
 */
function buildStats(rows, m, spec) {
  const groups = [];
  const columns = [];
  spec.stats.forEach(function (s) {
    const gi = groups.findIndex(function (g) { return g.label === s.group; });
    if (gi < 0) {
      groups.push({ label: s.group, span: 1 });
      columns.push({ label: s.label, kind: "value", key: s.label });
    } else {
      groups[gi].span++;
      columns.push({ label: s.label, kind: "value", key: s.label });
    }
  });

  const outRows = rows.map(function (row, idx) {
    const prev = idx > 0 ? rows[idx - 1] : null;
    const ctx = {
      row: row,
      prev: prev,
      idx: idx,
      m: m,
      main: zoneOf(row, "main"),
      extra: zoneOf(row, "extra"),
      prevMain: prev ? zoneOf(prev, "main") : null,
      prevExtra: prev ? zoneOf(prev, "extra") : null,
    };
    return {
      period: row.period,
      date: row.date,
      weekday: weekdayOf(row.date),
      cells: spec.stats.map(function (s) {
        return { text: String(s.fn(ctx)), hit: false, tone: "none" };
      }),
    };
  });

  return { groups: groups, columns: columns, rows: outRows };
}

/* ==================== 36 种算法目录 ==================== */

/** 尾数分组：列标题是尾数，命中判定按尾数 */
function tailGroupValue(n) { return n % 10; }
function tailGroupLabel(v) { return String(v); }

/** 012 路分组 */
function mod3GroupValue(n) { return ((n % 3) + 3) % 3; }
function mod3GroupLabel(v) { return String(v); }

/** 质数分组：列标题是质数本身 */
function primeGroupValue(n) { return isPrime(n) ? n : null; }
function primeGroupLabel(v) { return String(v); }

const WEEKDAY_NAMES = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

/**
 * 算法表：key → 规格
 * kind: matrix（号码遗漏矩阵） / stats（统计值表）
 */
const ALGORITHMS = {
  /* ---------- 号码矩阵类（15） ---------- */
  basic: {
    kind: "matrix",
    name: "基本走势",
    parts: ["main", "extra"],
    cell: "omit",
  },
  main: {
    kind: "matrix",
    name: "主区走势",
    parts: ["main"],
    cell: "omit",
  },
  extra: {
    kind: "matrix",
    name: "副区走势",
    parts: ["extra"],
    cell: "omit",
  },
  zone3: { kind: "matrix", name: "三分区走势", parts: ["main"], zoneParts: 3, cell: "omit" },
  zone4: { kind: "matrix", name: "四分区走势", parts: ["main"], zoneParts: 4, cell: "omit" },
  zone5: { kind: "matrix", name: "五分区走势", parts: ["main"], zoneParts: 5, cell: "omit" },
  zone7: { kind: "matrix", name: "七分区走势", parts: ["main"], zoneParts: 7, cell: "omit" },
  zone8: { kind: "matrix", name: "八分区走势", parts: ["main"], zoneParts: 8, cell: "omit" },
  tail: {
    kind: "matrix",
    name: "尾数走势",
    parts: ["main"],
    groupParts: true,
    groupValue: tailGroupValue,
    groupLabel: tailGroupLabel,
    cell: "omit",
  },
  mod3: {
    kind: "matrix",
    name: "012路走势",
    parts: ["main"],
    groupParts: true,
    groupValue: mod3GroupValue,
    groupLabel: mod3GroupLabel,
    cell: "omit",
  },
  prime: {
    kind: "matrix",
    name: "质数走势",
    parts: ["main"],
    groupParts: true,
    groupValue: primeGroupValue,
    groupLabel: primeGroupLabel,
    cell: "omit",
  },
  count: { kind: "matrix", name: "冷热走势", parts: ["main"], cell: "count" },
  history: { kind: "matrix", name: "历史走势", parts: ["main"], cell: "maxOmit" },
  consecutive: { kind: "matrix", name: "连号走势", parts: ["main"], tone: "consecutive", cell: "omit" },
  repeat: { kind: "matrix", name: "重号走势", parts: ["main"], tone: "repeat", cell: "omit" },

  /* ---------- 按星期（7） ---------- */
  week1: { kind: "matrix", name: "周一走势", parts: ["main", "extra"], weekday: 1, cell: "omit" },
  week2: { kind: "matrix", name: "周二走势", parts: ["main", "extra"], weekday: 2, cell: "omit" },
  week3: { kind: "matrix", name: "周三走势", parts: ["main", "extra"], weekday: 3, cell: "omit" },
  week4: { kind: "matrix", name: "周四走势", parts: ["main", "extra"], weekday: 4, cell: "omit" },
  week5: { kind: "matrix", name: "周五走势", parts: ["main", "extra"], weekday: 5, cell: "omit" },
  week6: { kind: "matrix", name: "周六走势", parts: ["main", "extra"], weekday: 6, cell: "omit" },
  week7: { kind: "matrix", name: "周日走势", parts: ["main", "extra"], weekday: 7, cell: "omit" },

  /* ---------- 统计值类（14） ---------- */
  sum: {
    kind: "stats",
    name: "和值走势",
    stats: [{ label: "和值", group: "分析", fn: function (c) { return sumOf(c.main); } }],
  },
  mainSum: {
    kind: "stats",
    name: "主区和值走势",
    stats: [{ label: "主区和值", group: "分析", fn: function (c) { return sumOf(c.main); } }],
  },
  extraSum: {
    kind: "stats",
    name: "副区和值走势",
    stats: [{ label: "副区和值", group: "分析", fn: function (c) { return sumOf(c.extra); } }],
  },
  span: {
    kind: "stats",
    name: "跨度走势",
    stats: [{ label: "跨度", group: "分析", fn: function (c) { return spanOf(c.main); } }],
  },
  bigSmall: {
    kind: "stats",
    name: "大小走势",
    stats: [{ label: "大小比", group: "分析", fn: function (c) { return bigSmallText(c.main, c.m, "main"); } }],
  },
  oddEven: {
    kind: "stats",
    name: "奇偶走势",
    stats: [{ label: "奇偶比", group: "分析", fn: function (c) { return oddEvenText(c.main); } }],
  },
  zoneHit: {
    kind: "stats",
    name: "区间比走势",
    stats: [
      {
        label: "区间比",
        group: "分析",
        fn: function (c) {
          const r = rangeOf(c.m, "main");
          const zones = splitRange(r.min, r.max, 3);
          const counts = zones.map(function () { return 0; });
          c.main.forEach(function (n) {
            for (let i = 0; i < zones.length; i++) {
              if (n >= zones[i].from && n <= zones[i].to) { counts[i]++; break; }
            }
          });
          return counts.join(":");
        },
      },
    ],
  },
  ac: {
    kind: "stats",
    name: "AC值走势",
    stats: [{ label: "AC值", group: "分析", fn: function (c) { return acValue(c.main); } }],
  },
  sumZone: {
    kind: "stats",
    name: "和值区间走势",
    stats: [
      {
        label: "和值区间",
        group: "分析",
        fn: function (c) {
          const s = sumOf(c.main);
          const base = Math.floor(s / 10) * 10;
          return base + "-" + (base + 9);
        },
      },
    ],
  },
  sumTail: {
    kind: "stats",
    name: "和值尾数走势",
    stats: [{ label: "和值尾数", group: "分析", fn: function (c) { return sumOf(c.main) % 10; } }],
  },
  primeRatio: {
    kind: "stats",
    name: "质数比走势",
    stats: [{ label: "质数比", group: "分析", fn: function (c) { return primeRatioText(c.main); } }],
  },
  consecutiveDetail: {
    kind: "stats",
    name: "连号明细",
    stats: [{ label: "连号明细", group: "分析", fn: function (c) { return consecutiveDetail(c.main); } }],
  },
  repeatDetail: {
    kind: "stats",
    name: "重号明细",
    stats: [
      {
        label: "重号明细",
        group: "分析",
        fn: function (c) {
          const list = repeatWithPrev(c.prevMain, c.main);
          return list.length ? list.map(pad2).join(" ") : "-";
        },
      },
    ],
  },
  tailShape: {
    kind: "stats",
    name: "尾数形态走势",
    stats: [{ label: "尾数形态", group: "分析", fn: function (c) { return tailShape(c.main); } }],
  },
};

/* ==================== 各彩种的算法菜单 ==================== */

const MENU = {
  dlt: [
    { key: "basic", name: "基本走势" },
    { key: "main", name: "前区走势" },
    { key: "extra", name: "后区走势" },
    { key: "consecutive", name: "连号走势" },
    { key: "repeat", name: "重号走势" },
    { key: "bigSmall", name: "大小走势" },
    { key: "oddEven", name: "奇偶走势" },
    { key: "span", name: "跨度走势" },
    { key: "mainSum", name: "前区和值走势" },
    { key: "extraSum", name: "后区和值走势" },
    { key: "history", name: "历史走势" },
    { key: "zone4", name: "四分区走势" },
    { key: "zone5", name: "五分区走势" },
    { key: "zone7", name: "七分区走势" },
    { key: "mod3", name: "012路走势" },
    { key: "week1", name: "周一走势" },
    { key: "week3", name: "周三走势" },
    { key: "week6", name: "周六走势" },
  ],
  ssq: [
    { key: "basic", name: "基本走势" },
    { key: "main", name: "红球走势" },
    { key: "extra", name: "蓝球走势" },
    { key: "consecutive", name: "连号走势" },
    { key: "repeat", name: "重号走势" },
    { key: "bigSmall", name: "大小走势" },
    { key: "oddEven", name: "奇偶走势" },
    { key: "span", name: "跨度走势" },
    { key: "sum", name: "和值走势" },
    { key: "history", name: "历史走势" },
    { key: "zone4", name: "四分区走势" },
    { key: "zone5", name: "五分区走势" },
    { key: "zone7", name: "七分区走势" },
    { key: "mod3", name: "012路走势" },
    { key: "tail", name: "尾数走势" },
    { key: "week2", name: "周二走势" },
    { key: "week4", name: "周四走势" },
    { key: "week7", name: "周日走势" },
  ],
  fc3d: [
    { key: "basic", name: "基本走势" },
    { key: "main", name: "直选走势" },
    { key: "sum", name: "和值走势" },
    { key: "span", name: "跨度走势" },
    { key: "oddEven", name: "奇偶走势" },
    { key: "bigSmall", name: "大小走势" },
    { key: "mod3", name: "012路走势" },
    { key: "zone3", name: "三分区走势" },
    { key: "consecutive", name: "连号走势" },
    { key: "repeat", name: "重号走势" },
    { key: "history", name: "历史走势" },
    { key: "sumZone", name: "和值区间走势" },
  ],
  kl8: [
    { key: "basic", name: "基本走势" },
    { key: "main", name: "选号走势" },
    { key: "sum", name: "和值走势" },
    { key: "span", name: "跨度走势" },
    { key: "oddEven", name: "奇偶走势" },
    { key: "bigSmall", name: "大小走势" },
    { key: "zone8", name: "八分区走势" },
    { key: "count", name: "冷热走势" },
    { key: "tail", name: "尾数走势" },
    { key: "prime", name: "质数走势" },
    { key: "history", name: "历史走势" },
    { key: "sumZone", name: "和值区间走势" },
  ],
};

/** 某彩种的算法菜单 */
function menuOf(lotteryKey) {
  return MENU[lotteryKey] || MENU.ssq;
}

/** 算法规格 */
function algoOf(key) {
  return ALGORITHMS[key] || ALGORITHMS.basic;
}

/** 算法总数 —— 目录里一共 36 种 */
function algoCount() {
  return Object.keys(ALGORITHMS).length;
}

/* ==================== 对外主入口 ==================== */

/**
 * 构建一张走势图表格。
 *
 * @param {Array} draws 开奖记录（**新的在前**，云函数 listDraws 的顺序）
 * @param {string} lotteryKey 彩种
 * @param {string} algoKey 算法
 * @param {object} opts { periods: 显示期数, desc: 是否倒序 }
 * @returns {object|null} 表格结构
 */
function build(draws, lotteryKey, algoKey, opts) {
  const options = opts || {};
  const periods = options.periods || 30;
  const desc = options.desc !== false;

  const m = require("./lottery.js").meta(lotteryKey);
  const spec = algoOf(algoKey);

  // 取最新的 N 期，然后按显示顺序排（旧 → 新 或 新 → 旧）
  let rows = (draws || []).slice(0, periods);
  if (spec.weekday) {
    rows = rows.filter(function (r) { return weekdayOf(r.date) === spec.weekday; });
  }
  rows = rows.slice().reverse();
  if (desc) rows = rows.reverse();

  if (!rows.length) {
    return {
      algo: algoKey,
      name: spec.name,
      title: m.name + "-" + spec.name,
      kind: spec.kind,
      groups: [],
      columns: [],
      rows: [],
      empty: true,
    };
  }

  let table;
  if (spec.kind === "stats") {
    table = buildStats(rows, m, spec);
  } else {
    table = buildMatrix(rows, m, spec);
  }

  // 统计表的分组标题用彩种的区名（红球分析 / 前区分析）
  if (spec.kind === "stats") {
    table.groups.forEach(function (g) {
      if (g.label === "分析") {
        g.label = m.mainLabel + "分析";
      }
    });
  }

  // 号码列的冷热配色：出现次数高于平均的算热号
  // 只对号码列有意义 —— 统计值列每格都不会命中，不排除的话 hot 会全变成 true，
  // 表头和数字就会被误标成热号。
  const freq = table.columns.map(function () { return 0; });
  table.rows.forEach(function (r) {
    r.cells.forEach(function (c, ci) {
      if (c.hit) freq[ci]++;
    });
  });
  const matrixIdx = [];
  table.columns.forEach(function (col, ci) {
    if (col.kind === "matrix") matrixIdx.push(ci);
  });
  const avg = matrixIdx.length
    ? matrixIdx.reduce(function (a, ci) { return a + freq[ci]; }, 0) / matrixIdx.length
    : 0;
  matrixIdx.forEach(function (ci) {
    table.columns[ci].hot = freq[ci] >= avg;
  });

  return {
    algo: algoKey,
    name: spec.name,
    title: m.name + "-" + spec.name,
    kind: spec.kind,
    groups: table.groups,
    columns: table.columns,
    rows: table.rows,
    empty: false,
  };
}

module.exports = {
  ALGORITHMS: ALGORITHMS,
  MENU: MENU,
  menuOf: menuOf,
  algoOf: algoOf,
  algoCount: algoCount,
  build: build,
  weekdayOf: weekdayOf,
  splitRange: splitRange,
  zoneLabel: zoneLabel,
  sumOf: sumOf,
  spanOf: spanOf,
  oddEvenText: oddEvenText,
  bigSmallText: bigSmallText,
  consecutiveGroups: consecutiveGroups,
  consecutiveDetail: consecutiveDetail,
  repeatWithPrev: repeatWithPrev,
  acValue: acValue,
  tailShape: tailShape,
  WEEKDAY_NAMES: WEEKDAY_NAMES,
};
