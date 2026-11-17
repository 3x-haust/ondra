"""Ondra's built-in pet ("온디"): its GIFs in src/pet/default/, drawn by the pet-maker skill's pixel example.

usage: python3 scripts/make-pet.py   (needs Pillow)
"""
import runpy
import sys
from pathlib import Path

root = Path(__file__).resolve().parent.parent
sys.argv = ["pixel-pet-example.py", str(root / "src" / "pet" / "default")]
runpy.run_path(str(root / "skills" / "pet-maker" / "scripts" / "pixel-pet-example.py"), run_name="__main__")
