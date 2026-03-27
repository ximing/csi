#!/usr/bin/env bash
# CSI 扩展上架打包：构建 extension/dist/ 并打成 release/csi-extension-v<version>.zip
# 供 Chrome Web Store 上传使用（manifest.json 在 zip 根）。
# 用法：scripts/package-extension.sh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXT_DIR="$ROOT_DIR/extension"
DIST_DIR="$EXT_DIR/dist"
RELEASE_DIR="$ROOT_DIR/release"

echo "==> 构建扩展（npm run build）"
cd "$EXT_DIR"
npm run build

MANIFEST="$DIST_DIR/manifest.json"
if [[ ! -f "$MANIFEST" ]]; then
  echo "错误：构建产物缺少 $MANIFEST" >&2
  exit 1
fi

VERSION="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).version)' "$MANIFEST")"
if [[ -z "$VERSION" ]]; then
  echo "错误：无法从 manifest.json 读取版本号" >&2
  exit 1
fi

ZIP_NAME="csi-extension-v${VERSION}.zip"
ZIP_PATH="$RELEASE_DIR/$ZIP_NAME"
mkdir -p "$RELEASE_DIR"

echo "==> 打包 v${VERSION} → release/${ZIP_NAME}"
rm -f "$ZIP_PATH"
# manifest.json 必须在 zip 根；排除 .DS_Store
(cd "$DIST_DIR" && zip -qr "$ZIP_PATH" . -x "*.DS_Store")

# 自检：zip 根必须有 manifest.json
if ! unzip -l "$ZIP_PATH" | awk '{print $4}' | grep -qx "manifest.json"; then
  echo "错误：zip 根缺少 manifest.json" >&2
  exit 1
fi

echo "==> 完成：$ZIP_PATH"
