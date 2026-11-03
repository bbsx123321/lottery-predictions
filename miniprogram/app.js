const envList = require("./envList.js");

App({
  /**
   * 云开发初始化。
   *
   * 环境 ID 没填时必须跳过 init，否则 wx.cloud.init 会抛 "Environment not found"，
   * 整个 App 起不来 —— 本地自检页就废了。
   */
  onLaunch() {
    const envId = envList.currentEnvId;

    if (typeof wx.cloud === "undefined") {
      this.cloudStatus = { initialized: false, reason: "当前基础库不支持 wx.cloud（需 ≥ 2.2.3）" };
      console.warn("[env] 跳过云开发初始化：" + this.cloudStatus.reason);
      return;
    }

    if (!envList.isConfigured) {
      this.cloudStatus = { initialized: false, reason: "云环境 ID 未配置" };
      console.warn("[env] 跳过云开发初始化：请在 miniprogram/envList.js 填写 envId");
      return;
    }

    wx.cloud.init({
      env: envId,
      traceUser: true,
    });
    this.cloudStatus = { initialized: true, reason: "" };
    console.log("[env] 云开发已初始化，环境 " + envId);
  },
});
