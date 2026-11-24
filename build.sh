#!/bin/bash
set -e

NODE_VERSION="v20.18.0"
HOST_ARCH=$(uname -m)

echo "==> [1/4] 准备 ARM64 独立 Node.js 运行时..."
if [ ! -f "app/runtime/node" ]; then
    TMP_DIR=$(mktemp -d)
    curl -fSL "https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-linux-arm64.tar.xz" -o "$TMP_DIR/node.tar.xz"
    tar -xJf "$TMP_DIR/node.tar.xz" -C "$TMP_DIR"
    cp "$TMP_DIR/node-${NODE_VERSION}-linux-arm64/bin/node" "app/runtime/node"
    chmod +x "app/runtime/node"
    rm -rf "$TMP_DIR"
    echo "已下载 ARM64 Node.js 运行时: app/runtime/node"
fi

echo "==> [2/4] 安装服务端生产依赖 (Scramjet / Wisp)..."
if command -v npm >/dev/null 2>&1; then
    (cd app/server && npm install --omit=dev)
else
    echo "⚠️ 当前环境未安装 npm，将仅使用内置零依赖轻量直连内核打包（已可正常访问内网设备与常规网页）。"
fi

echo "==> [3/4] 检查或自动下载官方 fnpack 工具..."
FNPACK_BIN="$(command -v fnpack || true)"
if [ -z "$FNPACK_BIN" ]; then
    if [ "$HOST_ARCH" = "aarch64" ] || [ "$HOST_ARCH" = "arm64" ]; then
        FNPACK_ARCH="arm64"
    else
        FNPACK_ARCH="amd64"
    fi
    FNPACK_BIN="/tmp/fnpack-cli"
    if [ ! -x "$FNPACK_BIN" ]; then
        if ! curl -fSL "https://static2.fnnas.com/fnpack/fnpack-1.2.3-linux-${FNPACK_ARCH}" -o "$FNPACK_BIN"; then
            curl -fSL "https://static2.fnnas.com/fnpack/fnpack-1.2.1-linux-${FNPACK_ARCH}" -o "$FNPACK_BIN"
        fi
        chmod +x "$FNPACK_BIN"
    fi
fi

echo "==> [4/4] 在隔离目录中打包 fn-browser-arm64.fpk..."
STAGE_DIR=$(mktemp -d)
mkdir -p dist
cp -a manifest ICON.PNG ICON_256.PNG cmd config app "$STAGE_DIR/"
chmod +x "$STAGE_DIR/cmd/main" "$STAGE_DIR/cmd/install_init" "$STAGE_DIR/app/runtime/node"

(cd "$STAGE_DIR" && "$FNPACK_BIN" build)
FPK_OUT=$(ls -1 "$STAGE_DIR"/*.fpk | head -n 1)
cp "$FPK_OUT" "dist/fn-browser-arm64.fpk"
rm -rf "$STAGE_DIR"

echo "✅ 编译打包完成！产物路径: dist/fn-browser-arm64.fpk"
echo "👉 请在飞牛应用中心右上角点击【手动安装】上传该 .fpk 文件即可。"
