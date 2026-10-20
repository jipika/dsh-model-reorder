/**
 * dsh-model-reorder —— 浏览器半边：在「设置 → 模型」的 provider 卡片里，给每个模型行
 * 前面加一个拖拽手柄（六点图标），按住拖动即可调整模型顺序。
 *
 * 顺序写到哪：settings 的 `providers.<route>.models` 数组（用户自定义的模型列表）。
 * 写入走官方 remote.settings.mutate，revision **每次都重新 describe 取最新的**（连续
 * 拖两次不会被乐观锁拒绝）。
 *
 * 因果链（都已对源码核对过）：
 *   配置的 models 数组顺序 → PiAiAdapter.listModels（adapter.ts:287-298 原样 map）
 *   → host 的 modelCatalog（session-controller/src/catalog.ts:51 `models: entries`）
 *   → 选择器（ui-model-selection/src/client/catalog.ts:61-64 遍历 group.models，不重排）。
 * 所以改数组顺序 = 模型选择器里的顺序随之改变。
 *
 * 为什么排序不会被官方卡片「保存」覆盖：官方 applyOnce 用 pathOps(打开时的值, 草稿)
 * 逐字段比较生成 op（ProviderEditor.tsx:121-133），排序没碰 React 草稿，diff 里没有
 * models，因此不会把旧顺序写回去。反过来，用户若在该卡片增删改模型行，则整段 models
 * 以他的编辑为准（属预期）。
 *
 * 失败处理：mutate 被拒（例如他人同时改了设置）时，把 DOM 顺序**回滚**到拖动前、
 * 并说明原因 —— 保证"你看到的顺序"与"已保存的顺序"始终一致。
 *
 * 边界：只对已有自定义 models 数组的卡片给手柄；继承默认目录的卡片没有数组可写，
 * 提示一行说明。注入幂等（重复渲染不叠手柄），选择器用属性子串避开 CSS Module hash。
 */
