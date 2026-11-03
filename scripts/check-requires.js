/**
 * 相对路径自检
 *
 * 扫描 miniprogram 下所有 .js 的 require("...")，逐个解析成绝对路径并检查是否存在。
 *
 * 为什么需要它：小程序里 require 路径写错时，页面 JS 模块加载失败，
 * 但页面不会报错 —— 表现是「导航栏在、正文空白」，
 * getCurrentPages() 里页面的 data 只有 __webviewId__，
 * 很难一眼看出是路径写错。这个脚本在编译前就能拦住。
 *
 * 用法：
 *   node check-requires.js [项目根目录]
 */

const fs = require("node:fs");
const path = require("node:path");

const projectRoot = path.resolve(process.argv[2] || path.join(__dirname, ".."));
const miniRoot = path.join(projectRoot, "miniprogram");

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

const REQUIRE_RE = /require\(\s*["']([^"']+)["']\s*\)/g;

const files = walk(miniRoot, []);
let checked = 0;
const problems = [];

for (const file of files) {
  const source = fs.readFileSync(file, "utf8");
  let match;
  REQUIRE_RE.lastIndex = 0;
  while ((match = REQUIRE_RE.exec(source)) !== null) {
    const spec = match[1];
    checked++;
    // 相对路径才需要解析；npm 包名交给模块系统
    if (!spec.startsWith(".")) continue;

    const resolved = path.resolve(path.dirname(file), spec);
    const candidates = [resolved, resolved + ".js", resolved + ".json", path.join(resolved, "index.js")];
    const exists = candidates.some(function (p) {
      return fs.existsSync(p);
    });

    if (!exists) {
      const rel = path.relative(projectRoot, file);
      problems.push({
        file: rel,
        spec: spec,
        resolved: path.relative(projectRoot, resolved),
      });
    }
  }
}

console.log("相对路径自检");
console.log("项目根 : " + projectRoot);
console.log("扫描   : " + files.length + " 个 js，" + checked + " 处 require");
console.log("=".repeat(52));

if (!problems.length) {
  console.log("✅ 全部 require 路径都能解析");
  process.exit(0);
}

problems.forEach(function (p) {
  console.log(
    "❌ " + p.file + "  ->  require(\"" + p.spec + "\")" +
    "\n     解析到 " + p.resolved + " （不存在）"
  );
});
console.log("");
console.log(problems.length + " 处路径有问题");
process.exit(1);
