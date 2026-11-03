/**
 * 彩票预测云函数 api
 *
 * 约束（体验版免费套餐，不可改）：
 *   云函数执行超时固定 3 秒，内存 256MB，冷启动还要吃掉 0.6~1.2 秒，
 *   业务逻辑的实际预算约 2.3 秒。所以这里的查询要并发、批量要小。
 *
 * 权限：
 *   集合权限保持默认「仅创建者可读写」，前端不直连数据库。
 *   云函数以管理员身份读写，能看到全部数据 —— 所以访问用户私有数据必须带 _openid 条件。
 *
 * 数据来源：
 *   开奖数据由 sources.js 从福彩/体彩官方接口按需拉取并入库，
 *   本函数不内置开奖数据 —— 官方源每期开奖后即更新，永远是最新的。
 *
 * 动作：
 *   health          环境与集合自检（只读本地，快）
 *   checkSources    探测四个上游数据源连通性（真实发请求）
 *   syncDraws       拉取某彩种最近 N 期并入库
 *   syncAll         四个彩种全量同步（定时触发器用）
 *   autoSync        兜底自动同步：过期才动，上游无新期号就只刷时间戳
 *   listDraws       读取已入库的开奖记录
 *   savePrediction  保存/覆盖当前用户对某期的预测
 *   listPredictions 列出当前用户的预测记录
 *   login           微信登录授权：登记/更新用户资料（昵称、头像）
 *   savePicks       保存当前用户的一批模拟选号记录
 *   listPicks       列出当前用户的模拟选号记录
 */
const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const { LOTTERIES, DEFAULT_LIMIT, MAX_LIMIT, fetchUpstream, probeAll } = require("./sources.js");

const DRAWS = db.collection("lotteryDraws");
const PREDICTIONS = db.collection("lotteryPredictions");
const SYNC_META = db.collection("lotterySyncMeta");
const USERS = db.collection("lotteryUsers");
const PICKS = db.collection("lotteryPicks");

const DRAWS_NAME = "lotteryDraws";
const PREDICTIONS_NAME = "lotteryPredictions";
const SYNC_META_NAME = "lotterySyncMeta";
const USERS_NAME = "lotteryUsers";
const PICKS_NAME = "lotteryPicks";

const MAX_PREDICTIONS = 50;
/** 我的模拟选号记录最多保留/返回多少条 */
const MAX_PICKS = 50;

/** 双色球：红球 6 个（1-33），蓝球 1 个（1-16） */
const RED_COUNT = 6;
const RED_MAX = 33;
const BLUE_MAX = 16;

/* ---------------- 集合自建 ---------------- */

function isCollectionMissing(err) {
  const msg = (err && (err.errMsg || err.message)) || "";
  return msg.indexOf("-502005") > -1 || msg.indexOf("not exist") > -1;
}

/** 文档不存在（跟集合不存在不是一回事，集合要先建） */
function isDocMissing(err) {
  const msg = (err && (err.errMsg || err.message)) || "";
  return msg.indexOf("does not exist") > -1;
}

async function createCollection(name) {
  try {
    await db.createCollection(name);
    console.log("[api] 已创建集合 " + name);
    return true;
  } catch (e) {
    // 已存在时也会抛错，这里只记录不抛出
    console.log("[api] createCollection " + name + " -> " + ((e && e.errMsg) || e));
    return false;
  }
}

async function withCollection(name, fn) {
  try {
    return await fn();
  } catch (e) {
    if (!isCollectionMissing(e)) throw e;
    await createCollection(name);
    return await fn();
  }
}

/* ---------------- 工具 ---------------- */

/** 确定性 _id：同一彩种同一期只会有一条记录，重复同步是幂等的 */
function drawId(lottery, period) {
  return lottery + "-" + period;
}

function nowIso() {
  return new Date().toISOString();
}

/* ---------------- 业务 ---------------- */

