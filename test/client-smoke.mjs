/**
 * 冒烟：用最小 DOM 替身加载 client.js，验证拖拽排序的完整链路
 *   ① bundle 加载、inject 含 remote（同页面另一个插件踩过 cannot get property "remote"）
 *   ② 手柄插进模型行的最前面，且重复扫描不叠第二套
 *   ③ 拖拽 drop 后：DOM 顺序变化 + 发出一条 settings.mutate（ns / path / 重排后的完整数组 / 现取的 revision）
 *   ④ mutate 被拒时：DOM 顺序**回滚**，提示行说明原因
 * 运行：node test/client-smoke.mjs
 */
import { readFileSync } from "node:fs";

class MockElement {}
globalThis.Element = MockElement;

function makeEl(tag = "div", className = "") {
  const node = new MockElement();
  Object.assign(node, {
    tagName: tag.toUpperCase(),
    className,
    children: [],
    parentNode: null,
    listeners: {},
    attrs: {},
    textContent: "",
    value: "",
    placeholder: "",
    type: "",
    draggable: false,
    disabled: false,
    innerHTML: "",
  });
  // CSSStyleDeclaration 的语义：未设置的属性读出来是空串（不是 undefined）
  const styleBag = {};
  node.style = new Proxy(styleBag, {
    get: (target, key) => (key in target ? target[key] : ""),
    set: (target, key, value) => { target[key] = String(value); return true; },
  });
  node.setAttribute = (k, v) => { node.attrs[k] = String(v); if (k === "class") node.className = String(v); };
  node.getAttribute = (k) => node.attrs[k] ?? null;
  node.removeAttribute = (k) => { delete node.attrs[k]; };
  node.hasAttribute = (k) => Object.prototype.hasOwnProperty.call(node.attrs, k);
  node.appendChild = (child) => { if (child.parentNode) child.parentNode.children = child.parentNode.children.filter(c => c !== child); node.children.push(child); child.parentNode = node; return child; };
  node.insertBefore = (child, ref) => {
    if (child.parentNode) child.parentNode.children = child.parentNode.children.filter(c => c !== child);
    if (ref === null || ref === undefined) { node.children.push(child); }
    else { const at = node.children.indexOf(ref); node.children.splice(at < 0 ? node.children.length : at, 0, child); }
    child.parentNode = node;
    return child;
  };
  node.after = (sibling) => { node.parentNode?.insertBefore(sibling, node.nextElementSibling); return sibling; };
  node.addEventListener = (type, fn) => { (node.listeners[type] ??= []).push(fn); };
  node.dispatchEvent = (event) => { event.target ??= node; for (const fn of node.listeners[event.type] ?? []) fn(event); return true; };
  node.getBoundingClientRect = () => ({ top: node.__top ?? 0, height: node.__height ?? 20, bottom: (node.__top ?? 0) + (node.__height ?? 20) });
  node.closest = (selector) => { let cur = node; while (cur) { if (matches(cur, selector)) return cur; cur = cur.parentNode; } return null; };
  node.contains = (other) => { let cur = other; while (cur) { if (cur === node) return true; cur = cur.parentNode; } return false; };
  node.querySelector = (selector) => search(node, selector)[0] ?? null;
  node.querySelectorAll = (selector) => search(node, selector);
  Object.defineProperty(node, "firstChild", { get: () => node.children[0] ?? null });
  Object.defineProperty(node, "nextElementSibling", {
    get: () => {
      const siblings = node.parentNode?.children ?? [];
      const at = siblings.indexOf(node);
      return at < 0 ? null : (siblings[at + 1] ?? null);
    },
  });
  return node;
}
function allDescendants(root) {
  const out = [];
  const walk = (n) => { for (const c of n.children) { out.push(c); walk(c); } };
  walk(root);
  return out;
}
function matches(node, selector) {
  const attrStar = selector.match(/^\[([a-zA-Z-]+)\*="([^"]+)"\]$/);
  if (attrStar) return String(node.className ?? "").includes(attrStar[2]);
  const attrOnly = selector.match(/^\[([a-zA-Z-]+)\]$/);
  if (attrOnly) return Object.prototype.hasOwnProperty.call(node.attrs, attrOnly[1]);
  if (selector === "input") return node.tagName === "INPUT";
  return false;
}
function search(root, selector) { return allDescendants(root).filter(node => matches(node, selector)); }

// ── 造卡片：company 的 3 个模型 ─────────────────────────────────────────────
const card = makeEl("div", "_editor_c");
const route = makeEl("span", "_editorRoute_c");
route.textContent = "company";
card.appendChild(route);
const list = makeEl("div", "_modelList_c");
card.appendChild(list);
const ids = ["glm-5.3-flash", "deepseek-v4.1-flash", "glm-5.3-air"];
const entries = ids.map((id, index) => {
  const entry = makeEl("div", "_modelEntry_c");
  entry.__top = index * 40; entry.__height = 36;
  const row = makeEl("div", "_modelRow_c");
  const idInput = makeEl("input");
  idInput.value = id;
  row.appendChild(idInput);
  entry.appendChild(row);
  entry.appendChild(makeEl("div", "_modelAdvanced_c"));
  list.appendChild(entry);
  return entry;
});

// ── 环境替身 ────────────────────────────────────────────────────────────────
let spec;
const logs = [];
const originalInfo = console.info;
console.info = (...args) => { logs.push(args.join(" ")); };
globalThis.window = { __ModuleLoader__: { load: (s) => { spec = s; } } };
globalThis.document = {
  head: makeEl("head"),
  body: makeEl("body"),
  documentElement: makeEl("html"),
  addEventListener() {},
  createElement: (tag) => makeEl(tag),
  getElementById: () => null,
  querySelectorAll: (selector) => (selector.includes("_modelList") ? [list] : []),
};
globalThis.MutationObserver = class { observe() {} };
globalThis.requestAnimationFrame = (cb) => { cb(); return 0; };

