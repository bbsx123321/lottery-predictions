const envList = require("../../envList.js");
const devtool = require("../../devtool.config.js");
const { isCloudReady } = require("../../utils/cloud.js");
const api = require("../../utils/api.js");
const { getLayout } = require("../../utils/layout.js");

const TOURIST_APPID = "touristappid";

const STATUS_TEXT = {
  ok: "通过",
  todo: "待配置",
  fail: "异常",
};

function readAppId() {
  try {
    const info = wx.getAccountInfoSync ? wx.getAccountInfoSync() : null;
    return info && info.miniProgram ? info.miniProgram.appId : "";
  } catch (e) {
    return "";
  }
}

function readSdkVersion() {
  try {
    const base = wx.getAppBaseInfo ? wx.getAppBaseInfo() : null;
    if (base && base.SDKVersion) return base.SDKVersion;
  } catch (e) {
    /* 落到兜底 */
  }
  return wx.getSDKVersion ? wx.getSDKVersion() : "未知";
}

function buildEnvTable() {
  return [
    { key: "开发者工具", value: devtool.ideVersion },
    { key: "CLI 路径", value: devtool.cliPath },
    { key: "服务端口", value: String(devtool.idePort) },
    { key: "自动化端口", value: String(devtool.autoPort) },
    { key: "基础库", value: devtool.baseLibrary },
    { key: "Node", value: devtool.nodeVersion },
    { key: "npm 源", value: devtool.npmRegistry },
  ];
}

/** 造新对象 + 新数组，setData 才会真的触发重渲染 */
function decorate(checks) {
  return checks.map(function (c) {
    return {
      key: c.key,
      label: c.label,
      status: c.status,
      detail: c.detail,
      statusText: STATUS_TEXT[c.status] || c.status,
    };
  });
}

function summarize(checks) {
  const s = { total: checks.length, ok: 0, todo: 0, fail: 0 };
  checks.forEach(function (c) {
    if (c.status === "ok") s.ok += 1;
    else if (c.status === "todo") s.todo += 1;
    else s.fail += 1;
  });
  return s;
}

function headlineOf(summary) {
  if (summary.fail > 0) {
    return { text: summary.fail + " 项异常，需要处理", tone: "fail" };
  }
  if (summary.todo > 0) {
    return { text: summary.ok + "/" + summary.total + " 通过，" + summary.todo + " 项待配置", tone: "todo" };
  }
  return { text: "环境就绪，" + summary.ok + "/" + summary.total + " 全部通过", tone: "ok" };
}

