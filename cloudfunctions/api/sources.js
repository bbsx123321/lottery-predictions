/**
 * 上游开奖数据源适配器
 *
 * 四个彩种，两个官方接口：
 *   福彩（双色球 ssq / 福彩3D fc3d / 快乐8 kl8）
 *     https://www.cwl.gov.cn/cwl_admin/front/cwlkj/search/kjxx/findDrawNotice
 *   体彩（大乐透 dlt）
 *     https://webapi.sporttery.cn/gateway/lottery/getHistoryPageListV1.qry?gameNo=85
 *
 * 两个都是官方开奖数据源，每期开奖后即更新，无需 key、无需登录、不限调用量。
 * 福彩接口必须带 Referer，否则 403。
 *
 * 归一化后的统一结构：
 *   { lottery, period, date, numbers: [主号码], extras: [副号码], sales?, pool? }
 * 号码一律转成数字并升序，前端不关心各彩种的原始字段名。
 */
const https = require("https");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const CWL_URL = "https://www.cwl.gov.cn/cwl_admin/front/cwlkj/search/kjxx/findDrawNotice";
const CWL_REFERER = "https://www.cwl.gov.cn/ygkj/wqkjgg/";
const SPORTTERY_URL = "https://webapi.sporttery.cn/gateway/lottery/getHistoryPageListV1.qry";
const SPORTTERY_REFERER = "https://static.sporttery.cn/";

/** 彩种元信息：名称、号码区规则、上游来源 */
const LOTTERIES = {
  ssq: {
    key: "ssq",
    name: "双色球",
    source: "cwl",
    cwlName: "ssq",
    mainCount: 6,
    mainMin: 1,
    mainMax: 33,
    extraCount: 1,
    extraMax: 16,
    mainLabel: "红球",
    extraLabel: "蓝球",
    // false = 号码为集合，存库时升序
    ordered: false,
  },
  fc3d: {
    key: "fc3d",
    name: "福彩3D",
    source: "cwl",
    cwlName: "3d",
    mainCount: 3,
    mainMin: 0,
    mainMax: 9,
    extraCount: 0,
    extraMax: 0,
    mainLabel: "号码",
    extraLabel: "",
    // true = 3D 三个数字有位置意义（百/十/个），保留上游开奖顺序，不排序
    ordered: true,
  },
  kl8: {
    key: "kl8",
    name: "快乐8",
    source: "cwl",
    cwlName: "kl8",
    mainCount: 20,
    mainMin: 1,
    mainMax: 80,
    extraCount: 0,
    extraMax: 0,
    mainLabel: "号码",
    extraLabel: "",
    ordered: false,
  },
  dlt: {
    key: "dlt",
    name: "大乐透",
    source: "sporttery",
    gameNo: "85",
    mainCount: 5,
    mainMin: 1,
    mainMax: 35,
    extraCount: 2,
    extraMax: 12,
    mainLabel: "前区",
    extraLabel: "后区",
    // 前区后区各自升序（切分时不能整体排序，见 parseSporttery）
    ordered: false,
  },
};

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
/**
 * 上游每页 100 期。
 *
 * 体彩的 pageSize 被上游硬钳在 100（请求 300/500 都只给 100），
 * 福彩用 pageSize=100 + pageNo 翻页正好也对 —— 两边统一按 100 一页处理。
 */
const PAGE_SIZE = 100;

/* ---------------- HTTP ---------------- */

