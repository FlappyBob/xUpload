# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

xUpload — 轻量级 Chrome Extension，基于本地向量数据库实现「页面语义提示 → 本地文件智能推荐 → 自动填充上传控件」。

## Spec

### 核心流程

**阶段一：索引建立（用户主动触发）**

1. 用户通过 Popup 授权一个本地文件夹
2. 扩展遍历文件夹内所有文件（图片、PDF、文档等）
3. 对每个文件的内容生成 embedding 向量（图片用视觉特征描述，文档提取文本）
4. 将 embedding + 文件元信息存入本地向量数据库（IndexedDB）

**阶段二：智能推荐（自动触发）**

1. Content script 检测页面中的 `<input type="file">` 元素，在旁边注入推荐按钮
2. 用户点击按钮 → 提取该控件周围的上下文文本（label、placeholder、周围文字，如"请上传护照文件"）
3. 将提示文本转为查询向量
4. 在本地向量数据库中进行相似度搜索，返回 top-N 匹配文件
5. 以极简浮层面板展示推荐结果
6. 用户点击推荐项 → 自动填入对应的 `<input type="file">`

### 技术栈

- Chrome Extension Manifest V3
- TypeScript
- Vite 打包
- 向量化：浏览器端轻量模型（transformers.js）或 TF-IDF
- 向量存储：IndexedDB（本地向量数据库）

### 模块划分

| 模块 | 职责 |
|------|------|
| `content.ts` | 检测 file input、注入按钮、提取上下文、展示推荐面板 |
| `background.ts` | 协调索引构建与匹配请求 |
| `popup.ts` | 用户管理授权文件夹、触发索引构建 |
| `embeddings.ts` | 文件内容 → embedding 向量（文本提取 + 向量化） |
| `vectordb.ts` | 本地向量数据库（IndexedDB 存储 + 余弦相似度搜索） |

### 文件内容处理

| 文件类型 | 向量化方式 |
|---------|-----------|
| PDF / 文档 | 提取文本内容 → embedding |
| 图片 | 文件名 + EXIF/元数据 → embedding（MVP 阶段） |
| 其他 | 文件名 + 路径 + 类型 → embedding |

### 设计原则

- **本地优先**：所有数据和计算留在用户设备，不上传文件到任何服务器
- **低侵入**：仅在 file input 旁添加一个按钮，不修改页面其他内容
- **黑客松项目**：目标 24 小时内完成最小可用原型

## Build

```bash
npm run build    # 构建到 dist/
npm run dev      # watch 模式
```

加载扩展：Chrome → `chrome://extensions` → 开发者模式 → Load unpacked → 选择 `dist` 目录
