/**
 * AI 客户端 —— 客户端直连 MiniMax（Anthropic 兼容协议）
 *
 * ## 为什么是「客户端直连」，而不是走云函数
 *
 * 云函数 `api` 的超时上限是 **3 秒**，而一次 LLM 调用通常 3~30 秒。
 * 把 AI 调用塞进 `api` 必然超时（-504003）。
 * 要走云函数就得另开一个函数并把超时调到 60 秒 —— 那是另一种方案，
 * 好处是 key 留在服务端，代价是多一个要部署和运维的函数。
 * 当前选的是客户端直连：链路最短、改完即生效。
 *
 * ## 为什么 key 还要从云函数取
 *
 * 小程序代码包是**明文分发**的，key 写进包里会被任何人反编译拿到。
 * 所以预置 key 只存在云函数（cloudfunctions/api/ai-config.js），
 * 前端通过 `getAIConfig` 动作按需取，取完只存本机。
 *
 * 说清楚代价：**客户端直连意味着 key 最终会出现在用户手机上**，
 * 用户也可以在「AI 设置」里换成自己的 key。
 * 等 AI 分析真上线、有真实用户了，应该改回云函数代理。
 *
 * ## 协议
 *
 * MiniMax 提供了 Anthropic 兼容端点：
 *   POST {baseUrl}/messages
 *   headers: x-api-key / anthropic-version: 2023-06-01
 *   body   : { model, max_tokens, temperature, messages:[{role,content}] }
 * 响应的 `content` 是一个数组，里面混着 `thinking` 段和 `text` 段，
 * 取文字要挑 `type === "text"` 的块（见 parseMessage）。
 */
const { callFunction } = require("./cloud.js");

/** 云函数名 —— 对应 cloudfunctions/api */
const FN_NAME = "api";

/** 本地存储 key（AI 设置只存本机，不上云） */
const SETTINGS_KEY = "lotteryAISettings";

/**
 * 最多能存几套配置
 *
 * 用户可能同时想用几个模型：快的、强的、自己那把 key 的。
 * 给 3 个位置，既够用又不会让设置页变成表单堆。
 */
const MAX_CONFIGS = 3;

/** 兜底端点 */
const DEFAULT_BASE_URL = "https://api.minimaxi.com/anthropic/v1";

/** 兜底模型列表 */
const DEFAULT_MODELS = [
  { key: "MiniMax-M3.1-Flash", name: "M3.1-Flash · 快，日常够用" },
  { key: "MiniMax-M3", name: "M3 · 强，深度分析用（慢）" },
];

/**
 * 默认 token 额度
 *
 * max_tokens 是「思考 + 正文」**共用**的。M3.1-Flash 强制 adaptive thinking
 * （不能关），一次分析请求光思考就要 1500~3600 token，
 * 给小了会出现「有 thinking、没 text」的假成功。
 */
const DEFAULT_MAX_TOKENS = 8192;

/**
 * 分析风格 —— 写进 system 提示词
 *
 * 这一段是给「AI 分析」用的预留：后面做走势/遗漏/冷热号解读时，
 * 直接把统计指标喂给模型，再挂上这里的 system 提示词。
 */
const STYLES = [
  {
    key: "data",
    name: "数据派",
    prompt:
      "你是彩票数据分析师。回答要基于给定数据，先摆结论再摆依据，" +
      "引用具体数字（频率、遗漏、期号），不做没有数据支撑的断言。" +
      "涉及随机性要明确说明「彩票每期独立，历史不预示未来」。",
  },
  {
    key: "steady",
    name: "稳健派",
    prompt:
      "你是谨慎的彩票数据顾问。先讲风险和不确定性，再讲可能的规律，" +
      "结论要保守，明确指出哪些结论只是小样本波动。" +
      "始终提醒：任何方法都不能提高中奖概率，理性购彩。",
  },
  {
    key: "bold",
    name: "进攻派",
    prompt:
      "你是敢于下判断的彩票分析师。给出明确的倾向性结论和理由，" +
      "同时给出反面证据。语言利落，不说套话。",
  },
];

/** 默认设置 */
const DEFAULT_SETTINGS = {
  baseUrl: DEFAULT_BASE_URL,
  model: DEFAULT_MODELS[0].key,
  apiKey: "",
  temperature: 0.7,
  style: "data",
};

/* ------------------------------------------------------------------ *
 * 配置存取（最多 3 套）
 * ------------------------------------------------------------------ */

