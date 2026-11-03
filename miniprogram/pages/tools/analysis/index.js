const api = require("../../../utils/api.js");
const { meta } = require("../../../utils/lottery.js");
const analysis = require("../../../utils/analysis.js");
const { getLayout } = require("../../../utils/layout.js");

Page({
  data: {
    loading: false,
    error: "",
    lotteryKey: "ssq",
    tabs: [],
    // lucky = 吉号分析，pattern = 智能规律，dist = 选号分布
    mode: "lucky",
    modeOptions: [
      { key: "lucky", label: "吉号分析" },
      { key: "pattern", label: "智能规律" },
      { key: "dist", label: "选号分布" },
    ],
    part: "main",
    partOptions: [],
    // 吉号分析：号码频次表
    freqRows: [],
    hot: [],
    cold: [],
    missing: [],
    // 智能规律
    patterns: [],
    // 选号分布
    zones: [],
    tails: [],
    shape: [],
    summary: [],
    bottomPad: 0,
  },

  onLoad(options) {
    this._cache = {};
    const mode =
      options && (options.mode === "pattern" || options.mode === "dist")
        ? options.mode
        : "lucky";
    const layout = getLayout();
    this.setData({
      mode: mode,
      bottomPad: Math.round(32 * layout.rpxRatio + layout.safeBottom),
      tabs: api.LOTTERIES.map(function (l) {
        return { key: l.key, name: l.name, active: false };
      }),
    });
    this.applyLottery("ssq");
  },

  onSwitchTab(e) {
    const key = e.currentTarget.dataset.key;
    if (!key || key === this.data.lotteryKey) return;
    this.applyLottery(key);
  },

  onSwitchMode(e) {
    const mode = e.currentTarget.dataset.mode;
    if (!mode || mode === this.data.mode) return;
    this.setData({ mode: mode });
  },

  onSwitchPart(e) {
    const part = e.currentTarget.dataset.part;
    if (!part || part === this.data.part) return;
    this.setData({ part: part });
    this.rebuild();
  },

  applyLottery(key) {
    const m = meta(key);
    const partOptions = [{ key: "main", label: m.mainLabel }];
    if (m.extraCount > 0) {
      partOptions.push({ key: "extra", label: m.extraLabel });
    }
    this.setData({
      lotteryKey: key,
      part: "main",
      partOptions: partOptions,
      tabs: this.data.tabs.map(function (t) {
        return Object.assign({}, t, { active: t.key === key });
      }),
    });
    this.loadRows(key);
  },

  loadRows(key) {
    const self = this;
    this.setData({ loading: true, error: "" });

    if (this._cache[key]) {
      this.rebuild();
      this.setData({ loading: false });
      return Promise.resolve();
    }

    return api
      .listDraws(key, 100)
      .then(function (res) {
        if (!res || !res.success) {
          throw new Error((res && res.message) || "获取开奖数据失败");
        }
        self._cache[key] = (res.data && res.data.list) || [];
        self.rebuild();
        self.setData({ loading: false });
      })
      .catch(function (err) {
        self.setData({
          loading: false,
          error: (err && err.message) || "获取开奖数据失败",
        });
      });
  },

  rebuild() {
    const rows = this._cache[this.data.lotteryKey] || [];
    if (!rows.length) return;

    const m = meta(this.data.lotteryKey);
    const part = this.data.part;

    // ---- 吉号分析 ----
    const freq = analysis.frequency(rows, m, part);
    const freqRows = freq.list.map(function (x) {
      return {
        n: x.n,
        text: x.n < 10 ? "0" + x.n : String(x.n),
        count: x.count,
        omission: x.omission,
        // 热度条宽度：相对最高频次
        percent: freq.maxCount ? Math.round((x.count / freq.maxCount) * 100) : 0,
        hot: x.count === freq.maxCount && freq.maxCount > 0,
        cold: x.count === freq.minCount && freq.minCount < freq.maxCount,
      };
    });

    // ---- 智能规律 ----
    const patterns = analysis.patterns(rows, m, part);

    // ---- 选号分布 ----
    const zones = analysis.zoneDistribution(rows, m, part);
    const zoneMax = zones.reduce(function (a, z) { return z.count > a ? z.count : a; }, 0) || 1;
    const zoneRows = zones.map(function (z) {
      return {
        label: z.label,
        count: z.count,
        percent: Math.round((z.count / zoneMax) * 100),
      };
    });

    const tails = analysis.tailDistribution(rows, part);
    const tailMax = tails.reduce(function (a, t) { return t.count > a ? t.count : a; }, 0) || 1;
    const tailRows = tails.map(function (t) {
      return {
        tail: t.tail,
        count: t.count,
        percent: Math.round((t.count / tailMax) * 100),
      };
    });

    // 奇偶比 / 大小比 的常见组合
    const oeMap = {};
    const bsMap = {};
    rows.forEach(function (r) {
      const nums = analysis.zoneOf(r, part);
      const oe = analysis.oddEvenOf(nums);
      const bs = analysis.bigSmallOf(nums, m, part);
      oeMap[oe.odd + ":" + oe.even] = (oeMap[oe.odd + ":" + oe.even] || 0) + 1;
      bsMap[bs.big + ":" + bs.small] = (bsMap[bs.big + ":" + bs.small] || 0) + 1;
    });
    function topOf(map) {
      let best = "";
      let bestCount = 0;
      Object.keys(map).forEach(function (k) {
        if (map[k] > bestCount) {
          best = k;
          bestCount = map[k];
        }
      });
      return {
        combo: best,
        count: bestCount,
        rate: Math.round((bestCount / rows.length) * 100),
      };
    }
    const oeTop = topOf(oeMap);
    const bsTop = topOf(bsMap);

    const sums = rows.map(function (r) {
      return analysis.sumOf(analysis.zoneOf(r, part));
    });
    const sumAvg = Math.round(sums.reduce(function (a, b) { return a + b; }, 0) / rows.length);
    const spans = rows.map(function (r) {
      return analysis.spanOf(analysis.zoneOf(r, part));
    });
    const spanAvg = Math.round(spans.reduce(function (a, b) { return a + b; }, 0) / rows.length);

    const shape = [
      { label: "最常见奇偶比", value: oeTop.combo, detail: "占 " + oeTop.rate + "%" },
      { label: "最常见大小比", value: bsTop.combo, detail: "占 " + bsTop.rate + "%" },
      { label: "平均和值", value: String(sumAvg), detail: "近 " + rows.length + " 期均值" },
      { label: "平均跨度", value: String(spanAvg), detail: "近 " + rows.length + " 期均值" },
    ];

    this.setData({
      freqRows: freqRows,
      hot: freq.hot.map(function (x) {
        return { n: x.n, text: x.n < 10 ? "0" + x.n : String(x.n), count: x.count };
      }),
      cold: freq.cold.map(function (x) {
        return { n: x.n, text: x.n < 10 ? "0" + x.n : String(x.n), count: x.count };
      }),
      missing: freq.missing.map(function (x) {
        return { n: x.n, text: x.n < 10 ? "0" + x.n : String(x.n) };
      }),
      patterns: patterns,
      zones: zoneRows,
      tails: tailRows,
      shape: shape,
      summary: [
        { label: "统计期数", value: rows.length + " 期" },
        { label: "号码个数", value: freq.list.length + " 个" },
        { label: "最高频次", value: freq.maxCount + " 次" },
        { label: "最低频次", value: freq.minCount + " 次" },
      ],
    });
  },
});
