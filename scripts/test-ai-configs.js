/**
 * 自测：AI 多配置存储（最多 3 套）
 *
 * utils/ai.js 依赖 wx 的本地存储，纯 node 下用一个假的 wx 顶上。
 * 重点验证：
 *   1. 旧结构（单套平铺）能自动迁移，用户不用重配
 *   2. 最多 3 套，第 4 套要拒绝
 *   3. 切换当前配置后，getSettings 跟着变
 *   4. 改配置只影响当前那套，不串到别的
 *   5. 删掉当前那套会自动选第一套
 *
 * 用法：node test-ai-configs.js
 */
const path = require("node:path");

/* ---------- 假 wx（必须在 require ai.js 之前装好） ---------- */
const store = {};
global.wx = {
  getStorageSync(key) {
    return store[key] === undefined ? undefined : JSON.parse(JSON.stringify(store[key]));
  },
  setStorageSync(key, value) {
    store[key] = JSON.parse(JSON.stringify(value));
  },
  removeStorageSync(key) {
    delete store[key];
  },
};

const root = path.resolve(__dirname, "..");
const ai = require(path.join(root, "miniprogram", "utils", "ai.js"));

let failures = 0;
let checks = 0;

function ok(cond, label, extra) {
  checks++;
  if (cond) {
    console.log("  [PASS] " + label + (extra ? "  " + extra : ""));
  } else {
    failures++;
    console.log("  [FAIL] " + label + (extra ? "  " + extra : ""));
  }
}

function reset() {
  Object.keys(store).forEach(function (k) {
    delete store[k];
  });
}

/* ============================================================ */
console.log("=== 1. 旧结构自动迁移 ===");
reset();
store[ai.SETTINGS_KEY] = {
  baseUrl: "https://old.example.com/v1",
  model: "Old-Model",
  apiKey: "sk-old",
  temperature: 0.3,
  style: "steady",
};

let all = ai.getAll();
ok(all.configs.length === 1, "旧配置迁移成 1 套", all.configs.length + " 套");
ok(all.configs[0].model === "Old-Model", "模型保留", all.configs[0].model);
ok(all.configs[0].apiKey === "sk-old", "密钥保留");
ok(all.configs[0].temperature === 0.3, "温度保留", String(all.configs[0].temperature));
ok(all.configs[0].style === "steady", "风格保留", all.configs[0].style);
ok(all.activeId === all.configs[0].id, "当前选中指向那套");
ok(all.configs[0].name === "配置 1", "自动起了默认名", all.configs[0].name);

console.log("");
console.log("=== 2. 最多 3 套 ===");
reset();
const c1 = ai.addConfig({ name: "快的", model: "M-Flash" });
const c2 = ai.addConfig({ name: "强的", model: "M-Pro" });
const c3 = ai.addConfig({ name: "我的", model: "Self-Host" });
const c4 = ai.addConfig({ name: "第 4 套" });
ok(!!c1 && !!c2 && !!c3, "前 3 套都能加");
ok(c4 === null, "第 4 套被拒绝", String(c4));
ok(ai.getAll().configs.length === 3, "一共 3 套", ai.getAll().configs.length + " 套");
ok(ai.MAX_CONFIGS === 3, "上限就是 3", String(ai.MAX_CONFIGS));

console.log("");
console.log("=== 3. 新增的自动成为当前 ===");
ok(ai.getActive().name === "我的", "新增后当前是新加的那套", ai.getActive().name);
ok(ai.getSettings().id === ai.getActive().id, "getSettings 与 getActive 一致");

console.log("");
console.log("=== 4. 切换当前配置 ===");
ok(ai.setActive(c1.id), "切到第 1 套");
ok(ai.getActive().name === "快的", "当前变成第 1 套", ai.getActive().name);
ok(ai.getActive().model === "M-Flash", "模型跟着换", ai.getActive().model);
ok(ai.setActive("不存在的id") === false, "切到不存在的 id 会被拒");

console.log("");
console.log("=== 5. 改配置只影响当前那套 ===");
ai.saveSettings({ apiKey: "sk-changed", temperature: 0.9 });
ok(ai.getActive().apiKey === "sk-changed", "当前那套的密钥被改了");
ok(ai.getAll().configs[0].apiKey === "sk-changed", "第 1 套确实是当前那套");
ok(ai.getAll().configs[1].apiKey === "", "第 2 套没被串改", JSON.stringify(ai.getAll().configs[1].apiKey));
ok(ai.getAll().configs[1].temperature === 0.7, "第 2 套温度没被串改");

console.log("");
console.log("=== 6. 删除 ===");
ok(ai.removeConfig(c2.id), "删掉第 2 套");
ok(ai.getAll().configs.length === 2, "剩 2 套", ai.getAll().configs.length + " 套");
ok(ai.removeConfig(c2.id) === false, "再删一次返回 false");
ai.setActive(c1.id);
ai.removeConfig(c1.id);
ok(ai.getActive().id === c3.id, "删掉当前那套后自动选第一套", ai.getActive().name);

console.log("");
console.log("=== 7. 删光了也不炸 ===");
reset();
ok(ai.getAll().configs.length === 0, "没有配置");
ok(ai.getActive().apiKey === "", "getActive 返回空密钥");
ok(ai.getActive().baseUrl === ai.DEFAULT_BASE_URL, "baseUrl 退回默认值");
ok(ai.describeSettings().indexOf("未配置") > -1, "状态文案提示未配置", ai.describeSettings());
ai.saveSettings({ apiKey: "sk-first", model: "First" });
ok(ai.getAll().configs.length === 1, "空状态下保存会自动建出第 1 套");
ok(ai.getActive().apiKey === "sk-first", "第 1 套存对了");

console.log("");
console.log("=== 8. 状态文案 ===");
reset();
ai.addConfig({ name: "快", model: "M-Flash", apiKey: "sk-1" });
ai.addConfig({ name: "慢", model: "M-Pro" });
// 新增的那套自动成为当前 —— 所以当前是「慢」（没密钥）
ok(ai.describeSettings().indexOf("慢") > -1, "文案带当前配置名", ai.describeSettings());
ok(ai.describeSettings().indexOf("共 2 套") > -1, "文案带配置总数", ai.describeSettings());
ok(ai.describeSettings().indexOf("未配置密钥") > -1, "当前那套没密钥时说没配", ai.describeSettings());
ai.setActive(ai.getAll().configs[0].id);
ok(ai.describeSettings().indexOf("快") > -1, "切到有密钥的那套，文案跟着换", ai.describeSettings());
ok(ai.describeSettings().indexOf("已配置") > -1, "有密钥时说已配置", ai.describeSettings());
ok(ai.describeSettings().indexOf("M-Flash") > -1, "文案带模型名", ai.describeSettings());

console.log("");
console.log("====================================================");
console.log(failures ? "自测失败：" + failures + " / " + checks : "全部通过：" + checks + " 项");
process.exit(failures ? 1 : 0);
