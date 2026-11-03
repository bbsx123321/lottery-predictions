/**
 * 云开发环境配置 —— 全项目唯一数据源。
 *
 * 环境 ID 获取方式（任选其一）：
 *   1. 微信开发者工具 -> 云开发 -> 设置 -> 环境 ID
 *   2. wechatide -c MiniMaxCode cloud_env_list --appid <你的 AppID>
 *
 * 切换环境只需修改本文件，app.js 会自动读取。
 *
 * 注意：deploy-cloudfunctions.ps1 用正则 `envId:\s*"([^"]+)"` 解析本文件，
 * 所以 envId 必须写成直接字面量，不能用变量或 getter 间接。
 *
 * ⚠️ 本仓库留的是占位符 REPLACE_ME，请替换成你自己的云环境 ID。
 *    占位符会让 isConfigured 为 false，程序跳过云开发初始化并给出明确提示，
 *    不会误连到别人的环境。
 *
 * 如果你有多个工程共用同一个云环境，请给集合名加各自的前缀做隔离
 * （本工程统一用 lottery* 前缀）。
 */
const envList = [
  {
    envId: "REPLACE_ME",
    alias: "my-env",
    name: "默认环境",
  },
];

/** 当前生效的环境 ID，取第一个作为默认环境 */
const currentEnvId = envList.length > 0 ? envList[0].envId : "";

/** 环境是否已真正配置（还是占位符时为 false） */
const isConfigured = !!currentEnvId && currentEnvId.indexOf("REPLACE") === -1;

module.exports = {
  envList,
  currentEnvId,
  isConfigured,
};
