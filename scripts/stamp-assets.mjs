// 目的：给 index.html 中对本地静态资源（css/*.css、js/*.js、data/*.js）的引用统一盖上
//       「内容哈希版本号」(?v=<sha1 前 8 位>)，让 GitHub Pages 的 10 分钟强缓存
//       （响应头 Cache-Control: max-age=600）在文件内容变化时自动失效——
//       文件名不变、URL 变了，浏览器与中间代理都必须重新下载，
//       杜绝「发布明明成功，页面却仍跑旧 js」这类假故障。
//
// 由 publish-to-github.bat 在 git add 之前调用（也可手动运行）。
// 幂等：内容没变的文件哈希不变、index.html 不动；只对被改动的文件造成 URL 变化。
//
// 用法：
//   node scripts/stamp-assets.mjs           写回 index.html
//   node scripts/stamp-assets.mjs --check   只报告不改（有需要更新时退出码 1）
//
// 注意：输出为纯 ASCII 英文 —— 本脚本由 .bat 调用，cmd 默认 GBK 代码页，
//       中文提示会变乱码（项目内 convert-talisman-db.bat 已踩过这个坑）。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INDEX_PATH = path.join(ROOT, 'index.html');
const CHECK_ONLY = process.argv.includes('--check');

// 匹配任意 src="/  href=" 属性值，并把「已存在的查询串」一起吃掉，便于原地刷版本号
const ATTR_RE = /(\b(?:src|href)=")([^"?#]+)(?:\?[^"]*)?(")/g;
const STAMPABLE_RE = /\.(?:js|css)$/i;

function shortHash(absPath) {
  // 归一化 CRLF：core.autocrlf=true 时工作区是 CRLF、仓库内是 LF，
  // 若按原始字节取哈希，换台机器/换行策略一变版本号就漂移，产生无意义改动。
  const text = fs.readFileSync(absPath).toString('binary').replace(/\r\n/g, '\n');
  return crypto.createHash('sha1').update(Buffer.from(text, 'binary')).digest('hex').slice(0, 8);
}

if (!fs.existsSync(INDEX_PATH)) {
  console.error('[stamp] ERROR: index.html not found at ' + INDEX_PATH);
  process.exit(1);
}

const html = fs.readFileSync(INDEX_PATH, 'utf8');
const rows = [];
let changed = 0;

const next = html.replace(ATTR_RE, (whole, pre, ref, post) => {
  if (!STAMPABLE_RE.test(ref)) return whole;                                   // 只处理 js/css
  if (/^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(ref) || ref.startsWith('data:')) return whole; // 站外 / 协议相对 / 内联
  if (ref.startsWith('/')) return whole;                                       // 站点根绝对路径（本项目无此用法）

  const abs = path.join(ROOT, ref.split('/').join(path.sep));
  if (!fs.existsSync(abs)) {
    rows.push(['MISS', ref, '-', 'file not found, left untouched']);
    return whole;
  }

  const hash = shortHash(abs);
  const prev = (whole.match(/\?v=([0-9a-zA-Z._-]+)/) || [])[1] || '';
  if (prev !== hash) changed++;
  rows.push([prev === hash ? 'KEEP' : (prev ? 'BUMP' : 'NEW'), ref, hash,
             prev ? ('was ' + prev) : 'no stamp before']);
  return pre + ref + '?v=' + hash + post;
});

const width = rows.reduce((w, r) => Math.max(w, r[1].length), 12);
for (const [tag, ref, hash, note] of rows) {
  console.log(tag.padEnd(4) + ' ' + ref.padEnd(width) + '  v=' + String(hash).padEnd(9) + ' ' + note);
}
console.log('');
console.log('[stamp] assets=' + rows.length + ' needUpdate=' + changed);

if (next === html) {
  console.log('[stamp] index.html unchanged (all stamps already current).');
  process.exit(0);
}
if (CHECK_ONLY) {
  console.log('[stamp] --check: index.html WILL be updated (nothing written).');
  process.exit(1);
}
fs.writeFileSync(INDEX_PATH, next);
console.log('[stamp] index.html updated.');
console.log('[stamp] note: index.html itself still has the ~10min Pages cache; after that every asset URL is guaranteed fresh.');
