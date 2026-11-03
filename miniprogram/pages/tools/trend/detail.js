const api = require("../../../utils/api.js");
const trend = require("../../../utils/trend.js");
const { meta, pad2 } = require("../../../utils/lottery.js");
const { getLayout } = require("../../../utils/layout.js");

/* 列宽 / 行高 —— 全部用 px，因为画线层要按这套尺寸算坐标。
   宽度参考国内走势图：期次 62 + 星期 26，一屏能放下约 11~12 个号码列。 */
const W_PERIOD = 62;
const W_WEEK = 26;
const W_MATRIX = 24;
const W_VALUE = 52;
const H_HEAD1 = 26;
const H_HEAD2 = 24;
const H_ROW = 26;

const FIXED_W = W_PERIOD + W_WEEK;
const PERIOD_OPTIONS = [15, 30, 50, 100];

Page({
  data: {
    loading: false,
    error: "",
    lotteryKey: "ssq",
    algoKey: "basic",
    title: "走势图",

    periods: 30,
    periodOptions: PERIOD_OPTIONS,
    desc: false,

    table: { groups: [], columns: [], rows: [] },
    tableWidth: 0,
    tableHeight: 0,
    viewHeight: 0,
    viewWidth: 0,
    headH: H_HEAD1 + H_HEAD2,

    lineOn: false,
    lines: [],

    pick: [],
    showPeriods: false,
    showPick: false,
    showFav: false,
    fav: null,

    bottomPad: 0,
    barPad: 0,
  },

  onLoad(query) {
    const layout = getLayout();
    const lotteryKey = (query && query.lottery) || "ssq";
    const algoKey = (query && query.algo) || "basic";
    const m = meta(lotteryKey);
    const name = trend.algoOf(algoKey).name;
    const title = m.name + "-" + name;

    this._cache = {};
    this.setData({
      lotteryKey: lotteryKey,
      algoKey: algoKey,
      title: title,
      bottomPad: Math.round(16 * layout.rpxRatio + layout.safeBottom),
      barPad: Math.round(16 * layout.rpxRatio),
      viewWidth: layout.windowWidth,
      // 顶部标题栏 + 底部工具条
      viewHeight: Math.max(
        240,
        layout.windowHeight - Math.round(108 * layout.rpxRatio) - Math.round(96 * layout.rpxRatio)
      ),
    });

    wx.setNavigationBarTitle({ title: title });
    this.loadDraws(lotteryKey);
  },

  onReady() {
    /* 表格在 onLoad 里异步算好，数据到位后画线层由 setData 一起渲染 */
  },

  /* ---------------- 数据 ---------------- */

  loadDraws(key) {
    const self = this;
    this.setData({ loading: true, error: "" });

    if (this._cache[key]) {
      this.rebuild();
      this.setData({ loading: false });
      return Promise.resolve();
    }

    return api
      .listDraws(key, 120)
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

  /** 重新算表 */
  rebuild() {
    const draws = this._cache[this.data.lotteryKey] || [];
    const raw = trend.build(draws, this.data.lotteryKey, this.data.algoKey, {
      periods: this.data.periods,
      desc: this.data.desc,
    });

    if (!raw || !raw.rows.length) {
      this.setData({
        table: { groups: [], columns: [], rows: [] },
        tableWidth: FIXED_W,
        tableHeight: 0,
        fav: null,
      });
      return;
    }

    // 给每列算宽度和左边偏移
    const columns = raw.columns.map(function (c) {
      return Object.assign({}, c, {
        width: c.kind === "value" ? W_VALUE : W_MATRIX,
      });
    });
    let x = FIXED_W;
    columns.forEach(function (c) {
      c.x = x;
      x += c.width;
    });

    // 分组宽度 = 组内列宽之和
    let ci = 0;
    const groups = raw.groups.map(function (g) {
      let w = 0;
      for (let i = 0; i < g.span; i++) w += columns[ci++].width;
      return { label: g.label, span: g.span, width: w };
    });

    // 每行的单元格补上宽度、号码
    const rows = raw.rows.map(function (r) {
      return {
        period: r.period,
        weekday: r.weekday,
        cells: r.cells.map(function (c, i) {
          const col = columns[i];
          return {
            text: c.text,
            hit: c.hit,
            tone: c.tone,
            kind: col.kind,
            width: col.width,
            n: col.n,
            label: col.label,
            hot: col.hot,
          };
        }),
      };
    });

    this.setData({
      table: { groups: groups, columns: columns, rows: rows },
      tableWidth: x,
      tableHeight: H_HEAD1 + H_HEAD2 + rows.length * H_ROW,
      fav: this.buildFav(columns, rows),
      lines: this.data.lineOn ? this.buildLines(columns, rows) : [],
    });
  },

  /** 精选优选：热号 + 回补号 */
  buildFav(columns, rows) {
    const count = columns.map(function () { return 0; });
    rows.forEach(function (r) {
      r.cells.forEach(function (c, i) {
        if (c.hit) count[i]++;
      });
    });
    const hot = columns
      .map(function (c, i) { return { label: c.label, n: c.n, count: count[i] }; })
      .filter(function (x) { return x.n !== undefined; })
      .sort(function (a, b) { return b.count - a.count; })
      .slice(0, 4);

    const last = rows[rows.length - 1];
    const cold = columns
      .map(function (c, i) {
        const cell = last.cells[i];
        return { label: c.label, n: c.n, omit: cell && !cell.hit ? Number(cell.text) || 0 : 0 };
      })
      .filter(function (x) { return x.n !== undefined; })
      .sort(function (a, b) { return b.omit - a.omit; })
      .slice(0, 4);

    return {
      hot: hot,
      cold: cold,
      tip: "热号看频次，回补号看遗漏 —— 两类都不是预测，只是历史统计",
    };
  },

  /* ---------------- 交互 ---------------- */

  /** 期次排序 */
  onSort() {
    this.setData({ desc: !this.data.desc });
    this.rebuild();
  },

  /** 期数弹层 */
  onTogglePeriods() {
    this.setData({ showPeriods: !this.data.showPeriods, showPick: false, showFav: false });
  },

  onPickPeriod(e) {
    const n = Number(e.currentTarget.dataset.n);
    if (!n) return;
    this.setData({ periods: n, showPeriods: false });
    this.rebuild();
  },

  /** 开启画线 */
  onToggleLine() {
    const on = !this.data.lineOn;
    const table = this.data.table;
    this.setData({
      lineOn: on,
      lines: on && table ? this.buildLines(table.columns, table.rows) : [],
    });
  },

  /** 点命中格 → 加入 / 移出选号单 */
  onCellTap(e) {
    const ri = Number(e.currentTarget.dataset.ri);
    const ci = Number(e.currentTarget.dataset.ci);
    const cell = this.data.table.rows[ri] && this.data.table.rows[ri].cells[ci];
    if (!cell || !cell.hit) return;

    const key = this.data.table.rows[ri].period + "-" + ci;
    const pick = this.data.pick.slice();
    const idx = pick.findIndex(function (p) { return p.key === key; });
    if (idx > -1) {
      pick.splice(idx, 1);
    } else {
      pick.push({
        key: key,
        period: this.data.table.rows[ri].period,
        n: cell.n,
        text: cell.text,
        tone: cell.tone,
      });
    }
    this.setData({ pick: pick });
  },

  onTogglePick() {
    this.setData({ showPick: !this.data.showPick, showPeriods: false, showFav: false });
  },

  onClearPick() {
    this.setData({ pick: [], showPick: false });
  },

  onToggleFav() {
    this.setData({ showFav: !this.data.showFav, showPeriods: false, showPick: false });
  },

  onClosePanel() {
    this.setData({ showPeriods: false, showPick: false, showFav: false });
  },

  /* ---------------- 画线 ---------------- */

  /**
   * 把同一号码的命中点连成折线。
   * 列宽行高都是固定的，坐标可以直接算出来，不用量 DOM；
   * 每一段用一个绝对定位 + rotate 的细条渲染 —— 不用 canvas，
   * 因为 canvas 2d 节点会让开发者工具的整页截图失败。
   */
  buildLines(columns, rows) {
    const out = [];
    columns.forEach(function (col, ci) {
      if (col.kind !== "matrix") return;
      let prev = null;
      rows.forEach(function (r, ri) {
        const cell = r.cells[ci];
        if (!cell || !cell.hit) return;
        const pt = { x: col.x + col.width / 2, y: ri * H_ROW + H_ROW / 2 };
        if (prev) {
          const dx = pt.x - prev.x;
          const dy = pt.y - prev.y;
          out.push({
            id: ci + "-" + ri,
            x: prev.x,
            y: prev.y,
            w: Math.sqrt(dx * dx + dy * dy),
            angle: (Math.atan2(dy, dx) * 180) / Math.PI,
            hot: col.hot,
          });
        }
        prev = pt;
      });
    });
    return out;
  },

  onShareAppMessage() {
    return {
      title: this.data.title,
      path:
        "/pages/tools/trend/detail?lottery=" +
        this.data.lotteryKey +
        "&algo=" +
        this.data.algoKey,
    };
  },
});