/**
 * 存储结构（v2）：
 *
 *   {
 *     version: 2,
 *     activeId: "cfg_xxx",
 *     configs: [
 *       { id, name, baseUrl, model, apiKey, temperature, style },
 *       ...
 *     ]
 *   }
 *
 * v1 是「单套平铺」结构（{ baseUrl, model, apiKey, ... }）。
 * 读到旧结构会自动迁移成 1 套，用户不用重新配。
 */

function newConfigId() {
  return (
    "cfg_" +
    Date.now().toString(36) +
    "_" +
    Math.floor(Math.random() * 1e6).toString(36)
  );
}

function defaultName(index) {
  return "配置 " + (index + 1);
}

/** 补齐缺项（老配置、手写配置都要过一遍） */
function normalizeConfig(raw, index) {
  const s = raw && typeof raw === "object" ? raw : {};
  const name = String(s.name || "").trim();
  return {
    id: s.id || newConfigId(),
    name: name || defaultName(index || 0),
    baseUrl: s.baseUrl || DEFAULT_SETTINGS.baseUrl,
    model: s.model || DEFAULT_SETTINGS.model,
    apiKey: s.apiKey || "",
    temperature:
      typeof s.temperature === "number" ? s.temperature : DEFAULT_SETTINGS.temperature,
    style: s.style || DEFAULT_SETTINGS.style,
  };
}

/** 读全部配置（含旧结构迁移） */
function readStore() {
  let saved = null;
  try {
    saved = wx.getStorageSync(SETTINGS_KEY);
  } catch (e) {
    saved = null;
  }

  // v1 → v2：旧的是单套平铺结构
  if (saved && typeof saved === "object" && !Array.isArray(saved.configs)) {
    const legacy = normalizeConfig(saved, 0);
    saved = { version: 2, activeId: legacy.id, configs: [legacy] };
  }

  const store = saved && typeof saved === "object" ? saved : {};
  const raw = Array.isArray(store.configs) ? store.configs : [];
  const configs = raw.slice(0, MAX_CONFIGS).map(function (c, i) {
    return normalizeConfig(c, i);
  });

  let activeId = store.activeId || "";
  let found = false;
  for (let i = 0; i < configs.length; i++) {
    if (configs[i].id === activeId) {
      found = true;
      break;
    }
  }
  if (!found) activeId = configs.length ? configs[0].id : "";

  return { activeId: activeId, configs: configs };
}

function writeStore(store) {
  try {
    wx.setStorageSync(SETTINGS_KEY, store);
  } catch (e) {
    /* 存不进去也不能让页面崩 */
  }
  return store;
}

/** 全部配置 + 当前选中项 */
function getAll() {
  return readStore();
}

/**
 * 当前选中的那套配置
 *
 * 一套都没有时返回一份默认值（不落盘），
 * 这样设置页的表单永远有初值可编辑。
 */
function getActive() {
  const s = readStore();
  if (!s.configs.length) return normalizeConfig({}, 0);
  for (let i = 0; i < s.configs.length; i++) {
    if (s.configs[i].id === s.activeId) return s.configs[i];
  }
  return s.configs[0];
}

/** 兼容旧调用：等价于 getActive() */
function getSettings() {
  return getActive();
}

/**
 * 更新当前那套配置
 *
 * 一套都没有时自动建出第 1 套。
 */
function saveSettings(patch) {
  const s = readStore();

  if (!s.configs.length) {
    const c = normalizeConfig(patch || {}, 0);
    writeStore({ version: 2, activeId: c.id, configs: [c] });
    return c;
  }

  let idx = 0;
  for (let i = 0; i < s.configs.length; i++) {
    if (s.configs[i].id === s.activeId) {
      idx = i;
      break;
    }
  }

  const next = normalizeConfig(Object.assign({}, s.configs[idx], patch || {}), idx);
  s.configs[idx] = next;
  writeStore({ version: 2, activeId: s.activeId, configs: s.configs });
  return next;
}

/** 按 id 存一套（存在就更新，不存在就新增） */
function saveConfig(cfg) {
  const s = readStore();
  const patch = cfg && typeof cfg === "object" ? cfg : {};
  const id = patch.id || newConfigId();

  let idx = -1;
  for (let i = 0; i < s.configs.length; i++) {
    if (s.configs[i].id === id) {
      idx = i;
      break;
    }
  }

  if (idx < 0) {
    if (s.configs.length >= MAX_CONFIGS) return null;
    const c = normalizeConfig(Object.assign({}, patch, { id: id }), s.configs.length);
    s.configs.push(c);
    if (!s.activeId) s.activeId = c.id;
    writeStore({ version: 2, activeId: s.activeId, configs: s.configs });
    return c;
  }

  const next = normalizeConfig(Object.assign({}, s.configs[idx], patch, { id: id }), idx);
  s.configs[idx] = next;
  writeStore({ version: 2, activeId: s.activeId, configs: s.configs });
  return next;
}