function httpGetJSON(url, referer, timeoutMs) {
  return new Promise(function (resolve, reject) {
    let target;
    try {
      target = new URL(url);
    } catch (e) {
      return reject(new Error("URL 非法: " + url));
    }

    const req = https.request(
      {
        hostname: target.hostname,
        port: target.port || 443,
        path: target.pathname + target.search,
        method: "GET",
        headers: {
          "User-Agent": UA,
          Accept: "application/json, text/plain, */*",
          "Accept-Language": "zh-CN,zh;q=0.9",
          Referer: referer,
        },
        timeout: timeoutMs || 10000,
      },
      function (res) {
        // 少数情况下会 302
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          const next = new URL(res.headers.location, url).toString();
          return httpGetJSON(next, referer, timeoutMs).then(resolve, reject);
        }

        let body = "";
        res.setEncoding("utf8");
        res.on("data", function (c) {
          body += c;
        });
        res.on("end", function () {
          if (res.statusCode !== 200) {
            return reject(new Error("上游返回 HTTP " + res.statusCode));
          }
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(new Error("上游响应不是合法 JSON: " + body.slice(0, 120)));
          }
        });
      }
    );

    req.on("timeout", function () {
      req.destroy(new Error("上游请求超时"));
    });
    req.on("error", reject);
    req.end();
  });
}

/* ---------------- 解析 ---------------- */

/**
 * 拆号码
 * @param {string} raw 原始串，如 "13 18 19 20 28 09 11"
 * @param {boolean} keepOrder true = 保留原始顺序（3D 有位置意义），false = 升序（集合类）
 */
function toNumbers(raw, keepOrder) {
  if (!raw) return [];
  const nums = String(raw)
    .split(/[,，\s]+/)
    .filter(function (s) {
      return s !== "";
    })
    .map(Number)
    .filter(function (n) {
      return Number.isFinite(n);
    });
  return keepOrder ? nums : nums.sort(function (a, b) { return a - b; });
}

/** 福彩日期形如 "2026-10-29(四)"，取前 10 位 */
function normalizeDate(raw) {
  if (!raw) return "";
  const m = String(raw).match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : String(raw).slice(0, 10);
}

function parseCWL(json, meta) {
  if (!json || json.state !== 0) {
    throw new Error("福彩接口返回异常: " + ((json && json.message) || "未知错误"));
  }
  const list = Array.isArray(json.result) ? json.result : [];

  return list.map(function (r) {
    const numbers = toNumbers(r.red, meta.ordered);
    const extras = toNumbers(r.blue, meta.ordered);
    return {
      lottery: meta.key,
      period: String(r.code || ""),
      date: normalizeDate(r.date),
      numbers: numbers,
      extras: extras,
      sales: r.sales || "",
      pool: r.poolmoney || "",
    };
  }).filter(function (d) {
    return d.period !== "";
  });
}

function parseSporttery(json, meta) {
  if (!json || json.success !== true || !json.value) {
    throw new Error("体彩接口返回异常: " + ((json && json.errorMessage) || "未知错误"));
  }
  const list = Array.isArray(json.value.list) ? json.value.list : [];

  return list.map(function (r) {
    // 体彩返回顺序即「前区在前、后区在后」，必须保持原序再切分：
    // 大乐透后区是 1-12，与前区 1-35 数值区间重叠，
    // 整体排序会把后区的 09、11 混进前区。
    const all = toNumbers(r.lotteryDrawResult, true);
    return {
      lottery: meta.key,
      period: String(r.lotteryDrawNum || ""),
      date: normalizeDate(r.lotteryDrawTime),
      numbers: all.slice(0, meta.mainCount).sort(function (a, b) { return a - b; }),
      extras: all.slice(meta.mainCount, meta.mainCount + meta.extraCount).sort(function (a, b) { return a - b; }),
      sales: "",
      pool: "",
    };
  }).filter(function (d) {
    return d.period !== "";
  });
}

/* ---------------- 对外 ---------------- */

/**
 * 取某彩种的第 pageNo 页（从 1 开始），每页 PAGE_SIZE 期
 *
 * 福彩：必须把 issueCount 留空（=0）。带上 issueCount 时上游会忽略 pageNo，
 *      只返回「最新 N 期」，翻页会拿到空结果 —— 实测 issueCount=100&pageNo=2 返回 0 条。
 * 体彩：pageSize 上游锁死 100，pageNo 正常翻（total=2942, pages=30）。
 */