async function health() {
  const ctx = cloud.getWXContext();

  // 五个集合并发探活，别串行
  const [drawsRes, predictionsRes, metaRes, usersRes, picksRes] = await Promise.all([
    withCollection(DRAWS_NAME, () => DRAWS.limit(1).get()),
    withCollection(PREDICTIONS_NAME, () => PREDICTIONS.limit(1).get()),
    // 同步元信息每个彩种一条，要全部读出来（limit(1) 会漏掉三个彩种）
    withCollection(SYNC_META_NAME, () => SYNC_META.limit(20).get()),
    withCollection(USERS_NAME, () => USERS.limit(1).get()),
    withCollection(PICKS_NAME, () => PICKS.limit(1).get()),
  ]);

  const metas = metaRes.data || [];
  const byLottery = {};
  metas.forEach(function (m) {
    byLottery[m.lottery] = m;
  });

  return {
    message: "云函数运行正常",
    openid: ctx.OPENID || "",
    serverTime: nowIso(),
    collections: [
      { name: DRAWS_NAME, ok: true, sample: drawsRes.data.length },
      { name: PREDICTIONS_NAME, ok: true, sample: predictionsRes.data.length },
      { name: SYNC_META_NAME, ok: true, sample: metas.length },
      { name: USERS_NAME, ok: true, sample: usersRes.data.length },
      { name: PICKS_NAME, ok: true, sample: picksRes.data.length },
    ],
    // 各彩种本地已存到哪一期
    synced: Object.keys(LOTTERIES).map(function (key) {
      const m = byLottery[key];
      return {
        lottery: key,
        name: LOTTERIES[key].name,
        latestPeriod: m ? m.latestPeriod : "",
        latestDate: m ? m.latestDate : "",
        lastSyncAt: m ? m.lastSyncAt : "",
        count: m ? m.count : 0,
      };
    }),
  };
}

/** 探测上游数据源连通性 —— 真实发请求，会慢一点 */
async function checkSources() {
  const probes = await probeAll();
  return {
    serverTime: nowIso(),
    sources: probes,
    allOk: probes.every(function (p) {
      return p.ok;
    }),
  };
}

/**
 * 拉取某彩种最近 N 期并入库
 * 幂等：已存在的期号跳过，只插入新增的
 */
async function syncOne(lotteryKey, limit) {
  const meta = LOTTERIES[lotteryKey];
  if (!meta) throw new Error("不支持的彩种: " + lotteryKey);

  const n = Math.min(Math.max(parseInt(limit, 10) || DEFAULT_LIMIT, 1), MAX_LIMIT);

  // 1. 拉上游（这一步占掉预算的大头）
  const rows = await fetchUpstream(lotteryKey, n);
  if (!rows.length) throw new Error("上游未返回数据: " + meta.name);

  // 2. 查哪些已存在（一次 in 查询，不要逐条查）
  const ids = rows.map(function (d) {
    return drawId(d.lottery, d.period);
  });
  const existRes = await withCollection(DRAWS_NAME, () => queryExistingIds(ids));
  const existIds = {};
  (existRes.data || []).forEach(function (d) {
    existIds[d._id] = true;
  });

  const fresh = rows.filter(function (d) {
    return !existIds[drawId(d.lottery, d.period)];
  });

  // 3. 批量插入新增的
  let inserted = 0;
  if (fresh.length) {
    const docs = fresh.map(function (d) {
      const doc = Object.assign({}, d, { _id: drawId(d.lottery, d.period) });
      doc.updatedAt = db.serverDate();
      return doc;
    });
    inserted = await insertMany(DRAWS_NAME, docs);
  }

  // 4. 记录同步元信息
  // 注意：doc(id).set() 的 data 里不能再带 _id —— 报错 -501007「不能更新_id的值」
  const latest = rows[0];
  await withCollection(SYNC_META_NAME, () =>
    SYNC_META.doc(lotteryKey).set({
      data: {
        lottery: lotteryKey,
        name: meta.name,
        source: meta.source,
        latestPeriod: latest.period,
        latestDate: latest.date,
        count: rows.length,
        lastSyncAt: nowIso(),
      },
    })
  );

  return {
    lottery: lotteryKey,
    name: meta.name,
    fetched: rows.length,
    inserted: inserted,
    skipped: rows.length - fresh.length,
    latestPeriod: latest.period,
    latestDate: latest.date,
  };
}

/**
 * 批量插入：按 100 一批并发写。
 *
 * 为什么分批：一次 add 塞 500 条，CloudBase 可能拒绝或超时；
 * 分成 100 一批并发写，比逐条快，也比一大坨稳。
 * 某一批失败就只把这一批退回逐条，不影响其它批。
 */
