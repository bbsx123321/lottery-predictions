const api = require("../../../utils/api.js");
const { meta, ballsOf, randomNumbers } = require("../../../utils/lottery.js");
const analysis = require("../../../utils/analysis.js");
const { getLayout } = require("../../../utils/layout.js");

/** 幸运选号生成几组 */
const GROUP_COUNT = 5;
/** 模拟选号按形态过滤时的尝试次数上限 */
const MAX_TRIES = 400;

/**
 * 加权随机：weights[n] 越大越容易被抽中。
 * 幸运选号用历史频次当权重 —— 热号出现频率高，但不是必然出现。
 */
function weightedPick(m, count, weights) {
  const pool = [];
  for (let i = m.mainMin; i <= m.mainMax; i++) pool.push(i);

  const picked = [];
  const need = Math.min(count, pool.length);
  for (let k = 0; k < need; k++) {
    let total = 0;
    pool.forEach(function (n) {
      total += weights[n] || 1;
    });
    let r = Math.random() * total;
    let idx = pool.length - 1;
    for (let j = 0; j < pool.length; j++) {
      r -= weights[pool[j]] || 1;
      if (r <= 0) {
        idx = j;
        break;
      }
    }
    picked.push(pool.splice(idx, 1)[0]);
  }
  return m.ordered ? picked : picked.sort(function (a, b) { return a - b; });
}

/** 一组号码的形态指标 */
function shapeOf(main, extra, m, part) {
  const oe = analysis.oddEvenOf(main);
  const bs = analysis.bigSmallOf(main, m, part);
  return {
    sum: analysis.sumOf(main),
    odd: oe.odd,
    even: oe.even,
    big: bs.big,
    small: bs.small,
    span: analysis.spanOf(main),
  };
}