window.__ModuleLoader__.load({
	id: "dsh-model-reorder",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		/** 前端版本号：每次改这个文件都 +1（Console 会打印，便于确认 bundle 是否更新）。 */
		const REV = "0.1.1";
		const MARK = "data-mro";
		const STYLE_ID = "dsh-mro-style";
		const HANDLE_ICON = '<svg width="10" height="14" viewBox="0 0 10 14" aria-hidden="true">'
			+ '<circle cx="2.5" cy="3" r="1.3" fill="currentColor"/><circle cx="7.5" cy="3" r="1.3" fill="currentColor"/>'
			+ '<circle cx="2.5" cy="7" r="1.3" fill="currentColor"/><circle cx="7.5" cy="7" r="1.3" fill="currentColor"/>'
			+ '<circle cx="2.5" cy="11" r="1.3" fill="currentColor"/><circle cx="7.5" cy="11" r="1.3" fill="currentColor"/>'
			+ "</svg>";
		const CSS = [
			// 布局（position / left / top / padding）走 inline style，见 decorateEntry：
			// 即使这段样式没生效（选择器落空或官方改名），最坏也只是少个 hover 效果，
			// 不会把官方那行挤乱。这里只放纯视觉与拖拽反馈。
			`[${MARK}-handle]{display:inline-flex;align-items:center;justify-content:center;padding:0;border:none;background:transparent;color:inherit;opacity:.35;cursor:grab;border-radius:4px;}`,
			`[${MARK}-handle]:hover{opacity:.8;background:rgba(127,127,127,.12);}`,
			`[${MARK}-handle]:active{cursor:grabbing;}`,
			`[${MARK}-dragging]{opacity:.45;}`,
			`[${MARK}-dropbefore]{box-shadow:0 -2px 0 0 rgba(120,170,255,.9);}`,
			`[${MARK}-dropafter]{box-shadow:0 2px 0 0 rgba(120,170,255,.9);}`,
			`[${MARK}-status]{font-size:11px;line-height:1.4;opacity:.6;margin-top:4px;}`,
			`[${MARK}-status][data-error="true"]{opacity:.9;color:#e5484d;}`,
		].join("\n");

		/** 该卡片对应的 provider 路由名（route 标签优先，退回标题）。 */
		function providerOf(entry) {
			const card = entry.closest('[class*="_editor"]');
			if (card === null) return undefined;
			const route = card.querySelector('[class*="_editorRoute"]');
			const routeText = route?.textContent?.trim();
			if (routeText) return routeText;
			const title = card.querySelector('[class*="_editorTitle"]');
			return title?.textContent?.trim() || undefined;
		}

		/** 这一行当前的模型 id（模型行第一个文本框就是 id 字段）。 */
		function modelIdOf(entry) {
			const row = entry.querySelector('[class*="_modelRow"]');
			const input = row?.querySelector('input');
			return input?.value?.trim() || undefined;
		}

		/** 容器里当前的模型行，按 DOM 顺序。 */
		function entriesOf(list) {
			return [...list.querySelectorAll('[class*="_modelEntry"]')];
		}

		/**
		 * 这个 provider 的 models 数组住在哪个 namespace 里；revision 每次都现取。
		 * @returns {{ns: string, revision: number|undefined, models: object[]} | {error: string}}
		 */
		async function findModelsContext(ctx, route) {
			try {
				const remote = ctx.remote;
				if (remote === undefined) return { error: "远程接口不可用" };
				const answer = await remote.settings.describe();
				if (!answer.ok) return { error: answer.error?.message ?? "读取设置失败" };
				for (const view of answer.value?.namespaces ?? []) {
					const models = view?.value?.providers?.[route]?.models;
					if (Array.isArray(models)) return { ns: view.ns, revision: view.revision, models };
				}
				return { error: `没找到 ${route} 的模型列表（这张卡片用的是默认目录，先自定义模型才能排序）` };
			} catch (e) {
				return { error: String(e?.message ?? e) };
			}
		}

		/** 按 id 顺序重排模型数组（保留每个条目的全部字段；未知 id 落在末尾）。 */
		function reorderModels(models, ids) {
			const byId = new Map();
			for (const model of models) {
				const id = typeof model?.id === "string" ? model.id : undefined;
				if (id !== undefined && !byId.has(id)) byId.set(id, model);
			}
			const ordered = [];
			for (const id of ids) {
				const hit = byId.get(id);
				if (hit !== undefined) {
					ordered.push(hit);
					byId.delete(id);
				}
			}
			for (const leftover of byId.values()) ordered.push(leftover);
			return ordered;
		}

		/** 清掉所有落点指示。 */
		function clearIndicators(list) {
			for (const entry of entriesOf(list)) {
				entry.removeAttribute(`${MARK}-dropbefore`);
				entry.removeAttribute(`${MARK}-dropafter`);
			}
		}

		/** 按给定的节点顺序重排 DOM（失败回滚也用它）。 */
		function applyOrder(list, order) {
			for (const entry of order) list.appendChild(entry);
		}

		/** 每张卡片一个提示行（成功/失败都写它）。 */
		function statusOf(list) {
			const host = list.parentElement ?? document.body;
			let node = host.querySelector(`[${MARK}-status]`);
			if (node === null) {
				node = document.createElement("div");
				node.setAttribute(`${MARK}-status`, "");
				list.after(node);
			}
			return node;
		}

		function setStatus(list, text, isError) {
			const node = statusOf(list);
			node.textContent = text;
			node.setAttribute("data-error", isError === true ? "true" : "false");
		}

		/** 把一次 drop 落成一次设置写入；失败则回滚 DOM 顺序并说明原因。 */
		async function commitOrder(ctx, list, dragged, target, after, previousOrder) {
			const route = providerOf(dragged) ?? providerOf(target);
			if (route === undefined) return;
			const draggedId = modelIdOf(dragged);
			if (typeof draggedId !== "string" || draggedId.length === 0) return;

			// DOM 当前顺序就是用户刚拖出来的目标顺序
			const ids = entriesOf(list)
				.map(entry => modelIdOf(entry))
				.filter(id => typeof id === "string" && id.length > 0);

			setStatus(list, "正在保存顺序…", false);
			const context = await findModelsContext(ctx, route);
			if (context.error !== undefined) {
				applyOrder(list, previousOrder);
				setStatus(list, context.error, true);
				return;
			}
			const next = reorderModels(context.models, ids);
			try {
				const answer = await ctx.remote.settings.mutate(
					context.ns,
					[{ op: "set", path: ["providers", route, "models"], value: next }],
					context.revision,
				);
				if (answer.ok) {
					setStatus(list, `顺序已保存：${ids.join(" → ")}`, false);
				} else {
					applyOrder(list, previousOrder);
					setStatus(list, `${answer.error?.message ?? "保存失败"}（已恢复原顺序）`, true);
				}
			} catch (e) {
				applyOrder(list, previousOrder);
				setStatus(list, `${String(e?.message ?? e)}（已恢复原顺序）`, true);
			}
		}

		/** 给一个模型行装手柄与拖拽事件。 */
		function decorateEntry(entry, list, ctx) {
			const row = entry.querySelector('[class*="_modelRow"]');
			if (row === null) return;
			if (entry.querySelector(`[${MARK}-handle]`) !== null) return;

			const handle = document.createElement("button");
			handle.type = "button";
			handle.setAttribute(`${MARK}-handle`, "");
			handle.draggable = true;
			handle.title = "按住拖动调整顺序";
			handle.setAttribute("aria-label", "拖动调整模型顺序");
			handle.innerHTML = HANDLE_ICON;
			// 官方 `_modelRow` 是固定 4 列 grid（ModelsSection.module.css:466-471），手柄一旦成为
			// 它的子节点就会占掉第一格、把删除按钮挤到第二行。所以手柄挂到**卡片容器**上、
			// 绝对定位在左上角，并给行留出左侧内边距；这三处布局都用 inline style 写死，
			// 不依赖我们那段 CSS 是否命中（不命中时最坏只是少了 hover 效果）。
			// 数字出处：`.modelEntry{padding:6px}`（460-464 行）、`.iconButton{height:28px}`（475-482 行），
			// 于是 top = 6 + (28 − 26)/2 = 7px。
			if (entry.style.position === "" || entry.style.position === "static") entry.style.position = "relative";
			if (row.style.paddingLeft === "") row.style.paddingLeft = "26px";
			Object.assign(handle.style, {
				position: "absolute",
				left: "6px",
				top: "7px",
				width: "18px",
				height: "26px",
				zIndex: "1",
			});
			entry.insertBefore(handle, row);

			handle.addEventListener("dragstart", (event) => {
				entry.setAttribute(`${MARK}-dragging`, "");
				// 拖动前的 DOM 顺序：写入失败时按它回滚
				list[`__${MARK}_previous`] = entriesOf(list);
				if (event.dataTransfer !== null && event.dataTransfer !== undefined) {
					event.dataTransfer.effectAllowed = "move";
					event.dataTransfer.setData("text/plain", modelIdOf(entry) ?? "");
				}
			});
			handle.addEventListener("dragend", () => {
				entry.removeAttribute(`${MARK}-dragging`);
				clearIndicators(list);
			});
		}

		/** 在模型列表容器上装一次 dragover/drop 处理。 */
		function decorateList(list, ctx) {
			if (list.getAttribute(`${MARK}-list`) !== null) return;
			list.setAttribute(`${MARK}-list`, "");

			list.addEventListener("dragover", (event) => {
				const dragged = list.querySelector(`[${MARK}-dragging]`);
				if (dragged === null) return;
				event.preventDefault();
				if (event.dataTransfer !== null && event.dataTransfer !== undefined) {
					event.dataTransfer.dropEffect = "move";
				}
				const target = event.target instanceof Element
					? event.target.closest('[class*="_modelEntry"]')
					: null;
				clearIndicators(list);
				if (target === null || target === dragged || !list.contains(target)) return;
				const box = target.getBoundingClientRect();
				const after = event.clientY > box.top + box.height / 2;
				target.setAttribute(after ? `${MARK}-dropafter` : `${MARK}-dropbefore`, "");
			});

			list.addEventListener("drop", (event) => {
				const dragged = list.querySelector(`[${MARK}-dragging]`);
				if (dragged === null) return;
				event.preventDefault();
				const target = event.target instanceof Element
					? event.target.closest('[class*="_modelEntry"]')
					: null;
				clearIndicators(list);
				if (target === null || target === dragged || !list.contains(target)) return;
				const previousOrder = list[`__${MARK}_previous`] ?? entriesOf(list);
				const box = target.getBoundingClientRect();
				const after = event.clientY > box.top + box.height / 2;
				const reference = after ? target.nextElementSibling : target;
				list.insertBefore(dragged, reference);
				void commitOrder(ctx, list, dragged, target, after, previousOrder);
			});
		}

		/** 扫描整页：给每个模型列表与模型行装手柄。 */
		function scan(ctx) {
			for (const list of document.querySelectorAll('[class*="_modelList"]')) {
				decorateList(list, ctx);
				for (const entry of entriesOf(list)) decorateEntry(entry, list, ctx);
			}
		}

		function apply(ctx) {
			console.info(`[dsh-model-reorder] client rev ${REV} 已加载`);
			if (!document.head) {
				document.addEventListener("DOMContentLoaded", () => { apply(ctx); }, { once: true });
				return;
			}
			let style = document.getElementById(STYLE_ID);
			if (style === null) {
				style = document.createElement("style");
				style.id = STYLE_ID;
				document.head.appendChild(style);
			}
			style.textContent = CSS;

			let scheduled = false;
			const schedule = () => {
				if (scheduled) return;
				scheduled = true;
				requestAnimationFrame(() => {
					scheduled = false;
					scan(ctx);
				});
			};
			new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
			schedule();
		}

		exports.name = "dsh-model-reorder/client";
		// 与同页面的 dsh-model-key-override 同源教训：读 ctx.remote 必须注入 'remote' 本身，
		// 只注入子服务会抛 cannot get property "remote" without inject。
		exports.inject = ["remote", "remote.settings"];
		exports.apply = apply;
		return module.exports;
	},
});
