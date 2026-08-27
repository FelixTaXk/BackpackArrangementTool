// scripts/test-harness.mjs —— 纯逻辑层回归测试台（Node，零依赖）。
// 目的：在没有浏览器的环境里，按 index.html 的加载顺序把「纯逻辑层」脚本喂进同一个 vm 上下文，
// 从而对 data/talisman-db.js + config/utils/state/talisman-model/score-shared/engine-encoding/solver
// 做真实源文件级断言（不复制、不重写业务逻辑）。UI 层（ui-*.js）依赖真实 DOM，不在此加载。
//
// 用法：node scripts/test-harness.mjs
// 约定：任何断言失败 → 非零退出码；成功 → 打印通过数。

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// index.html 中的加载顺序里，不触碰 DOM 的「纯逻辑层」子集。
export const LOGIC_SCRIPTS = [
  'data/talisman-db.js',
  'js/config.js',
  'js/utils.js',
  'js/state.js',
  'js/talisman-model.js',
  'js/score-shared.js',
  'js/engine-encoding.js',
  'js/engine-orchestrator.js',
  'js/solver.js'
];

// ---- 最小 DOM / BOM 桩 ------------------------------------------------------
// 只提供被纯逻辑层实际触达的表面：document.getElementById 返回可读写的假控件，
// 元素值由测试用例通过 harness.setEl(id, value) 注入。
function makeStubs(elValues){
  const els = new Map();
  const makeEl = id => ({
    id,
    value: elValues[id] !== undefined ? String(elValues[id]) : '',
    checked: !!elValues[id],
    textContent: '',
    max: '',
    style: {},
    classList: { add(){}, remove(){}, toggle(){}, contains(){ return false; } },
    appendChild(){}, removeChild(){}, setAttribute(){}, getAttribute(){ return null; },
    addEventListener(){}, querySelectorAll(){ return []; }, querySelector(){ return null; }
  });
  const document = {
    getElementById(id){
      if(!els.has(id)) els.set(id, makeEl(id));
      return els.get(id);
    },
    createElement(tag){ return makeEl('<'+tag+'>'); },
    querySelectorAll(){ return []; },
    querySelector(){ return null; },
    addEventListener(){}
  };
  return { document, els };
}

export function loadLogicLayer(opts = {}){
  const { document, els } = makeStubs(opts.elValues || {});
  const sandbox = {
    console,
    document,
    navigator: { hardwareConcurrency: 8 },
    performance: { now: () => Date.now() },
    localStorage: {
      _m: new Map(),
      getItem(k){ return this._m.has(k) ? this._m.get(k) : null; },
      setItem(k, v){ this._m.set(k, String(v)); },
      removeItem(k){ this._m.delete(k); }
    },
    alert(msg){ sandbox.__alerts.push(String(msg)); },
    __alerts: [],
    setTimeout, clearTimeout, setInterval, clearInterval,
    URL: { createObjectURL: () => 'blob:stub', revokeObjectURL(){} },
    Blob: class { constructor(parts){ this.parts = parts; } },
    Worker: class { constructor(){ this.onmessage = null; } postMessage(){} terminate(){} }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);

  // 经典脚本语义：同一上下文内顺序求值，顶层 const/let 共享全局词法环境。
  for(const rel of LOGIC_SCRIPTS){
    const file = path.join(ROOT, rel);
    const src = fs.readFileSync(file, 'utf8');
    try{
      new vm.Script(src, { filename: rel }).runInContext(ctx);
    }catch(e){
      throw new Error(`加载 ${rel} 失败：${e && e.stack || e}`);
    }
  }
  return { ctx, sandbox, els, document };
}

// ---- 极简断言器 ------------------------------------------------------------
export function makeAsserter(label){
  let pass = 0;
  const fails = [];
  const ok = (cond, msg) => { if(cond) pass++; else fails.push(msg); };
  const eq = (got, want, msg) => ok(
    Object.is(got, want),
    `${msg}（期望 ${JSON.stringify(want)}，实得 ${JSON.stringify(got)}）`
  );
  const near = (got, want, tol, msg) => ok(
    Math.abs(Number(got) - Number(want)) <= tol,
    `${msg}（期望 ≈${want}±${tol}，实得 ${got}）`
  );
  const report = () => {
    if(fails.length){
      console.log(`\n✗ ${label}：${pass} 通过 / ${fails.length} 失败`);
      fails.forEach((m, i) => console.log(`   ${i + 1}. ${m}`));
      return false;
    }
    console.log(`✓ ${label}：${pass} 项断言全部通过`);
    return true;
  };
  return { ok, eq, near, report, get pass(){ return pass; }, get fails(){ return fails; } };
}

// 直接执行时做一次自检：逻辑层能加载 + 数据库校验通过。
if(process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)){
  const { sandbox } = loadLogicLayer();
  const a = makeAsserter('harness 自检');
  a.ok(typeof sandbox.buildActiveMask === 'function', 'utils.buildActiveMask 可见');
  a.ok(typeof sandbox.maskToDec === 'function', 'utils.maskToDec 可见');
  a.ok(typeof sandbox.scorePairBonusEvents === 'function', 'score-shared.scorePairBonusEvents 可见');
  a.ok(typeof sandbox.encBuildModel === 'function', 'engine-encoding.encBuildModel 可见');
  a.ok(typeof sandbox.prepareInventoryItems === 'function', 'solver.prepareInventoryItems 可见');
  const valid = sandbox.validateTalismanDB();
  a.eq(valid.length, sandbox.TALISMAN_DB.talismans.length, '数据库校验后条目数自洽');
  a.ok(valid.length > 300, `数据库条目数应 >300（实得 ${valid.length}）`);
  process.exit(a.report() ? 0 : 1);
}