async function insertMany(name, docs) {
  const col = name === SYNC_META_NAME ? SYNC_META : DRAWS;
  if (!docs.length) return 0;

  const CHUNK = 100;
  const chunks = [];
  for (let i = 0; i < docs.length; i += CHUNK) {
    chunks.push(docs.slice(i, i + CHUNK));
  }

  const settled = await Promise.allSettled(
    chunks.map(function (c) {
      return col
        .add({ data: c })
        .then(function () {
          return c.length;
        })
        .catch(function (e) {
          console.log("[api] 批量插入失败，退回逐条: " + ((e && e.errMsg) || e));
          return Promise.allSettled(
            c.map(function (d) {
              return col.add({ data: d });
            })
          ).then(function (r) {
            return r.filter(function (x) {
              return x.status === "fulfilled";
            }).length;
          });
        });
    })
  );

  let inserted = 0;
  settled.forEach(function (r) {
    if (r.status === "fulfilled") inserted += r.value;
  });
  return inserted;
}

/**
 * 按 id 批量查存在性。
 * in 操作符单次有元素上限，超过就分片并发查，避免报错。
 */
async function queryExistingIds(ids) {
  const CHUNK = 100;
  const chunks = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    chunks.push(ids.slice(i, i + CHUNK));
  }

  const parts = await Promise.all(
    chunks.map(function (c) {
      return DRAWS.where({ _id: db.command.in(c) }).limit(c.length).get();
    })
  );

  const data = [];
  parts.forEach(function (p) {
    (p.data || []).forEach(function (d) {
      data.push(d);
    });
  });
  return { data: data };
}

/** 四个彩种并发同步（定时触发器用） */
async function syncAll(limit) {
  const keys = Object.keys(LOTTERIES);
  const settled = await Promise.allSettled(
    keys.map(function (key) {
      return syncOne(key, limit);
    })
  );
  const results = [];
  const errors = [];
  settled.forEach(function (r, i) {
    if (r.status === "fulfilled") {
      results.push(r.value);
    } else {
      errors.push({ lottery: keys[i], error: (r.reason && r.reason.message) || String(r.reason) });
    }
  });
  return { serverTime: nowIso(), results: results, errors: errors };
}

/**
 * 自动同步 —— 客户端打开页面时的兜底
 *
 * 定时触发器要手动上传 config.json 才生效。在那之前（或上传之后作为双保险），
 * 由客户端每次打开页面调本动作，保证「数据每天都更新」这件事不依赖人工操作：
 *
 *   1. 过期判定：没同步过，或距上次同步超过 maxAgeHours（默认 6 小时）才动手；
 *   2. 轻量探上游：fetchUpstream(key, 1) 只取最新一期，比全量拉快得多；
 *   3. 上游期号没变 → 只刷新 lastSyncAt，不做重活（省掉整轮 100 期拉取）；
 *   4. 上游期号变了 → 只同步有变化的彩种，走正常的幂等 upsert。
 *
 * 超时预算：冷启动 0.6~1.2s + 元信息读 0.05s + 上游探测 0.3s（并发）
 * + 元信息写 0.1s ≈ 1.7s，留有余量。真正需要拉全量的路径才接近 3s 上限。
 */