Page({
  data: {
    loading: false,
    error: "",
    lotteryKey: "ssq",
    tabs: [],
    // lucky = 幸运选号，simulate = 模拟选号
    mode: "lucky",
    modeOptions: [
      { key: "lucky", label: "幸运选号" },
      { key: "simulate", label: "模拟选号" },
    ],
    // 模拟选号：纯随机 / 按历史形态过滤
    strategy: "weighted",
    strategyOptions: [
      { key: "weighted", label: "热号优先" },
      { key: "pure", label: "纯随机" },
      { key: "shape", label: "按历史形态" },
    ],
    groups: [],
    tips: "",
    saved: false,
    savedCount: 0,
    bottomPad: 0,
  },

  onLoad(options) {
    this._cache = {};
    const mode = options && options.mode === "simulate" ? "simulate" : "lucky";
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
    this.generate();
  },

  onSwitchStrategy(e) {
    const strategy = e.currentTarget.dataset.strategy;
    if (!strategy || strategy === this.data.strategy) return;
    this.setData({ strategy: strategy });
    this.generate();
  },

  applyLottery(key) {
    this.setData({
      lotteryKey: key,
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
      this.generate();
      this.setData({ loading: false });
      return Promise.resolve();
    }

    return api
      .listDraws(key, 60)
      .then(function (res) {
        if (!res || !res.success) {
          throw new Error((res && res.message) || "获取开奖数据失败");
        }
        self._cache[key] = (res.data && res.data.list) || [];
        self.generate();
        self.setData({ loading: false });
      })
      .catch(function (err) {
        self.setData({
          loading: false,
          error: (err && err.message) || "获取开奖数据失败",
        });
      });
  },

  /** 生成选号 */
  generate() {
    const key = this.data.lotteryKey;
    const m = meta(key);
    const rows = this._cache[key] || [];
    if (!rows.length) {
      this.setData({ groups: [], tips: "暂无历史数据用于分析" });
      return;
    }

    const freq = analysis.frequency(rows, m, "main");
    const weights = {};
    freq.list.forEach(function (x) {
      weights[x.n] = x.count + 1;
    });

    // 历史形态基准（用于「按历史形态」策略）
    const sums = rows.map(function (r) {
      return analysis.sumOf(analysis.zoneOf(r, "main"));
    });
    const sumMin = Math.min.apply(null, sums);
    const sumMax = Math.max.apply(null, sums);
    const sumLo = sumMin + (sumMax - sumMin) * 0.2;
    const sumHi = sumMin + (sumMax - sumMin) * 0.8;

    const groups = [];
    let tries = 0;

    while (groups.length < GROUP_COUNT && tries < MAX_TRIES) {
      tries++;
      let main;
      let extra;

      if (this.data.strategy === "pure") {
        main = randomNumbers(m, m.mainCount);
      } else {
        main = weightedPick(m, m.mainCount, weights);
      }

      if (m.extraCount > 0) {
        if (this.data.strategy === "pure") {
          extra = randomNumbers(
            { mainMin: m.extraMin, mainMax: m.extraMax, mainCount: m.extraCount, ordered: false },
            m.extraCount
          );
        } else {
          extra = weightedPick(
            {
              mainMin: m.extraMin,
              mainMax: m.extraMax,
              mainCount: m.extraCount,
              ordered: false,
            },
            m.extraCount,
            weights
          );
        }
      } else {
        extra = [];
      }

      // 「按历史形态」：和值落在历史中间 60% 区间
      if (this.data.strategy === "shape") {
        const s = analysis.sumOf(main);
        if (s < sumLo || s > sumHi) continue;
      }

      const b = ballsOf({ numbers: main, extras: extra });
      groups.push({
        main: b.main,
        extra: b.extra,
        shape: shapeOf(main, extra, m, "main"),
      });
    }

    let tips;
    if (this.data.strategy === "weighted") {
      tips = "按近 " + rows.length + " 期出现频次加权抽取，热号更容易出现但不代表必然。";
    } else if (this.data.strategy === "pure") {
      tips = "完全等概率随机，不参考任何历史数据。";
    } else {
      tips =
        "只保留和值落在历史中间 60% 区间（" +
        Math.round(sumLo) + "-" + Math.round(sumHi) +
        "）的号码组，形态更接近历史开奖。";
    }

    this.setData({ groups: groups, tips: tips });
    this.saveRecord(groups);
  },

  /**
   * 把这一批号码存到云端（「我的 → 模拟选号记录」里能看到）。
   *
   * 失败不影响选号本身 —— 存记录是附加功能，不能因为它把号码搞没了。
   */
  saveRecord(groups) {
    if (!groups || !groups.length) return;
    const self = this;
    const m = meta(this.data.lotteryKey);

    api
      .savePicks(
        {
          lottery: this.data.lotteryKey,
          lotteryName: m.name,
          mode: this.data.mode,
          strategy: this.data.strategy,
          groups: groups.map(function (g) {
            return {
              main: g.main.map(function (b) { return b.text; }),
              extra: g.extra.map(function (b) { return b.text; }),
              sum: g.shape.sum,
              span: g.shape.span,
            };
          }),
        },
        { silent: true, timeout: 8000 }
      )
      .then(function (res) {
        if (res && res.success) {
          self.setData({ saved: true, savedCount: self.data.savedCount + 1 });
        }
      })
      .catch(function () {
        /* 存记录失败不影响选号 */
      });
  },

  /** 换一组 */
  onRegenerate() {
    this.generate();
  },

  /** 复制全部号码 */
  onCopy() {
    const text = this.data.groups
      .map(function (g, i) {
        const main = g.main.map(function (b) { return b.text; }).join(" ");
        const extra = g.extra.map(function (b) { return b.text; }).join(" ");
        return "第" + (i + 1) + "组  " + main + (extra ? "  |  " + extra : "");
      })
      .join("\n");
    wx.setClipboardData({
      data: text,
      success() {
        wx.showToast({ title: "号码已复制", icon: "none" });
      },
    });
  },
});
