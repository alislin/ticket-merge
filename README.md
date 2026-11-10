# ticket-merge — 发票合并打印工具

将 `data\` 目录下的发票 PDF（如铁路电子客票、电子发票）合并到 A4 页面上，方便打印和报销归档。支持单页 1~9 张自动排版，也可强制指定布局。

## 功能特性

- 自动扫描 `data\` 目录下的所有 `*.pdf`，按文件名排序合并
- 根据每页票据张数**自动选择最优布局**（缩放最大的排法），等比缩放不变形、格内居中、间距均匀
- 单页最多 9 张，超过自动分页，末页按余数排布
- 可通过 `--layout` 强制指定布局
- 合并结果保留矢量文字，打印清晰
- 运行后输出合并报告（默认控制台，`--report` 写入文件）
- 兼容多页 PDF（取第 1 页）、页面旋转（90°/180°/270°）、加密 PDF

## 环境要求

- [Node.js](https://nodejs.org/) ≥ 18
- 依赖：[pdf-lib](https://pdf-lib.js.org/)（纯 JS，无原生编译依赖）

## 安装

```bash
npm install
```

## 使用

```bash
node merge-tickets.mjs        # 或 npm run merge
```

默认读取 `data\*.pdf`，输出 `out\merged.pdf`，报告打印到控制台。

### 常用示例

```bash
# 单页最多 9 张
node merge-tickets.mjs --max-per-page 9

# 强制横版 2×2（每页 4 张）
node merge-tickets.mjs --layout h2x2

# 强制竖版一列三行（每页 3 张），并把报告写入 out\merge-report.md
node merge-tickets.mjs --layout 3x1 --report

# 自定义输入/输出目录与间距
node merge-tickets.mjs --input tickets --output print --margin-mm 5 --gap-mm 8
```

## 参数说明

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `--input <dir>` | 输入目录，扫描其中的 `*.pdf` | `data` |
| `--output <dir>` | 输出目录，写入 `merged.pdf` | `out` |
| `--max-per-page <n>` | 每页最多合并的票据数，1~9（指定 `--layout` 时被忽略） | `4` |
| `--margin-mm <mm>` | 页边距 | `3` |
| `--gap-mm <mm>` | 票间距 | `6` |
| `--layout <spec>` | 强制布局：`auto` 或 `[h]行x列`，如 `2x1`、`2x2`、`h2x2`、`3x3`（`h` = 横版） | `auto` |
| `--report` | 将报告写入输出目录 `merge-report.md`（默认仅控制台输出） | 关闭 |
| `-h`, `--help` | 显示帮助 | — |

## 自动布局规则

对每种候选排法（竖版/横版 × 行列组合）计算可达到的最大缩放，**选缩放最大者**；同缩放时优先无空格、其次竖版。以 210×140mm 的铁路电子客票为例：

| 本页张数 | 布局 | 缩放 |
|---------|------|------|
| 1~2 张 | 竖版（居中 / 上下两行） | ≈97% |
| 3 张 | 竖版一列三行 | ≈66% |
| 4 张 | 横版 2×2 | ≈68% |
| 5~6 张 | 竖版 3行×2列 | ≈47% |
| 7~8 张 | 竖版 4行×2列 | ≈47% |
| 9 张 | 横版 3×3 | ≈44% |
| ≥10 张 | 每 N 张一页，末页按余数自动选 | — |

> 布局是通用算法而非固定模板：换其他尺寸的票据（如增值税电子发票、行程单）也能自动排出较优结果。

## 输出报告

运行结束后输出报告，包含：生成时间、输入/输出路径、总页数、参数、输入清单（文件名与票面尺寸）、页面明细（布局、缩放、每张票据的位置与打印尺寸）、警告（多页 PDF 只取第 1 页、参数被忽略等）。

- 默认打印到控制台
- 加 `--report` 时额外写入 `out\merge-report.md`（Markdown 格式）

## 项目结构

```
ticket-merge
├── data\                  # 输入：待合并的发票 PDF
├── out\                   # 输出：merged.pdf（及可选的 merge-report.md）
├── merge-tickets.mjs      # 合并脚本
├── package.json
└── README.md
```

## 打印建议

- 纸张选 A4，缩放选"实际大小"（100%），不要选"适应页面"
- 竖版页按普通方向打印；横版页打印机会自动识别方向

## License

MIT
