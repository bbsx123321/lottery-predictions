const trend = require("../../../utils/trend.js");
const { LOTTERIES, meta } = require("../../../utils/lottery.js");
const { getLayout } = require("../../../utils/layout.js");

/**
 * 走势图选择页
 *
 * 按彩种分组列出全部走势算法，点一个进详情表格页。
 * 结构参考国内彩票 App 的「走势图」入口：全国 / 地方 两个范围，
 * 下面按 ·大乐透 / ·双色球 / ·福彩3D 分组，每组 3 列算法按钮。
 */
Page({
  data: {
    scope: "national",
    scopeOptions: [
      { key: "national", name: "全国" },
      { key: "local", name: "地方" },
    ],
    groups: [],
    bottomPad: 0,
  },

  onLoad() {
    const layout = getLayout();
    this.setData({
      bottomPad: Math.round(24 * layout.rpxRatio + layout.safeBottom),
      groups: this.buildGroups(),
    });
  },

  /** 按彩种分组，每组是该彩种支持的算法 */
  buildGroups() {
    return LOTTERIES.map(function (l) {
      return {
        key: l.key,
        name: l.name,
        items: trend.menuOf(l.key),
      };
    });
  },

  /** 切换 全国 / 地方 */
  onScope(e) {
    const scope = e.currentTarget.dataset.scope;
    if (!scope || scope === this.data.scope) return;
    this.setData({ scope: scope });
  },

  /** 选一个算法，进详情页 */
  onPickAlgo(e) {
    const lottery = e.currentTarget.dataset.lottery;
    const algo = e.currentTarget.dataset.algo;
    if (!lottery || !algo) return;
    wx.navigateTo({
      url:
        "/pages/tools/trend/detail?lottery=" +
        lottery +
        "&algo=" +
        algo +
        "&title=" +
        encodeURIComponent(meta(lottery).name + "-" + trend.algoOf(algo).name),
    });
  },

  onShareAppMessage() {
    return { title: "走势图 · 36 种走势算法", path: "/pages/tools/trend/index" };
  },
});
