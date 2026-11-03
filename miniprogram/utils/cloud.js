const envList = require("../envList.js");

// 客户端等待 5 秒，比服务端 3 秒上限长，
// 保证服务端的真实错误能返回，而不是客户端先超时把真实原因吃掉
const DEFAULT_TIMEOUT = 5000;
const SERVER_TIMEOUT_SECONDS = 3;

function isCloudReady() {
  return !!(envList.isConfigured && wx.cloud);
}

function translateError(err) {
  const errMsg = (err && (err.errMsg || err.message)) || "";
  if (
    errMsg.indexOf("FUNCTIONS_TIME_LIMIT_EXCEEDED") > -1 ||
    errMsg.indexOf("-504003") > -1 ||
    errMsg.indexOf("timed out after") > -1
  ) {
    return (
      "云函数执行超时（体验版上限 " + SERVER_TIMEOUT_SECONDS + " 秒），" +
      "请缩小单次处理量或改用定时触发器"
    );
  }
  if (errMsg.indexOf("Environment not found") > -1) {
    return "云开发环境未找到，请检查 envList.js 里的环境 ID";
  }
  if (errMsg.indexOf("FunctionName parameter could not be found") > -1) {
    return "云函数尚未部署，请在开发者工具中右键 cloudfunctions/api 选择「上传并部署」";
  }
  if (errMsg.indexOf("timeout") > -1 || errMsg.indexOf("Timeout") > -1) {
    return "请求超时，请检查网络后重试";
  }
  return errMsg || "未知错误";
}

/**
 * 统一调用云函数。
 *
 * 失败也走 reject（不吞异常），错误文案统一在这里翻译，
 * 页面层只需要 catch 一处。
 *
 * 注意：不要在本文件导出 collection()。
 * 前端一旦能直连查库，IDE 补全就会把人引到直连写法上，
 * 而直连做不到业务级权限。数据读写统一走 callFunction。
 */
function callFunction(name, data, options) {
  const opts = options || {};
  const timeout = opts.timeout || DEFAULT_TIMEOUT;

  if (!isCloudReady()) {
    const e = new Error("云开发环境未初始化");
    e.errMsg = "Environment not found";
    if (!opts.silent) wx.showToast({ title: e.message, icon: "none", duration: 2500 });
    return Promise.reject(e);
  }

  return new Promise(function (resolve, reject) {
    let settled = false;
    const timer = setTimeout(function () {
      if (settled) return;
      settled = true;
      const e = new Error("timeout");
      e.errMsg = "FunctionName timeout: " + name;
      reject(e);
    }, timeout);

    wx.cloud
      .callFunction({ name: name, data: data || {} })
      .then(function (res) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(res.result);
      })
      .catch(function (err) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });
  }).catch(function (err) {
    const message = translateError(err);
    if (!opts.silent) wx.showToast({ title: message, icon: "none", duration: 2500 });
    const e = new Error(message);
    e.original = err;
    throw e;
  });
}

module.exports = {
  callFunction: callFunction,
  isCloudReady: isCloudReady,
  translateError: translateError,
  DEFAULT_TIMEOUT: DEFAULT_TIMEOUT,
  SERVER_TIMEOUT_SECONDS: SERVER_TIMEOUT_SECONDS,
};
