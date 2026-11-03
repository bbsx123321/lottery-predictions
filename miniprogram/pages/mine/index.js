const api = require("../../utils/api.js");
const ai = require("../../utils/ai.js");
const { getLayout } = require("../../utils/layout.js");

/** 登录态存本地，退出登录时清掉 */
const STORAGE_KEY = "lotteryProfile";
/** 还没登录时填的昵称先放这儿，等头像授权时一起提交 */
const DRAFT_KEY = "lotteryNicknameDraft";

/** 选号模式 / 策略的中文名（跟选号页一致） */
const MODE_NAMES = { lucky: "幸运选号", simulate: "模拟选号" };
const STRATEGY_NAMES = { weighted: "热号优先", pure: "纯随机", shape: "按历史形态" };

/** 时间戳 -> "10-30 15:30" */
function timeText(ts) {
  const d = new Date(Number(ts) || Date.now());
  const p = function (n) {
    return n < 10 ? "0" + n : String(n);
  };
  return (
    p(d.getMonth() + 1) +
    "-" +
    p(d.getDate()) +
    " " +
    p(d.getHours()) +
    ":" +
    p(d.getMinutes())
  );
}

/** 云端记录 -> 渲染结构 */
function decorate(row) {
  const groups = (row.groups || []).map(function (g, i) {
    return {
      label: "第 " + (i + 1) + " 组",
      main: g.main || [],
      extra: g.extra || [],
      sum: g.sum,
      span: g.span,
    };
  });

  return {
    id: row._id,
    lotteryName: row.lotteryName || row.lottery || "",
    modeName: MODE_NAMES[row.mode] || row.mode || "",
    strategyName: STRATEGY_NAMES[row.strategy] || row.strategy || "",
    timeText: timeText(row.createdAt),
    groups: groups,
  };
}

