# ComfyUI Manager 插件提交指南

本文档介绍如何将自定义插件提交到 ComfyUI Manager 的 node 列表。

---

## 前置条件

1. 插件代码已推送到 GitHub 仓库
2. 仓库为 **Public**（公开）
3. 包含完整的 `pyproject.toml` 文件
4. 包含 `README.md` 说明文档
5. 包含开源许可证（如 MIT）

---

## 提交方式

现在 ComfyUI Manager 使用 **JSON 文件方式** 提交，不再使用 `.dev` 文件。

---

## 步骤详解

### 第一步：Fork 官方仓库

1. 访问 ComfyUI Manager 仓库：
   ```
   https://github.com/ltdrdata/ComfyUI-Manager
   ```

2. 点击右上角的 **Fork** 按钮，将仓库复制到你的 GitHub 账号下

---

### 第二步：编辑 custom-node-list.json

1. 在你的 Fork 仓库中，找到 `custom-node-list.json` 文件

2. 编辑该文件，在 `"custom_nodes"` 数组中添加你的插件条目

3. 条目格式如下：

   ```json
   {
     "author": "allanmeng",
     "title": "ComfyUI-XPUSYS-Monitor",
     "reference": "https://github.com/allanmeng/ComfyUI-XPUSYS-Monitor",
     "files": [
       "https://github.com/allanmeng/ComfyUI-XPUSYS-Monitor"
     ],
     "install_type": "git-clone",
     "description": "Intel Arc-first ComfyUI monitor with real-time GPU/CPU/RAM stats and workflow execution success rate predictor. NVIDIA (CUDA) fully supported."
   }
   ```

   **字段说明**：

   | 字段 | 说明 | 必填 |
   |------|------|------|
   | `author` | 作者 GitHub 用户名 | ✅ |
   | `title` | 插件显示名称 | ✅ |
   | `reference` | GitHub 仓库完整 URL | ✅ |
   | `files` | 插件文件下载地址数组 | ✅ |
   | `install_type` | 安装方式（`git-clone` 或 `copy`） | ✅ |
   | `description` | 插件功能描述 | ✅ |
   | `id` | 唯一标识符（可选） | 可选 |
   | `pip` | Python 依赖包数组（可选） | 可选 |

---

### 第三步：提交 Pull Request

1. 将你的修改提交到你的 Fork 仓库

2. 点击 **Contribute** → **Open pull request**

3. 填写 PR 标题和描述：

   **标题示例**：
   ```
   Add ComfyUI-XPUSYS-Monitor to custom node list
   ```

   **描述模板**：
   ```markdown
   ## 插件信息
   
   - **名称**: ComfyUI-XPUSYS-Monitor
   - **作者**: allanmeng
   - **功能**: Intel Arc GPU 实时监控 + 工作流执行成功率预测
   - **仓库**: https://github.com/allanmeng/ComfyUI-XPUSYS-Monitor
   
   ## 特性
   
   - 实时 GPU/CPU/RAM 监控
   - Intel Arc 优先支持，同时兼容 NVIDIA CUDA
   - 工作流显存占用预测
   - 执行成功率预估
   
   ## 测试状态
   
   - [x] 已在本地 ComfyUI 测试通过
   - [x] 依赖包已列入 `pyproject.toml`
   - [x] README 包含安装和使用说明
   ```

4. 提交 PR，等待审核

---

## 审核流程

### 审核时间
- 通常 **1-2 周**
- 取决于审核员工作量和插件复杂度

### 可能的结果

| 结果 | 说明 |
|------|------|
| **直接合并** | 插件符合规范，直接通过 |
| **要求修改** | 审核员会评论指出问题，修改后重新提交 |
| **拒绝** | 不符合基本要求（较少见） |

### 常见修改要求

- 补充 `README.md` 使用说明
- 调整 `description` 长度
- 修正 `pyproject.toml` 格式
- 添加更多标签便于搜索

---

## 过审后

1. 插件会出现在 ComfyUI Manager 的节点列表中
2. 用户可以通过 Manager 直接搜索安装
3. 后续版本更新只需在 JSON 文件中更新版本信息

---

## 版本更新流程

当插件有新版本时：

1. 更新你的插件仓库代码
2. 更新 `pyproject.toml` 中的 `version`
3. 在 Fork 的 Manager 仓库中修改 JSON 条目
4. 提交新的 PR 更新

---

## 参考链接

- [ComfyUI Manager 官方仓库](https://github.com/ltdrdata/ComfyUI-Manager)
- [custom-node-list.json 文件](https://github.com/ltdrdata/ComfyUI-Manager/blob/main/custom-node-list.json)
- [ComfyUI 插件开发文档](https://docs.comfy.org/)

---

## 注意事项

1. **保持耐心**：审核是人工进行，可能需要时间
2. **及时响应**：如果审核员提出修改意见，尽快响应
3. **保持更新**：过审后也要维护插件，及时修复 bug
4. **遵守规范**：遵循 ComfyUI 社区的插件开发规范

---

*文档版本: 2024-03-18*