/**
 * 新增一套配置
 *
 * 超过上限返回 null（调用方要提示「最多 3 套」）。
 * 新增的那套自动成为当前选中项 —— 用户刚建完肯定是要填它。
 */
function addConfig(cfg) {
  const s = readStore();
  if (s.configs.length >= MAX_CONFIGS) return null;

  const c = normalizeConfig(Object.assign({}, cfg || {}), s.configs.length);
  c.id = newConfigId();
  s.configs.push(c);
  s.activeId = c.id;
  writeStore({ version: 2, activeId: s.activeId, configs: s.configs });
  return c;
}

/** 删掉一套；删掉的正好是当前选中项时，自动选第一套 */
function removeConfig(id) {
  const s = readStore();
  const before = s.configs.length;
  const kept = [];
  for (let i = 0; i < s.configs.length; i++) {
    if (s.configs[i].id !== id) kept.push(s.configs[i]);
  }
  if (kept.length === before) return false;

  s.configs = kept;
  if (s.activeId === id) s.activeId = kept.length ? kept[0].id : "";
  writeStore({ version: 2, activeId: s.activeId, configs: s.configs });
  return true;
}

/** 切换当前使用的配置 */
function setActive(id) {
  const s = readStore();
  let ok = false;
  for (let i = 0; i < s.configs.length; i++) {
    if (s.configs[i].id === id) {
      ok = true;
      break;
    }
  }
  if (!ok) return false;
  s.activeId = id;
  writeStore({ version: 2, activeId: s.activeId, configs: s.configs });
  return true;
}

/** 清空全部配置 */
function clearSettings() {
  try {
    wx.removeStorageSync(SETTINGS_KEY);
  } catch (e) {
    /* ignore */
  }
  return { version: 2, activeId: "", configs: [] };
}

/** 一句话状态，给「我的」页和 AI 分析页显示 */
function describeSettings() {
  const s = readStore();
  if (!s.configs.length) return "未配置 · 点这里设置模型与密钥";

  const a = getActive();
  const more = s.configs.length > 1 ? "（共 " + s.configs.length + " 套）" : "";
  if (!a.apiKey) return "未配置密钥 · " + a.name + more;
  return "已配置 · " + a.name + " · " + a.model + more;
}

/** 按 key 找风格 */
function getStyle(key) {
  for (let i = 0; i < STYLES.length; i++) {
    if (STYLES[i].key === key) return STYLES[i];
  }
  return STYLES[0];
}

/* ------------------------------------------------------------------ *
 * 预置配置
 * ------------------------------------------------------------------ */

/**
 * 从云函数拉服务端预置配置（端点 + 模型 + 预置 key）
 *
 * 走云函数只是为了不把 key 打进代码包 —— AI 调用本身仍然是客户端直连。
 */
function fetchPreset(options) {
  return callFunction(FN_NAME, { type: "getAIConfig" }, options).then(function (res) {
    if (!res || !res.success) {
      throw new Error((res && res.message) || "拉取预置配置失败");
    }
    const data = res.data || {};
    return {
      baseUrl: data.baseUrl || DEFAULT_BASE_URL,
      models: Array.isArray(data.models) && data.models.length ? data.models : DEFAULT_MODELS,
      apiKey: data.apiKey || "",
    };
  });
}

/* ------------------------------------------------------------------ *
 * 模型调用
 * ------------------------------------------------------------------ */

/** 拆响应：把 thinking 段和 text 段分开 */
function parseMessage(data) {
  const content = (data && data.content) || [];
  let text = "";
  let thinking = "";
  for (let i = 0; i < content.length; i++) {
    const c = content[i];
    if (!c) continue;
    if (c.type === "text" && c.text) text += c.text;
    else if (c.type === "thinking" && c.thinking) thinking += c.thinking;
  }
  return {
    text: text.trim(),
    thinking: thinking.trim(),
    model: (data && data.model) || "",
    usage: (data && data.usage) || {},
    stopReason: (data && data.stop_reason) || "",
    // 额度用完 = 回复被截断
    truncated: (data && data.stop_reason) === "max_tokens",
  };
}