Page({
  data: {
    loading: false,
    logging: false,
    uploading: false,
    error: "",
    logged: false,
    profile: null,
    records: [],
    // 还没登录时填的昵称 / 已选好待提交的头像
    nicknameDraft: "",
    avatarDraft: "",
    // 头像占位上显示的那个字（昵称首字）
    // 注意：WXML 里不能调 .slice()，必须在 JS 里算好
    profileInitial: "我",
    // 「AI 设置」入口上的状态文案
    aiStatusText: "",
    bottomPad: 0,
  },

  onLoad() {
    const layout = getLayout();
    this.setData({
      bottomPad: Math.round(24 * layout.rpxRatio),
      nicknameDraft: wx.getStorageSync(DRAFT_KEY) || "",
      aiStatusText: ai.describeSettings(),
    });

    // 上次登录过就先直接展示（不用每次进来都等一次云函数）
    const cached = wx.getStorageSync(STORAGE_KEY);
    if (cached && cached.openid) {
      this.setData({
        logged: true,
        profile: cached,
        nicknameDraft: cached.nickname || "",
        profileInitial: (cached.nickname || "我").slice(0, 1),
      });
      this.loadRecords();
    }
  },

  /**
   * 授权登录（核心动作）
   *
   * 微信 2021 年后废弃了 wx.getUserProfile —— 它只能拿到灰头像和默认昵称。
   * 现在能拿到**用户自己的头像和昵称**的合规路径只有两个：
   *   头像：<button open-type="chooseAvatar">  选完给一个临时文件路径
   *   昵称：<input type="nickname">            填完给昵称字符串
   * 两者都需要用户主动手势，程序没法代替。
   *
   * 所以这里的流程是：
   *   点头像 → 微信选图器 → 上传云存储拿 fileID → 连同昵称一起 login
   *   点昵称 → 微信昵称面板 → blur 时单独更新昵称
   *
   * 云函数里 cloud.getWXContext().OPENID 就是身份，
   * 不需要 wx.login 换 code。
   */
  doLogin(patch) {
    const self = this;
    const p = patch || {};

    const nickname =
      p.nickname !== undefined
        ? p.nickname
        : this.data.nicknameDraft || wx.getStorageSync(DRAFT_KEY) || "";
    const avatar = p.avatar !== undefined ? p.avatar : this.data.avatarDraft || "";

    return api
      .login({ nickname: nickname, avatar: avatar }, { timeout: 8000 })
      .then(function (res) {
        if (!res || !res.success) {
          throw new Error((res && res.message) || "登录失败");
        }
        const profile = res.data || {};
        wx.setStorageSync(STORAGE_KEY, profile);
        wx.removeStorageSync(DRAFT_KEY);
        self._lastSavedNick = profile.nickname || "";
        self.setData({
          logged: true,
          profile: profile,
          nicknameDraft: profile.nickname || "",
          avatarDraft: profile.avatar || "",
          profileInitial: (profile.nickname || "我").slice(0, 1),
        });
        return self.loadRecords();
      });
  },

  /** 点「微信授权登录」：只提交昵称（没头像也能登录） */
  onLogin() {
    if (this.data.logging) return;
    this.setData({ logging: true, error: "" });
    const self = this;

    this.doLogin({})
      .then(function () {
        wx.showToast({ title: "登录成功", icon: "success" });
      })
      .catch(function (err) {
        self.setData({ error: (err && err.message) || "登录失败" });
      })
      .then(function () {
        self.setData({ logging: false });
      });
  },

  /**
   * 选头像 —— 平台规定只能用 open-type="chooseAvatar" 的 button
   *
   * chooseAvatar 给的是临时文件（wxfile:// 开头，几分钟就失效），
   * 必须先传到云存储，再把 fileID 存进用户资料。
   */
  onChooseAvatar(e) {
    const tempPath = e.detail && e.detail.avatarUrl;
    if (!tempPath) return;

    const self = this;
    this.setData({ uploading: true });
    const cloudPath =
      "avatars/" + Date.now() + "_" + Math.floor(Math.random() * 100000) + ".png";

    wx.cloud
      .uploadFile({ cloudPath: cloudPath, filePath: tempPath })
      .then(function (res) {
        // 先把头像显示出来，登录失败也不至于白选
        self.setData({ avatarDraft: res.fileID });
        return self.doLogin({ avatar: res.fileID });
      })
      .then(function () {
        wx.showToast({ title: "授权成功", icon: "success" });
      })
      .catch(function (err) {
        wx.showToast({
          title: (err && (err.errMsg || err.message)) || "头像上传失败",
          icon: "none",
        });
      })
      .then(function () {
        self.setData({ uploading: false });
      });
  },

  /** 昵称输入：只更新本地草稿，不发请求（避免每敲一个字就调一次云函数） */
  onNicknameInput(e) {
    this.setData({ nicknameDraft: e.detail.value || "" });
  },

  /** 昵称提交（失焦或按键盘完成）：这时才写云端 */
  onNickname(e) {
    const nickname = (e.detail && e.detail.value) || "";
    this.setData({ nicknameDraft: nickname });
    if (!nickname) return;

    // 跟上次存的一样就别重复提交
    if (nickname === this._lastSavedNick) return;

    if (this.data.logged) {
      this.updateProfile({ nickname: nickname });
    } else {
      // 还没登录：先存本地，等头像授权时一起提交
      wx.setStorageSync(DRAFT_KEY, nickname);
    }
  },

  /** 更新资料（昵称 / 头像） */
  updateProfile(patch) {
    const self = this;

    return api
      .login(patch, { timeout: 8000 })
      .then(function (res) {
        if (!res || !res.success) {
          throw new Error((res && res.message) || "保存失败");
        }
        const profile = res.data || {};
        wx.setStorageSync(STORAGE_KEY, profile);
        self._lastSavedNick = profile.nickname || "";
        self.setData({
          profile: profile,
          nicknameDraft: profile.nickname || "",
          profileInitial: (profile.nickname || "我").slice(0, 1),
        });
        return profile;
      })
      .catch(function (err) {
        wx.showToast({ title: (err && err.message) || "保存失败", icon: "none" });
      });
  },

  /** 拉当前用户的模拟选号记录 */
  loadRecords() {
    const self = this;
    this.setData({ loading: true, error: "" });

    return api
      .listPicks({ timeout: 8000 })
      .then(function (res) {
        if (!res || !res.success) {
          throw new Error((res && res.message) || "获取记录失败");
        }
        const rows = Array.isArray(res.data) ? res.data : [];
        self.setData({ records: rows.map(decorate) });
        self.setData({ loading: false });
      })
      .catch(function (err) {
        self.setData({
          loading: false,
          error: (err && err.message) || "获取记录失败",
        });
      });
  },

  /** 退出登录（只清本地登录态，云端记录留着） */
  onLogout() {
    wx.removeStorageSync(STORAGE_KEY);
    wx.removeStorageSync(DRAFT_KEY);
    this.setData({
      logged: false,
      profile: null,
      records: [],
      nicknameDraft: "",
      avatarDraft: "",
    });
    wx.showToast({ title: "已退出登录", icon: "none" });
  },

  onPullDownRefresh() {
    const self = this;
    const p = this.data.logged ? this.loadRecords() : Promise.resolve();
    p.then(function () {
      wx.stopPullDownRefresh();
    });
  },

  /** 从 AI 设置页回来时刷新一下状态文案 */
  onShow() {
    this.setData({ aiStatusText: ai.describeSettings() });
  },

  /** 进入 AI 设置页 */
  goAISettings() {
    wx.navigateTo({ url: "/pages/tools/ai-settings/index" });
  },
});