async function autoSync(options) {
  const opts = options || {};
  const maxAgeHours = Number(opts.maxAgeHours) > 0 ? Number(opts.maxAgeHours) : 6;
  const maxAgeMs = maxAgeHours * 3600 * 1000;
  const force = !!opts.force;

  const metaRes = await withCollection(SYNC_META_NAME, () => SYNC_META.limit(20).get());
  const byLottery = {};
  (metaRes.data || []).forEach(function (m) {
    byLottery[m.lottery] = m;
  });

  const now = Date.now();
  const keys = Object.keys(LOTTERIES);

  // 1) 过期判定
  const candidates = [];
  const fresh = [];
  keys.forEach(function (key) {
    const m = byLottery[key];
    const ts = m && m.lastSyncAt ? Date.parse(m.lastSyncAt) : 0;
    if (force || !m || !ts || now - ts > maxAgeMs) {
      candidates.push(key);
    } else {
      fresh.push(key);
    }
  });

  if (!candidates.length) {
    return {
      skipped: true,
      reason: "数据仍在新鲜期（" + maxAgeHours + " 小时内已同步）",
      maxAgeHours: maxAgeHours,
      checked: fresh,
      synced: [],
      errors: [],
      serverTime: nowIso(),
    };
  }

  // 2) 轻量探上游最新期号（并发）
  const probes = await Promise.all(
    candidates.map(function (key) {
      return fetchUpstream(key, 1)
        .then(function (rows) {
          return { lottery: key, ok: true, latest: rows.length ? rows[0].period : "" };
        })
        .catch(function (e) {
          return {
            lottery: key,
            ok: false,
            latest: "",
            error: (e && e.message) || String(e),
          };
        });
    })
  );

  // 3) 分流：期号没变的只刷时间，有变化的才真同步
  const needSync = [];
  const touched = [];
  const errors = [];
  probes.forEach(function (p) {
    if (!p.ok) {
      errors.push({ lottery: p.lottery, error: p.error || "上游探测失败" });
      return;
    }
    const m = byLottery[p.lottery];
    if (m && p.latest && p.latest === m.latestPeriod) {
      touched.push(p.lottery);
    } else {
      needSync.push(p.lottery);
    }
  });

  // 只刷新同步时间，不动数据
  await Promise.all(
    touched.map(function (key) {
      const m = byLottery[key];
      return withCollection(SYNC_META_NAME, () =>
        SYNC_META.doc(key).set({
          data: {
            lottery: key,
            name: m.name,
            source: m.source,
            latestPeriod: m.latestPeriod,
            latestDate: m.latestDate,
            count: m.count,
            lastSyncAt: nowIso(),
          },
        })
      ).catch(function () {
        return null;
      });
    })
  );

  // 4) 真正同步有变化的彩种
  const settled = await Promise.allSettled(
    needSync.map(function (key) {
      return syncOne(key, DEFAULT_LIMIT);
    })
  );
  const results = [];
  settled.forEach(function (r, i) {
    if (r.status === "fulfilled") {
      results.push(r.value);
    } else {
      errors.push({
        lottery: needSync[i],
        error: (r.reason && r.reason.message) || String(r.reason),
      });
    }
  });

  return {
    skipped: false,
    reason: needSync.length
      ? "已同步新期彩种：" + needSync.join("、")
      : "上游无新期号，仅刷新同步时间",
    maxAgeHours: maxAgeHours,
    checked: candidates,
    touched: touched,
    synced: results,
    errors: errors,
    serverTime: nowIso(),
  };
}

/** 读取已入库的开奖记录 */
async function listDraws(lotteryKey, limit) {
  const key = lotteryKey || "ssq";
  const meta = LOTTERIES[key];
  if (!meta) throw new Error("不支持的彩种: " + key);

  const n = Math.min(Math.max(parseInt(limit, 10) || DEFAULT_LIMIT, 1), MAX_LIMIT);

  const res = await withCollection(DRAWS_NAME, () =>
    DRAWS.where({ lottery: key }).limit(MAX_LIMIT).get()
  );

  const rows = (res.data || []).slice().sort(function (a, b) {
    return String(b.period).localeCompare(String(a.period));
  });

  return {
    lottery: key,
    name: meta.name,
    total: rows.length,
    list: rows.slice(0, n),
  };
}

function validatePrediction(event) {
  const period = event.period;
  const reds = event.reds;
  const blue = event.blue;

  if (!period) throw new Error("缺少期号 period");
  if (!Array.isArray(reds) || reds.length !== RED_COUNT) {
    throw new Error("红球必须是 " + RED_COUNT + " 个");
  }
  if (!blue) throw new Error("缺少蓝球 blue");

  const normReds = reds.map(Number);
  const normBlue = Number(blue);

  for (const r of normReds) {
    if (!Number.isInteger(r) || r < 1 || r > RED_MAX) {
      throw new Error("红球必须在 1-" + RED_MAX + " 之间");
    }
  }
  if (!Number.isInteger(normBlue) || normBlue < 1 || normBlue > BLUE_MAX) {
    throw new Error("蓝球必须在 1-" + BLUE_MAX + " 之间");
  }
  if (new Set(normReds).size !== RED_COUNT) {
    throw new Error("红球不能重复");
  }

  return { period: String(period), reds: normReds.sort(function (a, b) { return a - b; }), blue: normBlue };
}

