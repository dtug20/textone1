"""Test package bootstrap adding services/realtime modules to sys.path."""
import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[2]
for _sub in ('gateway', 'speech', 'media', 'tts'):
    _path = str(_ROOT / 'services' / 'realtime' / _sub)
    if _path not in sys.path:
        sys.path.insert(0, _path)
