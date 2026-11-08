"""从 Electron app.asar 读单个文件（只读，排查/取证用）。

用法：
    python scripts/asar_read.py <内部路径> [输出文件]
asar 路径默认取本机 DeepSeek Harness 的 resources/app.asar。
"""
import json
import os
import struct
import sys

DEFAULT_ASAR = os.path.join(
    os.environ.get("LOCALAPPDATA", os.path.expanduser("~")),
    "Programs", "DeepSeek Harness", "resources", "app.asar")


def read_entry(asar, target):
    with open(asar, "rb") as fh:
        raw = fh.read(16)
        payload_size = struct.unpack("<I", raw[4:8])[0]
        json_len = struct.unpack("<I", raw[8:12])[0]
        header = fh.read(json_len).decode("utf-8")
        index, _ = json.JSONDecoder().raw_decode(header)
        data_start = 8 + payload_size

        node = index
        for part in target.split("/"):
            node = (node.get("files") or {})[part]
        fh.seek(data_start + int(node["offset"]))
        return fh.read(int(node["size"]))


def main(argv):
    asar = os.environ.get("DSH_ASAR") or DEFAULT_ASAR
    target = argv[0]
    out = argv[1] if len(argv) > 1 else ""

    blob = read_entry(asar, target)
    if out:
        with open(out, "wb") as fh:
            fh.write(blob)
        print(f"wrote {len(blob)} bytes -> {out}", file=sys.stderr)
    else:
        sys.stdout.buffer.write(blob)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