const src = readFileSync(new URL("../client.js", import.meta.url), "utf8");
eval(src);

let failures = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`);
};
const orderOf = () => list.children.map(entry => entry.querySelector("input").value);

check("模块 id", spec.id, "dsh-model-reorder");
const mod = spec.factory(() => { throw new Error("不该 require 模块"); });
check("inject 含 remote 与 remote.settings", mod.inject, ["remote", "remote.settings"]);

const mutateCalls = [];
let mutateOk = true;
const settingsValue = {
  providers: {
    company: {
      baseURL: "https://www.heilovehei.com/v1",
      apiKeyEnv: "COMPANY_API_KEY",
      models: [
        { id: "glm-5.3-flash", name: "GLM 5.3 Flash", contextWindow: 200000 },
        { id: "deepseek-v4.1-flash", name: "DS 4.1 Flash" },
        { id: "glm-5.3-air", name: "GLM 5.3 Air" },
      ],
    },
  },
};
const ctx = {
  remote: {
    settings: {
      describe: async () => ({ ok: true, value: { namespaces: [{ ns: "llm-pi-ai", revision: 7, value: settingsValue }] } }),
      mutate: async (ns, ops, revision) => { mutateCalls.push({ ns, ops, revision }); return mutateOk ? { ok: true } : { ok: false, error: { message: "settings/conflict" } }; },
    },
  },
};

mod.apply(ctx);
await new Promise(r => setTimeout(r, 0));

check("加载日志带 rev", logs.some(l => /client rev \d+\.\d+\.\d+/.test(l)), true);
check("每张卡片都插了手柄", entries.map(e => e.querySelector('[data-mro-handle]') !== null), [true, true, true]);
// 手柄必须是卡片的子节点、排在模型行之前 —— 绝不能进 _modelRow（那是固定 4 列 grid，
// 多一个子节点会把删除按钮挤到第二行，2026-10-12 用户截图实测过这个回归）。
check("手柄在卡片下、位于模型行之前", entries.map(e => {
  const row = e.querySelector('[class*="_modelRow"]');
  return e.children.indexOf(e.querySelector('[data-mro-handle]')) < e.children.indexOf(row)
    && row.children.some(c => c.hasAttribute && c.hasAttribute("data-mro-handle")) === false;
}), [true, true, true]);
check("手柄是绝对定位（不参与官方 grid）", entries.map(e => e.querySelector('[data-mro-handle]').style.position), ["absolute", "absolute", "absolute"]);
check("模型行留出了左侧内边距", entries.map(e => e.querySelector('[class*="_modelRow"]').style.paddingLeft), ["26px", "26px", "26px"]);

mod.apply(ctx);
await new Promise(r => setTimeout(r, 0));
check("重复扫描不叠手柄", list.querySelectorAll('[data-mro-handle]').length, 3);

// ── 拖拽：把第 1 个（glm-5.3-flash）拖到第 3 个（glm-5.3-air）之后 ────────────
const dragged = entries[0];
const target = entries[2];
const dataTransfer = { effectAllowed: "", dropEffect: "", setData() {} };
dragged.querySelector('[data-mro-handle]').dispatchEvent({ type: "dragstart", dataTransfer });
list.dispatchEvent({ type: "dragover", target, dataTransfer, clientY: target.__top + target.__height - 1, preventDefault() {} });
list.dispatchEvent({ type: "drop", target, dataTransfer, clientY: target.__top + target.__height - 1, preventDefault() {} });
await new Promise(r => setTimeout(r, 0));

check("DOM 顺序已按拖拽结果重排", orderOf(), ["deepseek-v4.1-flash", "glm-5.3-air", "glm-5.3-flash"]);
check("发出一次 mutate", mutateCalls.length, 1);
check("mutate namespace", mutateCalls[0]?.ns, "llm-pi-ai");
check("mutate path", mutateCalls[0]?.ops?.[0]?.path, ["providers", "company", "models"]);
check("mutate 用的是现取的 revision", mutateCalls[0]?.revision, 7);
check("写回的是重排后的完整对象数组（字段没丢）", mutateCalls[0]?.ops?.[0]?.value, [
  { id: "deepseek-v4.1-flash", name: "DS 4.1 Flash" },
  { id: "glm-5.3-air", name: "GLM 5.3 Air" },
  { id: "glm-5.3-flash", name: "GLM 5.3 Flash", contextWindow: 200000 },
]);

// ── 失败路径：mutate 被拒 → DOM 回滚 ────────────────────────────────────────
mutateOk = false;
const dragged2 = list.children[0];
const target2 = list.children[2];
dragged2.querySelector('[data-mro-handle]').dispatchEvent({ type: "dragstart", dataTransfer });
list.dispatchEvent({ type: "drop", target: target2, dataTransfer, clientY: target2.__top + target2.__height - 1, preventDefault() {} });
await new Promise(r => setTimeout(r, 0));

check("mutate 被拒后 DOM 回滚到拖动前顺序", orderOf(), ["deepseek-v4.1-flash", "glm-5.3-air", "glm-5.3-flash"]);
const statusNode = card.querySelector('[data-mro-status]');
check("提示行说明已恢复原顺序", /已恢复原顺序/.test(statusNode?.textContent ?? ""), true);

console.info = originalInfo;
console.log(`\n${failures === 0 ? "全部通过" : `${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);
