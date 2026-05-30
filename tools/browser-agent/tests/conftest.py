import sys
from pathlib import Path

# 让测试能 import browser_agent（venv 安装前也可跑纯单测）
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