Page({
  data: {
    loading: false,
    syncing: false,
    checks: [],
    summary: { total: 0, ok: 0, todo: 0, fail: 0 },
    headline: { text: "检测中…", tone: "wait" },
    env: [],
    // 四个彩种的本地同步状态
    lotteries: [],
    // 数据源连通摘要
    sourceText: "",
    // 兜底自动同步的状态
    autoText: "",
    bottomPad: 0,
  },

  onLoad() {
    const layout = getLayout();
    this.setData({
      bottomPad: Math.round(32 * layout.rpxRatio + layout.safeBottom),
      env: buildEnvTable(),
      lotteries: api.LOTTERIES.map(function (l) {
        return {
          key: l.key,
          name: l.name,
          mainLabel: l.mainLabel,
          extraLabel: l.extraLabel,
          latestPeriod: "",
          latestDate: "",
          count: 0,
          ok: false,
          error: "",
        };
      }),
    });
    this.runChecks();
    this.autoRefresh();
  },

  /**
   * 兜底自动同步 —— 不阻塞首屏
   *
   * 定时触发器要手动在控制台上传 config.json 才生效。
   * 这个动作保证：只要有人打开小程序，数据就会按需补拉，
   * 「每天更新」不依赖人工操作。
   */
  autoRefresh() {
    if (!isCloudReady()) return;
    const self = this;

    api
      .autoSync({ silent: true, timeout: 15000 })
      .then(function (res) {
        if (!res || !res.success) {
          self.setData({ autoText: "自动更新：未执行" });
          return;
        }

        const data = res.data || {};
        const synced = data.synced || [];
        const errors = data.errors || [];

        if (data.skipped) {
          self.setData({
            autoText:
              "自动更新：数据仍在新鲜期（" + data.maxAgeHours + " 小时内已同步）",
          });
          return;
        }

        if (synced.length) {
          self.setData({
            autoText: "自动更新：已补入 " + synced.length + " 个彩种的新期号",
          });
          return api.health({ silent: true }).then(function (h) {
            if (h && h.success && h.data && h.data.synced) {
              self.applySynced(h.data.synced);
            }
          });
        }

        self.setData({
          autoText: errors.length
            ? "自动更新：上游暂无新期号（" + errors.length + " 个探测失败）"
            : "自动更新：上游暂无新期号",
        });
      })
      .catch(function () {
        self.setData({ autoText: "自动更新：未执行（由定时触发器兜底）" });
      });
  },

  onPullDownRefresh() {
    const self = this;
    this.runChecks().then(function () {
      wx.stopPullDownRefresh();
      self.setData({ loading: false });
    });
  },

  runChecks() {
    const self = this;
    this.setData({ loading: true });

    const checks = [];

    checks.push({
      key: "sdk",
      label: "基础库版本",
      status: "ok",
      detail: readSdkVersion() + "（云开发需 ≥ 2.2.3）",
    });

    const appId = readAppId();
    if (!appId) {
      checks.push({ key: "appid", label: "运行时 AppID", status: "fail", detail: "读不到 wx.getAccountInfoSync" });
    } else if (appId === TOURIST_APPID) {
      checks.push({
        key: "appid",
        label: "运行时 AppID",
        status: "todo",
        detail: "游客模式，请在 project.config.json 填入真实 AppID",
      });
    } else {
      checks.push({ key: "appid", label: "运行时 AppID", status: "ok", detail: appId });
    }

    const envId = envList.currentEnvId;
    if (!envList.isConfigured) {
      checks.push({
        key: "envid",
        label: "云环境 ID",
        status: "todo",
        detail: "请在 miniprogram/envList.js 填写云环境 ID",
      });
    } else {
      checks.push({ key: "envid", label: "云环境 ID", status: "ok", detail: envId });
    }

    const hasCloudSdk = typeof wx.cloud !== "undefined";
    checks.push({
      key: "cloudsdk",
      label: "云开发 SDK",
      status: hasCloudSdk ? "ok" : "fail",
      detail: hasCloudSdk ? "wx.cloud 可用" : "当前基础库不支持 wx.cloud",
    });

    checks.push({
      key: "port",
      label: "开发者工具服务端口",
      status: "ok",
      detail: devtool.idePort + "（CLI 与自动化通道依赖此端口）",
    });

    const cloudCheck = {
      key: "fn",
      label: "云函数 api",
      status: "todo",
      detail: "云环境未配置，跳过探活",
    };
    checks.push(cloudCheck);

    const sourceCheck = {
      key: "source",
      label: "开奖数据源",
      status: "todo",
      detail: "云环境未配置，跳过数据源探测",
    };
    checks.push(sourceCheck);

    this.setData({ checks: decorate(checks) });
    this.applySummary(checks);

    const settle = function () {
      self.setData({ loading: false });
    };

    if (!hasCloudSdk || !isCloudReady()) {
      return Promise.resolve().then(settle);
    }

    // 1) 云函数探活
    return api
      .health({ silent: true })
      .then(function (res) {
        const ok = !!(res && res.success);
        cloudCheck.status = ok ? "ok" : "fail";
        cloudCheck.detail = ok
          ? "连通：" + ((res.data && res.data.message) || "云函数已响应")
          : (res && res.message) || "云函数返回失败";

        if (ok && res.data && res.data.synced) {
          self.applySynced(res.data.synced);
        }

        self.setData({ checks: decorate(checks) });
        self.applySummary(checks);
        return res;
      })
      .catch(function (err) {
        const msg = (err && err.message) || "调用失败";
        const notDeployed =
          msg.indexOf("尚未部署") > -1 ||
          msg.indexOf("FunctionName parameter could not be found") > -1;
        cloudCheck.status = notDeployed ? "todo" : "fail";
        cloudCheck.detail = notDeployed
          ? "云函数尚未部署：右键 cloudfunctions/api → 上传并部署"
          : msg;
        self.setData({ checks: decorate(checks) });
        self.applySummary(checks);
      })
      // 2) 数据源探测（真实发请求，慢一点，单独给更长的超时）
      .then(function () {
        return api.checkSources({ silent: true, timeout: 12000 });
      })
      .then(function (res) {
        const data = (res && res.data) || {};
        const sources = data.sources || [];
        const okCount = sources.filter(function (s) {
          return s.ok;
        }).length;

        sourceCheck.status = sources.length && okCount === sources.length ? "ok" : "fail";
        sourceCheck.detail = sources.length
          ? okCount + "/" + sources.length + " 个上游连通（福彩官方 + 体彩官方）"
          : "未探测到数据源";

        self.setData({
          sourceText: sources
            .map(function (s) {
              return s.name + " " + (s.ok ? "✓ " + s.latest : "✗ " + (s.error || "失败"));
            })
            .join("  ·  "),
        });

        self.setData({ checks: decorate(checks) });
        self.applySummary(checks);
      })
      .catch(function (err) {
        sourceCheck.status = "fail";
        sourceCheck.detail = (err && err.message) || "数据源探测失败";
        self.setData({ checks: decorate(checks) });
        self.applySummary(checks);
      })
      .then(settle);
  },

  /** 把 health 返回的各彩种同步状态合并到页面数据 */
  applySynced(synced) {
    const map = {};
    synced.forEach(function (s) {
      map[s.lottery] = s;
    });
    const merged = this.data.lotteries.map(function (l) {
      const s = map[l.key];
      return Object.assign({}, l, {
        latestPeriod: s ? s.latestPeriod : "",
        latestDate: s ? s.latestDate : "",
        count: s ? s.count : 0,
        ok: !!(s && s.latestPeriod),
        error: "",
      });
    });
    this.setData({ lotteries: merged });
  },

  applySummary(checks) {
    const summary = summarize(checks);
    this.setData({ summary: summary, headline: headlineOf(summary) });
  },

  onRecheck() {
    if (this.data.loading) return;
    this.runChecks();
  },

  /** 手动同步四个彩种（拉到 500 期上限，AI 分析要这么多历史） */
  onSync() {
    if (this.data.syncing) return;
    this.setData({ syncing: true });
    const self = this;

    api
      .syncAll(500)
      .then(function (res) {
        const data = (res && res.data) || {};
        const ok = (data.results || []).length;
        const err = (data.errors || []).length;
        wx.showToast({
          title: err ? "部分失败 " + ok + "/" + (ok + err) : "已同步 " + ok + " 个彩种",
          icon: "none",
        });
      })
      .catch(function (err) {
        wx.showToast({ title: (err && err.message) || "同步失败", icon: "none" });
      })
      .then(function () {
        self.setData({ syncing: false });
        self.runChecks();
      });
  },

  onCopy() {
    const lines = this.data.checks.map(function (c) {
      return "[" + c.statusText + "] " + c.label + " —— " + c.detail;
    });
    lines.push("");
    lines.push("开奖数据：");
    this.data.lotteries.forEach(function (l) {
      lines.push(
        l.name + "  " + (l.latestPeriod ? l.latestPeriod + " 期 · " + l.latestDate : "未同步")
      );
    });
    if (this.data.sourceText) lines.push("数据源：" + this.data.sourceText);

    wx.setClipboardData({
      data: lines.join("\n"),
      success() {
        wx.showToast({ title: "诊断信息已复制", icon: "none" });
      },
    });
  },
});