async function savePrediction(openid, event) {
  const p = validatePrediction(event);

  // 同一用户同一期只留一条：用确定性 _id 做 upsert
  const docId = openid + "_" + p.period;
  const now = db.serverDate();

  await withCollection(PREDICTIONS_NAME, () =>
    PREDICTIONS.doc(docId).set({
      data: Object.assign({}, p, {
        _openid: openid,
        createdAt: now,
        updatedAt: now,
      }),
    })
  );

  return { id: docId, period: p.period };
}

async function listPredictions(openid) {
  const res = await withCollection(PREDICTIONS_NAME, () =>
    PREDICTIONS.where({ _openid: openid }).limit(MAX_PREDICTIONS).get()
  );

  // 在内存里排序：where + orderBy 组合在云数据库要建复合索引，
  // 新环境没人配索引会直接报错，而这里最多 50 条，内存排更省事。
  return res.data.sort(function (a, b) {
    return String(b.period).localeCompare(String(a.period));
  });
}

/* ---------------- 登录与模拟选号记录 ---------------- */

/** openid 脱敏：页面上展示用，不给完整 id */
function maskOpenid(id) {
  const s = String(id || "");
  if (!s) return "";
  if (s.length <= 10) return s.slice(0, 2) + "***";
  return s.slice(0, 6) + "***" + s.slice(-4);
}

/** 读用户文档；没有就当首次登录 */
async function getUserDoc(docId) {
  try {
    const res = await withCollection(USERS_NAME, () => USERS.doc(docId).get());
    return res.data || null;
  } catch (e) {
    if (isDocMissing(e)) return null;
    throw e;
  }
}

/**
 * 微信登录授权
 *
 * 云函数里 cloud.getWXContext().OPENID 就是当前用户的身份，
 * 不需要前端传 wx.login 的 code 换 session。
 * 这里做的是「登记 + 更新资料」：昵称、头像第一次由前端传，之后保留。
 */
async function login(openid, event) {
  const ev = event || {};
  const docId = "u_" + openid;
  const now = Date.now();
  const prev = await getUserDoc(docId);

  const nickname = ev.nickname ? String(ev.nickname).slice(0, 24) : (prev && prev.nickname) || "";
  const avatar = ev.avatar ? String(ev.avatar) : (prev && prev.avatar) || "";

  const profile = {
    openid: openid,
    nickname: nickname,
    avatar: avatar,
    firstLoginAt: prev && prev.firstLoginAt ? prev.firstLoginAt : now,
    lastLoginAt: now,
    loginCount: prev ? (prev.loginCount || 0) + 1 : 1,
  };

  await withCollection(USERS_NAME, () =>
    USERS.doc(docId).set({
      data: Object.assign({}, profile, { _openid: openid }),
    })
  );

  return Object.assign({}, profile, { maskedOpenid: maskOpenid(openid) });
}

/** 保存一批模拟选号（一次生成的 5 组算一条记录） */
async function savePicks(openid, event) {
  const ev = event || {};
  const groups = Array.isArray(ev.groups) ? ev.groups.slice(0, 10) : [];
  if (!groups.length) throw new Error("没有可保存的号码组");

  const now = Date.now();
  // 用确定性 _id 而不是 add()，这样 _openid 能显式写进去
  const docId = "p_" + openid + "_" + now + "_" + Math.floor(Math.random() * 1000000);

  const doc = {
    _openid: openid,
    lottery: String(ev.lottery || "ssq"),
    lotteryName: String(ev.lotteryName || ""),
    mode: String(ev.mode || "lucky"),
    strategy: String(ev.strategy || "weighted"),
    groups: groups,
    createdAt: now,
  };

  await withCollection(PICKS_NAME, () => PICKS.doc(docId).set({ data: doc }));

  return { id: docId, count: groups.length, createdAt: now };
}

/** 列出当前用户的模拟选号记录（新的在前） */
async function listPicks(openid) {
  const res = await withCollection(PICKS_NAME, () =>
    PICKS.where({ _openid: openid }).limit(MAX_PICKS).get()
  );

  // 内存里排序：where + orderBy 组合在云数据库要建复合索引，
  // 新环境没人配索引会直接报错，而这里最多 50 条，内存排更省事。
  return res.data.sort(function (a, b) {
    return (b.createdAt || 0) - (a.createdAt || 0);
  });
}

