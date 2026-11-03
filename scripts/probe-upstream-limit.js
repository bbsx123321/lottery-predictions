/**
 * 探针：上游开奖接口一次最多能给多少期
 *
 * 为什么要探这个：
 *   代码里的 MAX_LIMIT = 300 是「我们自己设的上限」，
 *   但上游接口（福彩 cwl / 体彩 sporttery）自己可能还有更小的硬上限。
 *   不实测就不知道「一次最多能拿到多少期」的真实答案。
 *
 * 做法：对每个彩种按不同的 n 请求上游，统计实际返回条数。
 *
 * 用法：
 *   node probe-upstream-limit.js [--n 100,200,300,500]
 */
const https = require("node:https");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const CWL_URL = "https://www.cwl.gov.cn/cwl_admin/front/cwlkj/search/kjxx/findDrawNotice";
const CWL_REFERER = "https://www.cwl.gov.cn/ygkj/wqkjgg/";
const SPORTTERY_URL = "https://webapi.sporttery.cn/gateway/lottery/getHistoryPageListV1.qry";
const SPORTTERY_REFERER = "https://static.sporttery.cn/";

const TARGETS = [
  { key: "ssq", name: "双色球", src: "cwl", cwlName: "ssq" },
  { key: "fc3d", name: "福彩3D", src: "cwl", cwlName: "3d" },
  { key: "kl8", name: "快乐8", src: "cwl", cwlName: "kl8" },
  { key: "dlt", name: "大乐透", src: "sporttery", gameNo: "85" },
];

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const NS = arg("--n", "100,200,300,500")
  .split(",")
  .map(function (s) {
    return parseInt(s, 10);
  })
  .filter(function (n) {
    return n > 0;
  });

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

async function fetchCount(target, n) {
  if (target.src === "cwl") {
    const url =
      CWL_URL +
      "?name=" + target.cwlName +
      "&issueCount=" + n +
      "&issueStart=&issueEnd=&dayStart=&dayEnd=" +
      "&pageNo=1&pageSize=" + n + "&week=&systemType=PC";
    const json = await get(url, CWL_REFERER);
    const rows = json.result || [];
    return { got: rows.length, pageCount: json.pageCount || 0, total: json.count || 0, periods: periodsOf(rows) };
  }
  const url =
    SPORTTERY_URL +
    "?gameNo=" + target.gameNo +
    "&provinceId=0&pageSize=" + n +
    "&isVerify=1&pageNo=1";
  const json = await get(url, SPORTTERY_REFERER);
  const rows = (json.value && json.value.list) || [];
  return {
    got: rows.length,
    pageCount: (json.value && json.value.pages) || 0,
    total: (json.value && json.value.total) || 0,
    periods: periodsOf(rows),
  };
}

/** 取期号列表（福彩 code / 体彩 lotteryDrawNum），顺便算去重数 */
function periodsOf(rows) {
  const ps = [];
  for (const r of rows) {
    const p = r.code || r.lotteryDrawNum || r.lotteryDrawResult || "";
    if (p) ps.push(String(p));
  }
  const uniq = new Set(ps);
  const sorted = ps.slice().sort(function (a, b) {
    return a.localeCompare(b);
  });
  return {
    n: ps.length,
    uniq: uniq.size,
    newest: sorted[sorted.length - 1] || "",
    oldest: sorted[0] || "",
  };
}

async function main() {
  console.log("上游接口单次返回期数实测");
  console.log("请求期数: " + NS.join(", "));
  console.log("");

  for (const t of TARGETS) {
    console.log("=== " + t.name + " (" + t.key + ") ===");
    for (const n of NS) {
      try {
        const r = await fetchCount(t, n);
        const flag = r.got < n ? "  <-- 被打断，实际只给 " + r.got : "";
        const p = r.periods;
        const dup = p.n - p.uniq > 0 ? "  [有重复 " + (p.n - p.uniq) + " 条]" : "";
        console.log(
          "  请求 " + String(n).padStart(4) + " 期 -> 实得 " +
            String(r.got).padStart(4) + " 期  去重 " + String(p.uniq).padStart(4) +
            "  " + p.oldest + " ~ " + p.newest +
            "  (上游 total=" + r.total + ", pages=" + r.pageCount + ")" + flag + dup
        );
      } catch (e) {
        console.log("  请求 " + String(n).padStart(4) + " 期 -> 失败: " + (e && e.message));
      }
    }
    console.log("");
  }
}

main().catch(function (err) {
  console.error(err);
  process.exit(1);
});