async function fetchPage(meta, pageNo) {
  if (meta.source === "cwl") {
    const url =
      CWL_URL +
      "?name=" + meta.cwlName +
      "&issueCount=0&issueStart=&issueEnd=&dayStart=&dayEnd=" +
      "&pageNo=" + pageNo + "&pageSize=" + PAGE_SIZE + "&week=&systemType=PC";
    const json = await httpGetJSON(url, CWL_REFERER, 10000);
    return parseCWL(json, meta);
  }

  const url =
    SPORTTERY_URL +
    "?gameNo=" + meta.gameNo +
    "&provinceId=0&pageSize=" + PAGE_SIZE +
    "&isVerify=1&pageNo=" + pageNo;
  const json = await httpGetJSON(url, SPORTTERY_REFERER, 10000);
  return parseSporttery(json, meta);
}

/**
 * 拉取某彩种最近 N 期
 * @param {string} lotteryKey ssq | fc3d | kl8 | dlt
 * @param {number} limit 期数
 */
async function fetchUpstream(lotteryKey, limit) {
  const meta = LOTTERIES[lotteryKey];
  if (!meta) throw new Error("不支持的彩种: " + lotteryKey);

  const n = Math.min(Math.max(parseInt(limit, 10) || DEFAULT_LIMIT, 1), MAX_LIMIT);

  // 并发翻页。实测体彩 5 页并发 500 期 ≈ 280ms、福彩 1 页 ≈ 50ms，
  // 云函数 3 秒超时够用（第一次请求要建 TLS 连接 ~500ms，之后每页只要 50~90ms）。
  const pageCount = Math.ceil(n / PAGE_SIZE);
  const tasks = [];
  for (let p = 1; p <= pageCount; p++) {
    tasks.push(fetchPage(meta, p));
  }
  const parts = await Promise.all(tasks);

  // 合并 → 期号新的在前 → 去重 → 截断到 n 条
  const merged = [];
  parts.forEach(function (p) {
    merged.push.apply(merged, p);
  });
  merged.sort(function (a, b) {
    return String(b.period).localeCompare(String(a.period));
  });

  const seen = {};
  const out = [];
  for (const row of merged) {
    if (seen[row.period]) continue;
    seen[row.period] = true;
    out.push(row);
    if (out.length >= n) break;
  }

  // 翻页拿到空页 = 参数用错了（最典型的是福彩 issueCount 没置 0，
  // 上游会忽略 pageNo 只返回最新 N 期，后面几页全空）。
  // 这种错不抛出去的话会**静默少给期数**，比直接报错难查得多。
  if (out.length < n) {
    const emptyAt = parts.findIndex(function (p) {
      return !p.length;
    });
    throw new Error(
      "上游只给了 " + out.length + " 期（要 " + n + " 期）" +
      (emptyAt > -1 ? "，第 " + (emptyAt + 1) + " 页是空的" : "")
    );
  }

  return out;
}

/**
 * 逐个彩种探测上游连通性（用于自检页）
 * @returns {Promise<Array<{lottery,name,ok,count,latest,error}>>}
 */
async function probeAll() {
  const keys = Object.keys(LOTTERIES);
  const results = await Promise.all(
    keys.map(async function (key) {
      const meta = LOTTERIES[key];
      try {
        const rows = await fetchUpstream(key, 3);
        return {
          lottery: key,
          name: meta.name,
          ok: true,
          count: rows.length,
          latest: rows.length ? rows[0].period : "",
          error: "",
        };
      } catch (e) {
        return {
          lottery: key,
          name: meta.name,
          ok: false,
          count: 0,
          latest: "",
          error: (e && e.message) || "探测失败",
        };
      }
    })
  );
  return results;
}

module.exports = {
  LOTTERIES,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  fetchUpstream,
  probeAll,
};