/* ---------------- AI 预置配置 ---------------- */

/** 兜底端点：cloudfunctions/api/ai-config.js 不存在时用这个 */
const DEFAULT_AI_BASE_URL = "https://api.minimaxi.com/anthropic/v1";

/** 兜底模型列表 */
const DEFAULT_AI_MODELS = [
  { key: "MiniMax-M3.1-Flash", name: "M3.1-Flash · 快，日常够用" },
  { key: "MiniMax-M3", name: "M3 · 强，深度分析用" },
];

/**
 * 下发 AI 预置配置（端点 + 可选模型 + 预置 key）
 *
 * 小程序代码包是明文分发的，API key 写进包里会被任何人反编译拿到。
 * 所以预置 key 存在云函数里，由这里按需下发给客户端。
 *
 * 代价要说清楚：「客户端直连」这条链路决定了 key 最终会出现在用户手机上
 * （用户也可以在「AI 设置」里换成自己的 key）。
 * 等 AI 分析真要上线、开始有真实用户时，应该改回云函数代理。
 *
 * 这个动作只读本地文件，不查库不调外部接口，3 秒超时绰绰有余。
 */
async function getAIConfig() {
  let cfg = null;
  try {
    // 预置凭据文件是可选的：没有它就只返回端点和模型，不带 key
    cfg = require("./ai-config");
  } catch (e) {
    cfg = null;
  }

  return {
    baseUrl: (cfg && cfg.baseUrl) || DEFAULT_AI_BASE_URL,
    models: (cfg && cfg.models) || DEFAULT_AI_MODELS,
    apiKey: (cfg && cfg.apiKey) || "",
  };
}

/* ---------------- 入口 ---------------- */

exports.main = async (event) => {
  const ctx = cloud.getWXContext();
  const openid = ctx.OPENID;
  const ev = event || {};

  // 定时触发器：event.TriggerName / event.Type === "Timer"
  if (ev.TriggerName || ev.Type === "Timer" || ev.TriggerTime) {
    try {
      return { success: true, type: "timer", data: await syncAll(DEFAULT_LIMIT) };
    } catch (err) {
      console.error("[api] timer failed:", err);
      return { success: false, message: err && err.message ? err.message : "定时同步失败" };
    }
  }

  const type = ev.type || "health";

  try {
    switch (type) {
      case "health":
        return { success: true, type: type, data: await health() };
      case "checkSources":
        return { success: true, type: type, data: await checkSources() };
      case "syncDraws":
        return { success: true, type: type, data: await syncOne(ev.lottery || "ssq", ev.limit) };
      case "syncAll":
        return { success: true, type: type, data: await syncAll(ev.limit) };
      case "autoSync":
        return { success: true, type: type, data: await autoSync(ev) };
      case "listDraws":
        return { success: true, type: type, data: await listDraws(ev.lottery, ev.limit) };
      case "savePrediction":
        if (!openid) return { success: false, message: "取不到用户身份（OPENID 为空）" };
        return { success: true, type: type, data: await savePrediction(openid, ev) };
      case "listPredictions":
        if (!openid) return { success: false, message: "取不到用户身份（OPENID 为空）" };
        return { success: true, type: type, data: await listPredictions(openid) };
      case "login":
        if (!openid) return { success: false, message: "取不到用户身份（OPENID 为空）" };
        return { success: true, type: type, data: await login(openid, ev) };
      case "savePicks":
        if (!openid) return { success: false, message: "取不到用户身份（OPENID 为空）" };
        return { success: true, type: type, data: await savePicks(openid, ev) };
      case "listPicks":
        if (!openid) return { success: false, message: "取不到用户身份（OPENID 为空）" };
        return { success: true, type: type, data: await listPicks(openid) };
      case "getAIConfig":
        return { success: true, type: type, data: await getAIConfig() };
      default:
        return { success: false, message: "未知的操作类型: " + type };
    }
  } catch (err) {
    console.error("[api] failed:", type, err);
    return { success: false, message: err && err.message ? err.message : "云函数内部错误" };
  }
};
