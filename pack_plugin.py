"""
ComfyUI-XPUSYS-Monitor 打包脚本
================================
白名单模式：只打包明确列出的文件和目录。
如果生产环境新增了需要发布的文件/目录，请在下方 WHITELIST 中添加。

输出：F:/ComfyUI-XPUSYS-Monitor-v{VERSION}.zip
      压缩包内含 ComfyUI-XPUSYS-Monitor/ 主文件夹，
      用户解压后直接放入 ComfyUI/custom_nodes/ 即可。
"""

import zipfile
import os
import re

# ── 读取版本号（从 pyproject.toml 自动获取）──────────────────────────────────
def get_version():
    toml_path = os.path.join(os.path.dirname(__file__), "pyproject.toml")
    with open(toml_path, encoding="utf-8") as f:
        for line in f:
            m = re.match(r'\s*version\s*=\s*"(.+?)"', line)
            if m:
                return m.group(1)
    return "unknown"

# ── 白名单：只打包以下文件和目录 ─────────────────────────────────────────────
# 格式：
#   - 文件：直接写文件名，如 "__init__.py"
#   - 目录：写目录名，如 "providers"（会递归打包目录内所有内容）
# ⚠️  如果生产环境新增了需要发布的文件/目录，在此添加！
WHITELIST = [
    "__init__.py",
    "xpu_server.py",
    "pyproject.toml",
    "requirements.txt",
    "providers",   # providers/ 目录（含 __init__.py、base.py、intel.py、nvidia.py、amd.py）
    "web",         # web/ 目录（含 xpu_monitor.js）
]

# ── 打包逻辑 ──────────────────────────────────────────────────────────────────
def pack():
    src_dir = os.path.dirname(os.path.abspath(__file__))
    version = get_version()
    output = f"F:/ComfyUI-XPUSYS-Monitor-v{version}.zip"
    prefix = "ComfyUI-XPUSYS-Monitor"  # 压缩包内主文件夹名

    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as zf:
        for item in WHITELIST:
            full = os.path.join(src_dir, item)
            if os.path.isfile(full):
                arcname = f"{prefix}/{item}"
                zf.write(full, arcname)
                print(f"  + {arcname}")
            elif os.path.isdir(full):
                for root, dirs, files in os.walk(full):
                    # 排除 __pycache__
                    dirs[:] = [d for d in dirs if d != "__pycache__"]
                    for file in files:
                        if file.endswith(".pyc"):
                            continue
                        file_path = os.path.join(root, file)
                        rel = os.path.relpath(file_path, src_dir)
                        arcname = f"{prefix}/{rel.replace(os.sep, '/')}"
                        zf.write(file_path, arcname)
                        print(f"  + {arcname}")
            else:
                print(f"  ⚠ 白名单项不存在，跳过：{item}")

    print(f"\n✅ 打包完成：{output}")
    print(f"   包含文件：{len(zf.namelist())} 个")

if __name__ == "__main__":
    pack()
