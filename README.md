# LITS 四格骨墙

一个基于 Web 的 LITS 谜题游戏，原生 SVG 渲染，内置逻辑解题器。

## 在线体验

```bash
npm install
npm start
```

`npm start` 会等开发服务就绪后用默认浏览器打开 **http://127.0.0.1:5180/**。

> 也可以用 `npm run dev`，但不会自动打开浏览器。

## 游戏规则

- 每个区域恰好放一块 4 格骨牌，形状只能是 L、I、S、T，旋转或翻转视为同型
- 任意 2×2 区域不能全实心
- 同型骨牌不能上下左右接触
- 所有骨牌必须连成一片

## 操作

| 操作 | 说明 |
|------|------|
| 左键点格 | 填实心；点已有实心则清除 |
| 右键点格 | 标叉；点已有叉则清除 |
| 从空格拖动 | 只填充空格，左键实心、右键标叉 |
| 从实心/叉拖动 | 连续擦除，只擦除起始格那种标记 |
| 滚轮 / 中键拖拽 | 缩放 / 平移画布 |
| Z / Shift+Z / Y | 撤销 / 重做 |
| C / H / S / Esc | 检查 / 提示一格 / 显示解 / 清空 |
| R / L / P / M | 随机抽题 / 逻辑解题 / 暂停回放 / 音效开关 |
| 0 / + / - | 视图复位 / 放大 / 缩小 |

## 数据存放

运行 `npm start` / `npm run dev` 时，题库、进度和上次题目保存在项目内 `data/` 目录；静态部署时自动降级到浏览器 localStorage。

## 功能

- **题库**：内置多道题，题目均校验唯一解
- **实时校验**：冲突与违规位置即时高亮，满足的条件同步变灰
- **逻辑解题**：规则引擎逐帧回放，显示每一步理由；回放中按钮变为停止，按 `P` 暂停/继续
- **提示一格 / 显示解**：提示优先揭示所有解一致的格子，显示解直接填入可行答案
- **撤销/重做**：按手势分组，一次拖拽只需一步撤销
- **进度保存**：自动保存当前题目进度，刷新不丢失
- **音效特效**：Web Audio 合成拨弦、水滴与落子动画，无外部音频资源
- **缩放/平移**：滚轮缩放，中键或 `Shift` 拖拽平移
- **自定义题板**：用颜色标记区域，支持预设色板、拖动色相滑块和直接输入色号；左键拖动涂色、点击已上色格把当前颜色切换成该色、右键拖动擦除；同色相连算同一区域，不连通会自动拆成不同区域
- **图片导入**：`npm run import-image` 可识别题图并写入题库

## 技术栈

- Vite + TypeScript
- 原生 SVG（无框架）
- Web Audio 合成音效（无外部资源）
- localStorage / 项目内 `data/` 存储进度与题库

## 项目结构

```
src/
  main.ts
  core/
    app.ts / ui.ts / view.ts      界面、交互、缩放、回放控制
    store.ts / library.ts         题库、进度、上次题目存储
    audio.ts / fx.ts              音效与落子特效
  game/
    adapter.ts                    游戏规则接入
    rules.ts                      推理规则
    logic.ts                      逻辑解题回放
    render.ts / state.ts          SVG 渲染与盘面状态
    validate.ts / solver.ts       实时校验与回溯求解
    puzzles.ts / puzzles-data.ts  题库加载与静态题库
```

## 图片识别导入

```bash
# 只识别、求解、预览，不写入
npm run import-image -- 题面.png --size 15

# 识别并追加到题库
npm run import-image -- 题面.png --size 15 --name "我的 LITS" --append
```

| 参数 | 说明 |
|------|------|
| `--size N` | 网格边长；不填则自动识别 |
| `--name 名称` | 题库中显示的名称 |
| `--append` | 写入 `src/game/imported-puzzles.ts` |
| `--no-verify` | 跳过唯一解计数，只求一个解 |
| `--merge-small` | 把 2–3 格小区域并入相邻区域 |
| `--thick N` | 手动指定粗线阈值（像素） |

识别流程：投影找网格线 → 边界中点测量暗线厚度 → 四连通洪泛得到区域 → 生成 LITS 候选 → 求解并校验唯一解。

## 常用命令

```bash
npm run dev       # 开发服务
npm start         # 开发服务 + 自动打开浏览器
npm run build     # tsc --noEmit + vite build
npm run gen       # 重新生成题库
npm run check     # 审计题库
npm run verify    # 参考解、逻辑回放与交互验证
npm run audit     # 逐题审计逻辑解题
```
