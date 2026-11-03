const api = require("../../utils/api.js");
const { meta, ballsOf } = require("../../utils/lottery.js");
const analysis = require("../../utils/analysis.js");
const { getLayout } = require("../../utils/layout.js");
const { isCloudReady } = require("../../utils/cloud.js");

/** 工具箱：7 个入口，顺序即用户指定的顺序 */
const TOOLS = [
  { key: "trend", label: "走势图", tint: "red", url: "/pages/tools/trend/index" },
  { key: "simulate", label: "模拟选号", tint: "orange", url: "/pages/tools/pick/index?mode=simulate" },
  { key: "history", label: "往期开奖", tint: "blue", url: "/pages/tools/history/index" },
  { key: "lucky", label: "吉号分析", tint: "green", url: "/pages/tools/analysis/index?mode=lucky" },
  { key: "pattern", label: "智能规律", tint: "purple", url: "/pages/tools/analysis/index?mode=pattern" },
  { key: "dist", label: "选号分布", tint: "teal", url: "/pages/tools/analysis/index?mode=dist" },
  { key: "pick", label: "幸运选号", tint: "pink", url: "/pages/tools/pick/index?mode=lucky" },
  { key: "ai", label: "AI 分析", tint: "ai", url: "/pages/tools/ai-analysis/index" },
];

/** 近期开奖列表显示多少期 */
const RECENT_COUNT = 10;

/** 一次取多少期（10 期列表 + 一点余量） */
const FETCH_COUNT = 30;

/** 销量/奖池格式化：346568144 -> 3.46亿 */
function fmtAmount(v) {
  if (v === null || v === undefined || v === "" || v === "-") return "-";
  const n = Number(v);
  if (!isFinite(n) || n <= 0) return "-";
  if (n >= 1e8) return (n / 1e8).toFixed(2) + "亿";
  if (n >= 1e4) return (n / 1e4).toFixed(2) + "万";
  return String(Math.round(n));
}

/** "2026-10-29" -> "10-29" */
function shortDate(date) {
  const s = String(date || "");
  const m = s.match(/(\d{2})-(\d{2})$/);
  return m ? m[1] + "-" + m[2] : s;
}

/** 开奖记录 -> 渲染用的球 */
function decorateDraw(row) {
  const b = ballsOf(row);
  const main = row.numbers || [];
  return {
    period: row.period,
    date: row.date,
    shortDate: shortDate(row.date),
    main: b.main,
    extra: b.extra,
    mainText: b.main.map(function (x) { return x.text; }).join(" "),
    extraText: b.extra.map(function (x) { return x.text; }).join(" "),
    sales: fmtAmount(row.sales),
    pool: fmtAmount(row.pool),
    sum: analysis.sumOf(main),
    span: analysis.spanOf(main),
  };
}

Page({
  data: {
    loading: false,
    syncing: false,
    error: "",
    // 当前彩种
    lotteryKey: "ssq",
    // 顶部切换菜单
    tabs: [],
    // 最新一期
    latest: null,
    // 近期 10 期
    recent: [],
    // 工具箱
    tools: [],
    bottomPad: 0,
  },

  onLoad() {
    const layout = getLayout();
    this._cache = {};

    this.setData({
      // 首页现在是 tab 页，底部 tabBar 自己占掉了安全区，这里只要一点点留白
      bottomPad: Math.round(32 * layout.rpxRatio),
      tabs: api.LOTTERIES.map(function (l) {
        return { key: l.key, name: l.name, active: l.key === "ssq" };
      }),
      tools: TOOLS.map(function (t) {
        return { key: t.key, label: t.label, tint: t.tint, url: t.url };
      }),
    });

    this.loadDraws("ssq");
    this.autoRefresh();
  },

  onPullDownRefresh() {
    const self = this;
    this.loadDraws(this.data.lotteryKey).then(function () {
      wx.stopPullDownRefresh();
      self.setData({ loading: false });
    });
  },

  /** 切换顶部彩种 */
  onSwitchTab(e) {
    const key = e.currentTarget.dataset.key;
    if (!key || key === this.data.lotteryKey) return;
    this.setData({
      lotteryKey: key,
      tabs: this.data.tabs.map(function (t) {
        return Object.assign({}, t, { active: t.key === key });
      }),
    });
    this.loadDraws(key);
  },

  /** 拉某个彩种的开奖记录 */
  loadDraws(key) {
    const self = this;
    this.setData({ loading: true, error: "" });

    // 命中缓存直接渲染，不等网络
    if (this._cache[key]) {
      this.applyDraws(key, this._cache[key]);
      this.setData({ loading: false });
      return Promise.resolve();
    }

    return api
      .listDraws(key, FETCH_COUNT)
      .then(function (res) {
        if (!res || !res.success) {
          throw new Error((res && res.message) || "获取开奖数据失败");
        }
        const rows = (res.data && res.data.list) || [];
        self._cache[key] = rows;
        self.applyDraws(key, rows);
        self.setData({ loading: false });
      })
      .catch(function (err) {
        self.setData({
          loading: false,
          error: (err && err.message) || "获取开奖数据失败",
        });
      });
  },

  /** 把开奖记录刷到页面上 */
  applyDraws(key, rows) {
    const m = meta(key);
    this.setData({
      latest: rows.length ? decorateDraw(rows[0]) : null,
      recent: rows.slice(0, RECENT_COUNT).map(decorateDraw),
      mainLabel: m.mainLabel,
      extraLabel: m.extraLabel,
      hasExtra: m.extraCount > 0,
    });
  },

  /**
   * 兜底自动同步 —— 与首屏并行，不阻塞渲染。
   * 定时触发器需要手动上传 config.json 才生效，这个动作保证
   * 只要有人打开小程序，数据就会按需补拉。
   */
  autoRefresh() {
    if (!isCloudReady()) return;
    const self = this;

    api
      .autoSync({ silent: true, timeout: 15000 })
      .then(function (res) {
        if (!res || !res.success) return;
        const data = res.data || {};
        const synced = data.synced || [];
        if (!synced.length) return;

        // 有新期号入库，清掉缓存重新拉
        synced.forEach(function (s) {
          delete self._cache[s.lottery];
        });
        self.loadDraws(self.data.lotteryKey);
      })
      .catch(function () {
        /* 兜底同步失败不影响页面 */
      });
  },

  /** 进入工具页 */
  onToolTap(e) {
    const url = e.currentTarget.dataset.url;
    if (!url) return;
    wx.navigateTo({ url: url });
  },

  /** 查看全部往期开奖 */
  onMoreHistory() {
    wx.navigateTo({ url: "/pages/tools/history/index" });
  },

  /** 手动同步当前彩种 */
  onSync() {
    if (this.data.syncing) return;
    this.setData({ syncing: true });
    const self = this;
    const key = this.data.lotteryKey;

    api
      .syncDraws(key, FETCH_COUNT)
      .then(function (res) {
        if (res && res.success) {
          delete self._cache[key];
          self.loadDraws(key);
          wx.showToast({ title: "已同步最新开奖", icon: "none" });
        }
      })
      .catch(function (err) {
        wx.showToast({ title: (err && err.message) || "同步失败", icon: "none" });
      })
      .then(function () {
        self.setData({ syncing: false });
      });
  },

  /** 进入环境自检页 */
  onDebug() {
    wx.navigateTo({ url: "/pages/debug/index" });
  },
});
