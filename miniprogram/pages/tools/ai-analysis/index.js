/**
 * AI 分析页
 *
 * 流程：
 *   1. 选彩种 / 号码区 / 统计期数 / 分析风格
 *   2. 前端本地算好统计指标（utils/ai-prompt.js），顺手拼成 prompt
 *   3. 把 prompt + 风格 system 提示词发给模型
 *   4. 渲染模型解读，并附上「这次喂给模型的数字」，让人能核对
 *
 * 为什么不把原始开奖记录直接丢给模型：
 *   - 记录太长，吃上下文
 *   - 模型自己数数会数错，数字必须由代码给
 *
 * 依赖：AI 设置页配好的端点 / 模型 / 密钥（utils/ai.js）。
 */
const api = require("../../../utils/api.js");
const ai = require("../../../utils/ai.js");
const { meta } = require("../../../utils/lottery.js");
const promptMod = require("../../../utils/ai-prompt.js");
const { getLayout } = require("../../../utils/layout.js");

/** 可选统计期数（云端每个彩种最多入库 500 期，这里和它对齐） */
const PERIODS = [30, 50, 100, 200, 300, 500];
/** 一次从云端拉多少期 —— 等于上限，切彩种时整批拉回来缓存 */
const FETCH_COUNT = 500;

Page({
  data: {
    // 选择器
    lotteryKey: "ssq",
    tabs: [],
    periods: PERIODS,
    periodIndex: 2,
    styles: [],
    styleNames: [],
    styleIndex: 0,
    part: "main",
    partOptions: [],
    // 状态
    loading: false,
    running: false,
    error: "",
    hasAI: false,
    aiStatusText: "",
    // 指标
    stats: [],
    hot: [],
    cold: [],
    missing: [],
    promptText: "",
    showPrompt: false,
    // 结果
    result: "",
    resultMeta: "",
    thinking: "",
    showThinking: false,
    truncated: false,
    elapsed: 0,
    bottomPad: 0,
  },

  onLoad() {
    const layout = getLayout();
    const styles = ai.STYLES || [];
    const active = ai.getActive();

    // 分析风格的初值取当前那套配置里存的风格（配置可以各自带一套风格）
    let styleIndex = 0;
    for (let i = 0; i < styles.length; i++) {
      if (styles[i].key === active.style) {
        styleIndex = i;
        break;
      }
    }

    this.setData({
      bottomPad: Math.round(32 * layout.rpxRatio),
      periods: PERIODS,
      styles: styles,
      styleNames: styles.map(function (s) { return s.name; }),
      styleIndex: styleIndex,
      tabs: api.LOTTERIES.map(function (l) {
        return { key: l.key, name: l.name, active: l.key === "ssq" };
      }),
      aiStatusText: ai.describeSettings(),
      hasAI: !!ai.getSettings().apiKey,
    });

    this.applyLottery("ssq");
  },

  /** 从 AI 设置页回来时刷新状态 */
  onShow() {
    this.setData({
      aiStatusText: ai.describeSettings(),
      hasAI: !!ai.getSettings().apiKey,
    });
  },

  /* ---------------- 选择器 ---------------- */

  onSwitchTab(e) {
    const key = e.currentTarget.dataset.key;
    if (!key || key === this.data.lotteryKey) return;
    this.applyLottery(key);
  },

  onSwitchPeriod(e) {
    const idx = Number(e.currentTarget.dataset.index);
    if (isNaN(idx) || idx === this.data.periodIndex) return;
    this.setData({ periodIndex: idx });
    this.rebuild();
  },

  onSwitchStyle(e) {
    const idx = Number(e.currentTarget.dataset.index);
    if (isNaN(idx) || idx === this.data.styleIndex) return;
    this.setData({ styleIndex: idx });
  },

  onSwitchPart(e) {
    const part = e.currentTarget.dataset.part;
    if (!part || part === this.data.part) return;
    this.setData({ part: part });
    this.rebuild();
  },

  /** 切彩种：号码区和数据都要重来 */
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
      result: "",
      resultMeta: "",
      error: "",
    });
    this.loadRows(key);
  },

  /* ---------------- 数据 ---------------- */

  loadRows(key) {
    const self = this;
    this.setData({ loading: true, error: "" });

    if (this._cache && this._cache[key]) {
      this.rebuild();
      this.setData({ loading: false });
      return Promise.resolve();
    }

    return api
      .listDraws(key, FETCH_COUNT)
      .then(function (res) {
        if (!res || !res.success) {
          throw new Error((res && res.message) || "获取开奖数据失败");
        }
        self._cache = self._cache || {};
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

  /** 本地重算指标（不发请求） */
  rebuild() {
    const rows = (this._cache && this._cache[this.data.lotteryKey]) || [];
    if (!rows.length) return;

    const m = meta(this.data.lotteryKey);
    const periods = this.data.periods || PERIODS;
    const limit = periods[this.data.periodIndex] || periods[1];
    // 期号新的在前，所以取前 N 条就是「最近 N 期」
    const slice = rows.slice(0, limit);

    const out = promptMod.buildMetrics(slice, m, this.data.part, m.name);

    this.setData({
      stats: out.stats,
      hot: out.hot,
      cold: out.cold,
      missing: out.missing,
      promptText: out.prompt,
    });
  },

  /* ---------------- 动作 ---------------- */

  /** 生成 AI 分析 */
  onAnalyze() {
    if (this.data.running) return;

    if (!ai.getSettings().apiKey) {
      this.setData({ error: "还没配置 API Key，先去「AI 设置」拉取预置配置" });
      return;
    }

    if (!this.data.promptText) {
      this.setData({ error: "还没有算出指标，稍等一下再试" });
      return;
    }

    const style = (ai.STYLES || [])[this.data.styleIndex] || (ai.STYLES || [])[0];
    const t0 = Date.now();
    const self = this;
    this.setData({ running: true, error: "", result: "", resultMeta: "", thinking: "" });

    // 模型思考可能要半分钟，实时显示秒数，别让页面看着像卡死
    this._timer = setInterval(function () {
      self.setData({ elapsed: Math.round((Date.now() - t0) / 1000) });
    }, 1000);

    ai
      .chat(this.data.promptText, {
        system: style ? style.prompt : "",
        maxTokens: ai.DEFAULT_MAX_TOKENS,
        timeout: 90000,
      })
      .then(function (res) {
        const u = res.usage || {};
        const cfg = ai.getActive();
        self.setData({
          result: res.text || (res.thinking ? "(模型只返回了思考过程，正文没生成)" : "(模型没有返回文字)"),
          thinking: res.thinking || "",
          truncated: !!res.truncated,
          resultMeta:
            "配置「" + (cfg.name || "当前") + "」" +
            " · 模型 " + (res.model || style.name) +
            " · 风格 " + (style ? style.name : "-") +
            " · 耗时 " + (Date.now() - t0) + "ms" +
            (u.input_tokens ? " · 输入 " + u.input_tokens + " tok" : "") +
            (u.output_tokens ? " · 输出 " + u.output_tokens + " tok" : "") +
            (u.output_tokens_details && u.output_tokens_details.thinking_tokens
              ? "（思考 " + u.output_tokens_details.thinking_tokens + "）"
              : ""),
        });
      })
      .catch(function (err) {
        self.setData({ error: (err && err.message) || "调用失败" });
      })
      .then(function () {
        clearInterval(self._timer);
        self.setData({ running: false });
      });
  },

  /** 展开/收起「本次喂给模型的数字」 */
  togglePrompt() {
    this.setData({ showPrompt: !this.data.showPrompt });
  },

  /** 展开/收起「模型思考过程」 */
  toggleThinking() {
    this.setData({ showThinking: !this.data.showThinking });
  },

  goAISettings() {
    wx.navigateTo({ url: "/pages/tools/ai-settings/index" });
  },
});
