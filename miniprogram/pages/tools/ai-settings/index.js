/**
 * AI 设置页
 *
 * 这一页负责「能不能调模型」这件事的全部配置：
 *   端点 / 模型 / API Key / 温度 / 分析风格。
 *
 * 最多能存 **3 套配置**（utils/ai.js 的 MAX_CONFIGS）：
 * 用户可能同时想用几个模型 —— 快的、强的、自己那把 key 的。
 * 上面一排卡片切换当前用哪套，下面「模型与密钥」编辑的就是当前那套。
 *
 * 为什么模型调用是客户端直连（wx.request），不走云函数：
 *   云函数 api 的超时上限 3 秒，而一次 LLM 调用要 3~30 秒，必然超时。
 *
 * 为什么 Key 要先「拉取预置配置」：
 *   小程序代码包是明文分发的，key 写进包里会被反编译拿到。
 *   预置 key 放在云函数里，前端按需取，取完只存本机。
 *
 * 配置只存本机（wx.setStorageSync），不上云 —— 换设备要重新拉一次预置。
 */
const ai = require("../../../utils/ai.js");

Page({
  data: {
    // 配置列表
    configs: [],
    activeId: "",
    activeIndex: 0,
    canAdd: true,
    // 表单
    configName: "",
    baseUrl: "",
    model: "",
    models: [],
    modelNames: [],
    modelIndex: 0,
    apiKey: "",
    showKey: false,
    temperature: 0.7,
    styleIndex: 0,
    styleNames: [],
    // 状态
    loading: false,
    testing: false,
    error: "",
    result: "",
    resultMeta: "",
    thinking: "",
    hasKey: false,
  },

  onLoad() {
    this.loadFromStorage();
  },

  /** 从本地读设置并铺到表单上 */
  loadFromStorage() {
    const store = ai.getAll();
    const s = ai.getActive();

    const configs = (store.configs || []).map(function (c, i) {
      return {
        id: c.id,
        name: c.name,
        model: c.model,
        // 卡片窄，模型名去掉 MiniMax- 前缀才放得下
        shortModel: String(c.model || "").replace(/^MiniMax-/, ""),
        hasKey: !!c.apiKey,
        active: c.id === store.activeId,
        index: i,
      };
    });

    let activeIndex = 0;
    for (let i = 0; i < configs.length; i++) {
      if (configs[i].active) {
        activeIndex = i;
        break;
      }
    }

    const models = (ai.DEFAULT_MODELS || []).slice();

    // 存过的模型不在默认列表里（比如手动改过），补进去免得选不回来
    if (s.model) {
      let known = false;
      for (let i = 0; i < models.length; i++) {
        if (models[i].key === s.model) {
          known = true;
          break;
        }
      }
      if (!known) {
        models.unshift({ key: s.model, name: s.model + " · 自定义" });
      }
    }

    const styleNames = ai.STYLES.map(function (st) { return st.name; });
    let styleIndex = 0;
    for (let i = 0; i < ai.STYLES.length; i++) {
      if (ai.STYLES[i].key === s.style) {
        styleIndex = i;
        break;
      }
    }

    let modelIndex = 0;
    for (let i = 0; i < models.length; i++) {
      if (models[i].key === s.model) {
        modelIndex = i;
        break;
      }
    }

    this.setData({
      configs: configs,
      activeId: store.activeId,
      activeIndex: activeIndex,
      canAdd: configs.length < ai.MAX_CONFIGS,
      configName: s.name,
      baseUrl: s.baseUrl,
      model: s.model,
      models: models,
      modelNames: models.map(function (m) { return m.name; }),
      modelIndex: modelIndex,
      apiKey: s.apiKey,
      temperature: s.temperature,
      styleNames: styleNames,
      styleIndex: styleIndex,
      hasKey: !!s.apiKey,
    });
  },

  /* ---------------- 表单 ---------------- */

  onNameInput(e) {
    this.setData({ configName: e.detail.value || "" });
  },

  onBaseUrlInput(e) {
    this.setData({ baseUrl: e.detail.value || "" });
  },

  onKeyInput(e) {
    const v = e.detail.value || "";
    this.setData({ apiKey: v, hasKey: !!v });
  },

  toggleKey() {
    this.setData({ showKey: !this.data.showKey });
  },

  onModelChange(e) {
    const idx = Number(e.detail.value) || 0;
    const model = this.data.models[idx];
    this.setData({ modelIndex: idx, model: model ? model.key : this.data.model });
  },

  onStyleChange(e) {
    this.setData({ styleIndex: Number(e.detail.value) || 0 });
  },

  onTempChange(e) {
    this.setData({ temperature: Math.round(Number(e.detail.value) * 100) / 100 });
  },

  /* ---------------- 配置切换 ---------------- */

  /** 点卡片切换当前使用的配置（切换前先把当前这套存了，别丢改动） */
  onSwitchConfig(e) {
    const id = e.currentTarget.dataset.id;
    if (!id || id === this.data.activeId) return;

    this.saveSettings(true);
    if (ai.setActive(id)) {
      this.loadFromStorage();
    }
  },

  /** 新增一套（最多 3 套） */
  onAddConfig() {
    if (this.data.configs.length >= ai.MAX_CONFIGS) {
      wx.showToast({ title: "最多只能配 " + ai.MAX_CONFIGS + " 套", icon: "none" });
      return;
    }

    this.saveSettings(true);
    const c = ai.addConfig({
      name: "配置 " + (this.data.configs.length + 1),
      baseUrl: ai.DEFAULT_BASE_URL,
      model: (ai.DEFAULT_MODELS[0] || {}).key || "",
    });
    if (!c) {
      wx.showToast({ title: "最多只能配 " + ai.MAX_CONFIGS + " 套", icon: "none" });
      return;
    }
    this.loadFromStorage();
    wx.showToast({ title: "已新增 " + c.name, icon: "none" });
  },

  /** 删掉当前这套 */
  onDeleteConfig() {
    const id = this.data.activeId;
    if (!id) {
      wx.showToast({ title: "当前没有可删除的配置", icon: "none" });
      return;
    }

    const name = this.data.configName || "当前配置";
    ai.removeConfig(id);
    this.loadFromStorage();
    wx.showToast({ title: "已删除 " + name, icon: "none" });
  },

  /* ---------------- 动作 ---------------- */

  /** 从云函数拉服务端预置配置（端点 + 模型 + 预置 key） */
  fetchPreset() {
    if (this.data.loading) return;
    this.setData({ loading: true, error: "" });

    const self = this;
    ai
      .fetchPreset({ timeout: 8000 })
      .then(function (preset) {
        const models = preset.models && preset.models.length
          ? preset.models
          : ai.DEFAULT_MODELS;

        let modelIndex = 0;
        for (let i = 0; i < models.length; i++) {
          if (models[i].key === self.data.model) {
            modelIndex = i;
            break;
          }
        }
        if (modelIndex < 0) modelIndex = 0;

        const model = models[modelIndex] ? models[modelIndex].key : self.data.model;

        self.setData({
          baseUrl: preset.baseUrl,
          models: models,
          modelNames: models.map(function (m) { return m.name; }),
          modelIndex: modelIndex,
          model: model,
          apiKey: preset.apiKey || self.data.apiKey,
          hasKey: !!(preset.apiKey || self.data.apiKey),
        });

        // 拉到了就顺手存下来，用户下次进来直接能用
        if (preset.apiKey) {
          ai.saveSettings({
            baseUrl: self.data.baseUrl,
            model: model,
            apiKey: preset.apiKey,
          });
        }

        if (!preset.apiKey) {
          self.setData({ error: "服务端没有预置密钥，请自己填一把 API Key" });
        } else {
          wx.showToast({ title: "预置配置已拉取", icon: "success" });
        }
      })
      .catch(function (err) {
        self.setData({ error: (err && err.message) || "拉取预置配置失败" });
      })
      .then(function () {
        self.setData({ loading: false });
      });
  },

  /** 真实调一次模型 —— 连接测试 */
  testConnection() {
    if (this.data.testing) return;
    this.setData({ testing: true, error: "", result: "", resultMeta: "", thinking: "" });

    const self = this;
    // 先把表单上的改动存了再测，否则测的是旧配置
    this.saveSettings(true);

    ai
      .testConnection({ timeout: 60000 })
      .then(function (res) {
        const u = res.usage || {};
        const meta =
          "模型 " + (res.model || self.data.model) +
          " · 耗时 " + (res.elapsed || 0) + "ms" +
          (u.input_tokens ? " · 输入 " + u.input_tokens + " tok" : "") +
          (u.output_tokens ? " · 输出 " + u.output_tokens + " tok" : "");

        self.setData({ result: res.text || "(模型没有返回文字)", resultMeta: meta });
      })
      .catch(function (err) {
        self.setData({ error: (err && err.message) || "连接失败" });
      })
      .then(function () {
        self.setData({ testing: false });
      });
  },

  /** 保存设置（静默模式给「测试连接」用，不弹 toast） */
  saveSettings(silent) {
    const style = this.data.styleNames[this.data.styleIndex];
    let styleKey = "data";
    for (let i = 0; i < ai.STYLES.length; i++) {
      if (ai.STYLES[i].name === style) {
        styleKey = ai.STYLES[i].key;
        break;
      }
    }

    ai.saveSettings({
      name: this.data.configName,
      baseUrl: this.data.baseUrl,
      model: this.data.model,
      apiKey: this.data.apiKey,
      temperature: this.data.temperature,
      style: styleKey,
    });

    if (!silent) {
      this.loadFromStorage();
      wx.showToast({ title: "已保存", icon: "success" });
    }
    return true;
  },

  onSave() {
    this.saveSettings(false);
  },

  /** 去 AI 分析页 */
  goAIAnalysis() {
    wx.navigateTo({ url: "/pages/tools/ai-analysis/index" });
  },

  /** 清除本机全部配置 */
  onClear() {
    ai.clearSettings();
    this.loadFromStorage();
    this.setData({
      apiKey: "",
      hasKey: false,
      result: "",
      resultMeta: "",
      thinking: "",
      error: "",
    });
    wx.showToast({ title: "已清除全部配置", icon: "none" });
  },
});
