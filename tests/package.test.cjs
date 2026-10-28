// 打包白名单防漏：清单/页面/脚本引用的运行时文件都必须被 scripts/package.ps1 收进包里。
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");
const packageScript = read("scripts", "package.ps1");

// —— 读取 $Files 白名单，以及脚本里按目录整体复制的目录 ——
const filesBlock = /\$Files\s*=\s*@\(([\s\S]*?)\)/.exec(packageScript);
assert.ok(filesBlock, "scripts/package.ps1 里找不到 $Files 白名单");
const whitelist = [...filesBlock[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
assert.ok(whitelist.length > 0, "scripts/package.ps1 的白名单是空的");

const copiedDirs = [...packageScript.matchAll(/Join-Path\s+\$Root\s+"([^"]+)"/g)]
  .map((match) => match[1])
  .filter((name) => {
    const target = path.join(root, name);
    return fs.existsSync(target) && fs.statSync(target).isDirectory();
  });

function normalizeRef(value) {
  return String(value || "")
    .split("#")[0]
    .split("?")[0]
    .trim()
    .replace(/^\.\//, "")
    .replace(/^\/+/, "");
}

function isLocalRef(value) {
  const text = String(value || "").trim();
  if (!text) return false;
  return !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(text);
}

function isCovered(ref) {
  if (whitelist.includes(ref)) return true;
  return copiedDirs.some((dir) => ref === dir || ref.startsWith(`${dir}/`));
}

const refs = [];
const add = (value) => {
  if (isLocalRef(value)) refs.push(normalizeRef(value));
};

// manifest.json：service worker、侧边栏、设置页、图标
const manifest = JSON.parse(read("manifest.json"));
add(manifest.background?.service_worker);
add(manifest.side_panel?.default_path);
add(manifest.options_page);
add(manifest.options_ui?.page);
add(manifest.action?.default_popup);
for (const icon of Object.values(manifest.icons || {})) add(icon);
for (const icon of Object.values(manifest.action?.default_icon || {})) add(icon);
for (const entry of manifest.content_scripts || []) {
  for (const file of entry.js || []) add(file);
  for (const file of entry.css || []) add(file);
}
for (const entry of manifest.web_accessible_resources || []) {
  const resources = typeof entry === "string" ? [entry] : entry.resources || [];
  for (const file of resources) add(file);
}

// panel.html / options.html 的 <script src> 与 <link href>
for (const page of ["panel.html", "options.html"]) {
  const html = read(page);
  for (const match of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) add(match[1]);
  for (const match of html.matchAll(/<link\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi)) add(match[1]);
}

// service-worker.js 的 importScripts
for (const match of read("service-worker.js").matchAll(/importScripts\s*\(([^)]*)\)/g)) {
  for (const file of match[1].matchAll(/["']([^"']+)["']/g)) add(file[1]);
}

// panel.js 里 chrome.scripting.executeScript 的 files
for (const match of read("panel.js").matchAll(/\bfiles\s*:\s*\[([^\]]*)\]/g)) {
  for (const file of match[1].matchAll(/["']([^"']+)["']/g)) add(file[1]);
}

const uniqueRefs = [...new Set(refs)];
const missing = uniqueRefs.filter((ref) => !isCovered(ref));
assert.deepEqual(
  missing,
  [],
  `scripts/package.ps1 白名单漏掉了运行时文件：${missing.join("、")}`
);

// 白名单里的普通文件本身也要存在，避免脚本打包时才报错
const missingFiles = whitelist.filter((name) => {
  const target = path.join(root, name);
  return !fs.existsSync(target);
});
assert.deepEqual(missingFiles, [], `白名单里的文件不存在：${missingFiles.join("、")}`);

process.stdout.write(`package whitelist covers ${uniqueRefs.length} runtime references\n`);
