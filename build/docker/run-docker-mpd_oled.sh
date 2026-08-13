#!/bin/bash
# ch341-i2c-usb build/docker/run-docker-mpd_oled.sh
# Builds the ch341_oled plugin payload in a container.
#
# Copyright (c) 2026 foonerd
#
# Usage: ./build/docker/run-docker-mpd_oled.sh [arch] [--verbose]
#
# Only amd64 is supported. The CH341 route exists because x86 hosts have
# no I2C bus; ARM boards have GPIO I2C and the upstream mpd_oled plugin.
# The arch argument and the maps below are kept so another target is a
# table entry rather than a rewrite.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="$(dirname "$SCRIPT_DIR")"

cd "$BUILD_DIR"

ARCH="${1:-amd64}"
shift || true

VERBOSE=0
for arg in "$@"; do
  if [[ "$arg" == "--verbose" ]]; then
    VERBOSE=1
  fi
done

declare -A PLATFORM_MAP
PLATFORM_MAP=(
  ["amd64"]="linux/amd64"
)

declare -A LIB_PATH_MAP
LIB_PATH_MAP=(
  ["amd64"]="/usr/lib/x86_64-linux-gnu"
)

if [[ -z "${PLATFORM_MAP[$ARCH]}" ]]; then
  echo "Error: unsupported architecture: $ARCH"
  echo "Supported: ${!PLATFORM_MAP[*]}"
  exit 1
fi

PLATFORM="${PLATFORM_MAP[$ARCH]}"
LIB_PATH="${LIB_PATH_MAP[$ARCH]}"
DOCKERFILE="docker/Dockerfile.mpd_oled.$ARCH"
IMAGE_NAME="ch341-oled-builder:$ARCH"
OUTPUT_DIR="out/$ARCH"

if [ ! -f "$DOCKERFILE" ]; then
  echo "Error: Dockerfile not found: $DOCKERFILE"
  exit 1
fi

echo "========================================"
echo "Building ch341_oled payload for $ARCH"
echo "========================================"
echo "  Platform:   $PLATFORM"
echo "  Lib path:   $LIB_PATH"
echo "  Dockerfile: $DOCKERFILE"
echo "  Image:      $IMAGE_NAME"
echo "  Output:     $BUILD_DIR/$OUTPUT_DIR"
echo ""

echo "[+] Building Docker image..."
if [[ "$VERBOSE" -eq 1 ]]; then
  DOCKER_BUILDKIT=1 docker build --platform="$PLATFORM" --progress=plain \
    -t "$IMAGE_NAME" -f "$DOCKERFILE" .
else
  docker build --platform="$PLATFORM" --progress=auto \
    -t "$IMAGE_NAME" -f "$DOCKERFILE" . > /dev/null 2>&1
fi
echo "[+] Docker image built: $IMAGE_NAME"
echo ""

mkdir -p "$OUTPUT_DIR"

# Source refs. Override in the environment to build a different branch,
# for example to test a change before pushing it to the default one.
LIBU8G2_REPO="${LIBU8G2_REPO:-https://github.com/foonerd/libu8g2arm.git}"
LIBU8G2_REF="${LIBU8G2_REF:-feat/ch341-usb-transport}"
MPD_OLED_REPO="${MPD_OLED_REPO:-https://github.com/foonerd/mpd_oled_dev.git}"
MPD_OLED_REF="${MPD_OLED_REF:-feat/volumio-x86}"
CAVA_REPO="${CAVA_REPO:-https://github.com/karlstav/cava.git}"
CAVA_REF="${CAVA_REF:-master}"

echo "[+] Sources:"
echo "      libu8g2arm  $LIBU8G2_REPO  ($LIBU8G2_REF)"
echo "      mpd_oled    $MPD_OLED_REPO  ($MPD_OLED_REF)"
echo "      cava        $CAVA_REPO  ($CAVA_REF)"
echo ""

echo "[+] Running build inside container..."
docker run --rm --platform="$PLATFORM" \
  -v "$(pwd)/scripts:/build/scripts:ro" \
  -v "$(pwd)/$OUTPUT_DIR:/build/output" \
  -e "ARCH=$ARCH" \
  -e "LIB_PATH=$LIB_PATH" \
  -e "LIBU8G2_REPO=$LIBU8G2_REPO" \
  -e "LIBU8G2_REF=$LIBU8G2_REF" \
  -e "MPD_OLED_REPO=$MPD_OLED_REPO" \
  -e "MPD_OLED_REF=$MPD_OLED_REF" \
  -e "CAVA_REPO=$CAVA_REPO" \
  -e "CAVA_REF=$CAVA_REF" \
  "$IMAGE_NAME" \
  bash /build/scripts/build-mpd_oled.sh

echo ""
echo "[+] Build complete for $ARCH"
echo "[+] Output in: $BUILD_DIR/$OUTPUT_DIR"
ls -lh "$OUTPUT_DIR"
echo ""
echo "To update the plugin payload:"
echo "  cp $BUILD_DIR/$OUTPUT_DIR/* $(dirname "$BUILD_DIR")/ch341_oled/bin/"
