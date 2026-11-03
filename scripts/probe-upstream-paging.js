/**
 * 探针：上游接口能不能翻页拿更早的期数 + 单次 500 期要多久
 *
 * 背景：
 *   要让 AI 分析能看 500 期，就得能一次性把 500 期灌进云库。
 *   体彩实测 pageSize 被钳在 100（total=2942, pages=30）→ 必须翻页。
 *   福彩目前只验证过 issueCount 给多少给多少，**没验证过能不能翻页**。
 *
 * 用法：node probe-upstream-paging.js
 */
const https = require("node:https");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const CWL_URL = "https://www.cwl.gov.cn/cwl_admin/front/cwlkj/search/kjxx/findDrawNotice";
const CWL_REFERER = "https://www.cwl.gov.cn/ygkj/wqkjgg/";
const SPORTTERY_URL = "https://webapi.sporttery.cn/gateway/lottery/getHistoryPageListV1.qry";
const SPORTTERY_REFERER = "https://static.sporttery.cn/";

function get(url, referer) {
  return new Promise(function (resolve, reject) {
    const req = https.get(
      url,
      { headers: { "User-Agent": UA, Referer: referer, Accept: "application/json" } },
      function (res) {
        let body = "";
        res.on("data", function (c) {
          body += c;
        });
        res.on("end", function () {
          if (res.statusCode !== 200) return reject(new Error("HTTP " + res.statusCode));
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(new Error("解析失败: " + body.slice(0, 120)));
          }
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(20000, function () {
      req.destroy(new Error("超时"));
    });
  });
}

function cwlUrl(name, opts) {
  const o = opts || {};
  return (
    CWL_URL +
    "?name=" + name +
    "&issueCount=" + (o.issueCount === undefined ? "" : o.issueCount) +
    "&issueStart=&issueEnd=&dayStart=&dayEnd=" +
    "&pageNo=" + (o.pageNo || 1) + "&pageSize=" + (o.pageSize || 100) +
    "&week=&systemType=PC"
  );
}

function sportteryUrl(pageNo, pageSize) {
  return (
    SPORTTERY_URL +
    "?gameNo=85&provinceId=0&pageSize=" + pageSize +
    "&isVerify=1&pageNo=" + pageNo
  );
}

function cwlPeriods(rows) {
  return rows.map(function (r) { return String(r.code); });
}

function sportteryPeriods(rows) {
  return rows.map(function (r) { return String(r.lotteryDrawNum); });
}

function range(ps) {
  if (!ps.length) return "(空)";
  const s = ps.slice().sort(function (a, b) { return a.localeCompare(b); });
  return s[0] + " ~ " + s[s.length - 1];
}

async function main() {
  console.log("上游翻页能力实测");
  console.log("");

  console.log("=== 福彩 ssq：翻页 ===");
  for (const opts of [
    { label: "issueCount=0 pageNo=1 pageSize=100", issueCount: 0, pageNo: 1, pageSize: 100 },
    { label: "issueCount=0 pageNo=2 pageSize=100", issueCount: 0, pageNo: 2, pageSize: 100 },
    { label: "issueCount=0 pageNo=5 pageSize=100", issueCount: 0, pageNo: 5, pageSize: 100 },
    { label: "issueCount=100 pageNo=2 pageSize=100", issueCount: 100, pageNo: 2, pageSize: 100 },
  ]) {
    const t0 = Date.now();
    try {
      const json = await get(cwlUrl("ssq", opts), CWL_REFERER);
      const rows = json.result || [];
      const ps = cwlPeriods(rows);
      console.log(
        "  " + opts.label.padEnd(38) + " -> " + String(ps.length).padStart(4) + " 期  " +
          range(ps).padEnd(24) + "  " + (Date.now() - t0) + "ms"
      );
    } catch (e) {
      console.log("  " + opts.label.padEnd(38) + " -> 失败: " + (e && e.message));
    }
  }

  console.log("");
  console.log("=== 体彩 dlt：翻页（pageSize 固定 100） ===");
  for (const pageNo of [1, 2, 3]) {
    const t0 = Date.now();
    try {
      const json = await get(sportteryUrl(pageNo, 100), SPORTTERY_REFERER);
      const rows = (json.value && json.value.list) || [];
      const ps = sportteryPeriods(rows);
      console.log(
        "  pageNo=" + String(pageNo).padEnd(28) + " -> " + String(ps.length).padStart(4) + " 期  " +
          range(ps).padEnd(24) + "  " + (Date.now() - t0) + "ms" +
          "  (pages=" + ((json.value && json.value.pages) || 0) + ")"
      );
    } catch (e) {
      console.log("  pageNo=" + pageNo + " -> 失败: " + (e && e.message));
    }
  }

  console.log("");
  console.log("=== 耗时：5 页并发拉 500 期（云函数 3 秒超时的关键） ===");
  const t1 = Date.now();
  try {
    const pages = await Promise.all(
      [1, 2, 3, 4, 5].map(function (p) { return get(sportteryUrl(p, 100), SPORTTERY_REFERER); })
    );
    const all = [];
    pages.forEach(function (j) {
      ((j.value && j.value.list) || []).forEach(function (r) { all.push(String(r.lotteryDrawNum)); });
    });
    console.log("  体彩 5 页并发 -> " + all.length + " 期，合计 " + (Date.now() - t1) + "ms");
  } catch (e) {
    console.log("  体彩 5 页并发 -> 失败: " + (e && e.message));
  }

  const t2 = Date.now();
  try {
    const j = await get(cwlUrl("ssq", { issueCount: 500, pageNo: 1, pageSize: 500 }), CWL_REFERER);
    const ps = cwlPeriods(j.result || []);
    console.log("  福彩单次 500 期 -> " + ps.length + " 期，合计 " + (Date.now() - t2) + "ms");
  } catch (e) {
    console.log("  福彩单次 500 期 -> 失败: " + (e && e.message));
  }
}

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
