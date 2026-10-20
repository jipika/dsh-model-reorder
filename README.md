# dsh-model-reorder

**在「设置 → 模型」的 provider 卡片里，给每个模型行加一个拖拽手柄（六点图标），按住拖动就能调整模型顺序。**

顺序会写回该 provider 的 `models` 数组，**模型选择器里的顺序随之改变**——常用的模型拖到最前面即可。

---

## 怎么用

1. 设置 → **模型** → 编辑某个 provider（卡片左侧有 `编辑`）；
2. 每个模型行**最前面**多了一个六点手柄 ⠿，**按住它**上下拖；
3. 拖到目标位置松手：
   - 模型列表下面出现 **「顺序已保存：a → b → c」** → 成功；
   - 出现 **「…（已恢复原顺序）」** → 写入被拒（多半是设置被别处同时改动），列表已回到拖动前的样子，重拖一次即可。

继承默认目录（卡片里没有自定义模型列表）的 provider 不出现手柄——那时没有数组可写，提示会说明。

## 关键行为（出问题时看这里）

- **顺序写到哪**：settings 的 `providers.<route>.models`（走官方 `remote.settings.mutate`，带最新 revision 的乐观锁）。
- **为什么拖完不会被官方「保存」覆盖**：官方保存只对「它看见的改动」生成写入（逐字段比较草稿与打开时的值）；你没编辑模型列表，diff 里就没有 `models`，不会把旧顺序写回去。反过来，如果你在卡片里增删或修改模型行并保存，那一整段以你的编辑为准。
- **写入失败会回滚 DOM**：保证「看到的顺序」与「已保存的顺序」始终一致。
- **可视化是即时的**：drop 当下就重排列表；若之后 React 因别处改动重渲染，顺序可能短暂回到旧样（刷新即恢复 —— 因为真正的顺序在 settings 里）。

## 自测（不需要 DSH）

```bash
node ~/.dsh/local-plugins/dsh-model-reorder/test/client-smoke.mjs
```

覆盖：手柄注入位置与幂等 / 拖拽后 DOM 重排 / mutate 的 ns·path·revision·完整数组内容 / 被拒时的回滚与提示。

## 生效与回滚

- 改了 `client.js` 后**必须重启应用**（宿主的 client bundle 是启动时读的快照，刷新页面不生效）；重启后在 Console 应看到 `[dsh-model-reorder] client rev <版本> 已加载`。
- 回滚：删掉 `cordis.patch.yml` 里 `model-reorder` 那段 insert + `package.json` 的依赖行 + 重启应用。它不碰任何数据，只是不再注入手柄。

---

## ☕ 赞赏支持

如果 dsh-model-reorder 对你的研究与测试有所帮助，欢迎请作者喝杯咖啡 ☕

<p align="center">
  <img src="assets/sponsor.jpg" width="260" alt="微信赞赏码" />
  <img src="assets/afdian_reward.jpg" width="200" alt="爱发电赞助码" />
</p>

<p align="center">
  <b>给项目点个 Star ⭐</b> 同样是对开发者最大的鼓励！
</p>