/**
 * 调一次模型
 *
 * @param {string} prompt 用户提示词
 * @param {object} options { baseUrl, model, apiKey, temperature, maxTokens, system, timeout }
 * @returns {Promise<{text,thinking,model,usage,stopReason,truncated}>}
 *
 * ⚠️ **max_tokens 是「思考 + 正文」共用的额度**，这是 MiniMax 这个端点最容易踩的坑：
 * M3.1-Flash 强制 adaptive thinking（`thinking.type="disabled"` 会直接 400），
 * 一次分析请求的思考部分常常要吃掉 1500~3600 token。
 * 如果 max_tokens 给小了（比如 2048），会出现
 * 「模型返回 200、stop_reason=end_turn，但 content 里只有 thinking、没有 text」
 * —— 页面上显示成「模型没有返回文字」。
 * 所以默认给到 8192。
 */
function chat(prompt, options) {
  const opts = options || {};
  const s = getSettings();

  const apiKey = opts.apiKey || s.apiKey;
  if (!apiKey) {
    return Promise.reject(new Error("还没配置 API Key，先点「拉取预置配置」或自己填一把"));
  }

  const baseUrl = String(opts.baseUrl || s.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const url = baseUrl + "/messages";

  // Anthropic Messages 协议里 system 是**顶层参数**，不能塞进 messages 当 user 消息
  const payload = {
    model: opts.model || s.model,
    max_tokens: opts.maxTokens || DEFAULT_MAX_TOKENS,
    temperature:
      typeof opts.temperature === "number" ? opts.temperature : s.temperature,
    messages: [{ role: "user", content: prompt }],
  };
  if (opts.system) {
    payload.system = opts.system;
  }

  return new Promise(function (resolve, reject) {
    wx.request({
      url: url,
      method: "POST",
      timeout: opts.timeout || 90000,
      header: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      data: payload,
      success: function (res) {
        if (res.statusCode !== 200) {
          const msg = (res.data && (res.data.message || res.data.error)) || "";
          reject(new Error("模型接口返回 " + res.statusCode + (msg ? "：" + msg : "")));
          return;
        }
        resolve(parseMessage(res.data));
      },
      fail: function (err) {
        const raw = (err && (err.errMsg || err.message)) || "网络请求失败";
        // 真机直连外部域名必须先在 MP 后台配 request 合法域名
        if (raw.indexOf("url not in domain list") > -1 || raw.indexOf("不在以下 request 合法域名列表中") > -1) {
          reject(new Error("域名未加白名单：MP 后台 → 开发管理 → 服务器域名 → request 合法域名，加上 api.minimaxi.com"));
          return;
        }
        reject(new Error(raw));
      },
    });
  });
}

/**
 * 连接测试 —— 发一句最短的话，看能不能拿到回复
 *
 * 返回 { text, elapsed, model, usage }
 */
function testConnection(options) {
  const opts = options || {};
  const t0 = Date.now();
  // 连接测试只问一句话，给小额度够用；正式分析走 chat() 的默认值
  return chat("用一句话介绍你自己，不要超过 20 字。", Object.assign({}, opts, {
    maxTokens: opts.maxTokens || 1024,
  })).then(function (res) {
    if (!res.text && res.thinking) {
      throw new Error(
        "模型这次只返回了思考过程、没有正文 —— 这是 max_tokens 被思考吃光的典型症状，" +
          "换个模型或稍后重试"
      );
    }
    return {
      text: res.text,
      thinking: res.thinking,
      model: res.model,
      usage: res.usage,
      elapsed: Date.now() - t0,
    };
  });
}

module.exports = {
  FN_NAME: FN_NAME,
  SETTINGS_KEY: SETTINGS_KEY,
  MAX_CONFIGS: MAX_CONFIGS,
  DEFAULT_BASE_URL: DEFAULT_BASE_URL,
  DEFAULT_MODELS: DEFAULT_MODELS,
  DEFAULT_MAX_TOKENS: DEFAULT_MAX_TOKENS,
  STYLES: STYLES,
  getAll: getAll,
  getActive: getActive,
  getSettings: getSettings,
  saveSettings: saveSettings,
  saveConfig: saveConfig,
  addConfig: addConfig,
  removeConfig: removeConfig,
  setActive: setActive,
  clearSettings: clearSettings,
  describeSettings: describeSettings,
  getStyle: getStyle,
  fetchPreset: fetchPreset,
  chat: chat,
  testConnection: testConnection,
  parseMessage: parseMessage,
};
