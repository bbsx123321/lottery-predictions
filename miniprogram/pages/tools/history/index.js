const api = require("../../../utils/api.js");
const { meta, ballsOf } = require("../../../utils/lottery.js");
const { getLayout } = require("../../../utils/layout.js");
/** 一次取满，分页在前端做（云函数现在单次最多 500 条，这里取一半，留余量） */
const TOTAL = 300;
/** 每页条数 */
const PAGE_SIZE = 20;

function fmtAmount(v) {
  if (v === null || v === undefined || v === "" || v === "-") return "-";
  const n = Number(v);
  if (!isFinite(n) || n <= 0) return "-";
  if (n >= 1e8) return (n / 1e8).toFixed(2) + "亿";
  if (n >= 1e4) return (n / 1e4).toFixed(2) + "万";
  return String(Math.round(n));
}

function decorate(row) {
  const b = ballsOf(row);
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
  };
}

/** "2026-10-29" -> "10-29" */
function shortDate(date) {
  const s = String(date || "");
  const m = s.match(/(\d{2})-(\d{2})$/);
  return m ? m[1] + "-" + m[2] : s;
}

Page({
  data: {
    loading: false,
    loadingMore: false,
    error: "",
    lotteryKey: "ssq",
    tabs: [],
    list: [],
    shown: PAGE_SIZE,
    total: 0,
    hasMore: false,
    bottomPad: 0,
  },

  onLoad() {
    this._cache = {};
    const layout = getLayout();
    this.setData({
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

  applyLottery(key) {
    this.setData({
      lotteryKey: key,
      shown: PAGE_SIZE,
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
      this.applyRows(this._cache[key]);
      this.setData({ loading: false });
      return Promise.resolve();
    }

    return api
      .listDraws(key, TOTAL)
      .then(function (res) {
        if (!res || !res.success) {
          throw new Error((res && res.message) || "获取开奖数据失败");
        }
        const rows = (res.data && res.data.list) || [];
        self._cache[key] = rows;
        self.applyRows(rows);
        self.setData({ loading: false });
      })
      .catch(function (err) {
        self.setData({
          loading: false,
          error: (err && err.message) || "获取开奖数据失败",
        });
      });
  },

  applyRows(rows) {
    const decorated = rows.map(decorate);
    const m = meta(this.data.lotteryKey);
    this.setData({
      list: decorated.slice(0, this.data.shown),
      hasMore: decorated.length > this.data.shown,
      total: decorated.length,
      mainLabel: m.mainLabel,
      extraLabel: m.extraLabel,
      hasExtra: m.extraCount > 0,
    });
  },

  /** 加载更多 */
  onLoadMore() {
    if (this.data.loadingMore || !this.data.hasMore) return;
    const next = this.data.shown + PAGE_SIZE;
    this.setData({ loadingMore: true, shown: next });
    this.applyRows(this._cache[this.data.lotteryKey] || []);
    setTimeout(() => {
      this.setData({ loadingMore: false });
    }, 200);
  },
});
