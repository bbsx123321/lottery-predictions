/**
 * 云函数 API 层
 *
 * 所有对云函数的调用都从这里走，页面层不直接碰 wx.cloud.callFunction。
 * 好处：
 *   1. 函数名只有一处 —— 改目录名/函数名只改这一行；
 *   2. 入参出参形状固定，页面不用每次拼 type；
 *   3. 错误统一由 utils/cloud.js 翻译并弹提示。
 *
 * 函数名必须与 cloudfunctions/ 下的目录名一致（目录名即函数名）。
 */
const { callFunction } = require("./cloud.js");
const { LOTTERIES } = require("./lottery.js");

/** 云函数名 —— 对应 cloudfunctions/api */
const FN_NAME = "api";

/** 拉某个彩种的彩种信息 */
function lotteryMeta(key) {
  for (let i = 0; i < LOTTERIES.length; i++) {
    if (LOTTERIES[i].key === key) return LOTTERIES[i];
  }
  return null;
}

/** 环境探活：返回环境信息、集合自检与各彩种本地已同步到哪一期 */
function health(options) {
  return callFunction(FN_NAME, { type: "health" }, options);
}

/** 探测上游数据源连通性（真实发请求到福彩/体彩官方接口，会慢一点） */
function checkSources(options) {
  return callFunction(FN_NAME, { type: "checkSources" }, options);
}

/** 同步某彩种：拉取最近 limit 期并入库 */
function syncDraws(lottery, limit) {
  return callFunction(FN_NAME, {
    type: "syncDraws",
    lottery: lottery || "ssq",
    limit: limit || 100,
  });
}

/** 四个彩种全量同步 */
function syncAll(limit) {
  return callFunction(FN_NAME, { type: "syncAll", limit: limit || 100 });
}

/**
 * 兜底自动同步（页面打开时调）
 *
 * 定时触发器需要手动上传 config.json 才生效；本动作保证即使没上传，
 * 只要有人打开小程序，数据也会按需补拉。服务端会先判断是否过期，
 * 没过期直接返回 skipped，不产生多余的上游请求。
 */
function autoSync(options) {
  const opts = options || {};
  return callFunction(
    FN_NAME,
    {
      type: "autoSync",
      maxAgeHours: opts.maxAgeHours || 6,
      force: !!opts.force,
    },
    opts
  );
}

/** 读取已入库的开奖记录 */
function listDraws(lottery, limit) {
  return callFunction(FN_NAME, {
    type: "listDraws",
    lottery: lottery || "ssq",
    limit: limit || 100,
  });
}

/**
 * 保存当前用户对某期的预测（同一期覆盖）
 * @param {{period:string, reds:number[], blue:number}} payload
 */
function savePrediction(payload) {
  const p = payload || {};
  return callFunction(FN_NAME, {
    type: "savePrediction",
    period: p.period,
    reds: p.reds,
    blue: p.blue,
  });
}

/** 列出当前用户的预测记录（按期号倒序） */
function listPredictions() {
  return callFunction(FN_NAME, { type: "listPredictions" });
}

/**
 * 微信登录授权
 *
 * 云函数里 cloud.getWXContext().OPENID 就是当前用户身份，
 * 所以这里不需要前端传 wx.login 的 code —— 传昵称/头像更新资料即可。
 */
function login(payload, options) {
  const p = payload || {};
  return callFunction(
    FN_NAME,
    {
      type: "login",
      nickname: p.nickname || "",
      avatar: p.avatar || "",
    },
    options
  );
}

/**
 * 保存一批模拟选号记录
 * @param {{lottery:string, lotteryName:string, mode:string, strategy:string, groups:Array}} payload
 */
function savePicks(payload, options) {
  const p = payload || {};
  return callFunction(
    FN_NAME,
    {
      type: "savePicks",
      lottery: p.lottery || "ssq",
      lotteryName: p.lotteryName || "",
      mode: p.mode || "lucky",
      strategy: p.strategy || "weighted",
      groups: p.groups || [],
    },
    options
  );
}

/** 列出当前用户的模拟选号记录（新的在前） */
function listPicks(options) {
  return callFunction(FN_NAME, { type: "listPicks" }, options);
}

module.exports = {
  FN_NAME,
  LOTTERIES,
  lotteryMeta,
  health,
  checkSources,
  syncDraws,
  syncAll,
  autoSync,
  listDraws,
  savePrediction,
  listPredictions,
  login,
  savePicks,
  listPicks,
};
