#!/bin/bash
# ch341-i2c-usb build/scripts/build-mpd_oled.sh
# Builds the ch341_oled plugin payload. Runs inside the Docker container.
#
# Copyright (c) 2026 foonerd
#
# Produces two binaries:
#
#   mpd_oled        the display program, linked against libu8g2arm with
#                   the CH341 USB transport
#   mpd_oled_cava   spectrum calculation, with iniparser and fftw3
#                   statically linked
#
# Both must depend only on libraries present on a stock Volumio image.
# The verification step at the end fails the build if they do not, so a
# missing dependency is caught here rather than by a user.

set -e

echo "[+] Starting ch341_oled payload build"
echo "[+] Architecture: ${ARCH}"
echo "[+] Library path: ${LIB_PATH}"
echo ""

BUILD_BASE="/build"
OUTPUT_DIR="$BUILD_BASE/output"

LIBU8G2_REPO="${LIBU8G2_REPO:-https://github.com/foonerd/libu8g2arm.git}"
LIBU8G2_REF="${LIBU8G2_REF:-feat/ch341-usb-transport}"
MPD_OLED_REPO="${MPD_OLED_REPO:-https://github.com/foonerd/mpd_oled_dev.git}"
MPD_OLED_REF="${MPD_OLED_REF:-feat/volumio-x86}"
CAVA_REPO="${CAVA_REPO:-https://github.com/karlstav/cava.git}"
CAVA_REF="${CAVA_REF:-master}"

mkdir -p "$OUTPUT_DIR"

#
# Locate the static archives.
#
# Passing an archive to configure by full path in LIBS= is deliberate.
# Libtool reorders -Wl,-Bstatic flags and they are silently ignored, but
# a path is just another input file to the linker and survives. Patching
# generated Makefiles with sed would also work and is what some builds
# do, but it breaks whenever upstream changes its build system.
#
echo "[+] Locating static archives"
FFTW3_STATIC=$(find /usr -name 'libfftw3.a' 2>/dev/null | head -1)
INIPARSER_STATIC=$(find /usr -name 'libiniparser.a' 2>/dev/null | head -1)

if [ -z "$FFTW3_STATIC" ]; then
  echo "[!] ERROR: libfftw3.a not found"
  exit 1
fi
if [ -z "$INIPARSER_STATIC" ]; then
  echo "[!] ERROR: libiniparser.a not found"
  exit 1
fi
echo "[+]   fftw3:     $FFTW3_STATIC"
echo "[+]   iniparser: $INIPARSER_STATIC"
echo ""

#
# Step 1: libu8g2arm with the CH341 USB transport
#
# Not installed. mpd_oled links the build tree in place via LIBU8G2_DIR.
#
echo "[+] Building libu8g2arm ($LIBU8G2_REF)"
cd "$BUILD_BASE"
if [ ! -d libu8g2arm ]; then
  git clone --depth 1 --branch "$LIBU8G2_REF" "$LIBU8G2_REPO" libu8g2arm
fi
cd libu8g2arm
./bootstrap
mkdir -p build
cd build
CPPFLAGS="-W -Wall -Wno-psabi" ../configure --prefix=/usr/local
make -j"$(nproc)"
echo "[+] libu8g2arm built"
echo ""

#
# Step 2: cava
#
# Input backends other than fifo are disabled: mpd_oled feeds cava from a
# FIFO written by the ALSA chain, so portaudio, sndio, pulse and the
# ncurses output are dead weight.
#
echo "[+] Building cava ($CAVA_REF)"
cd "$BUILD_BASE"
if [ ! -d cava ]; then
  git clone --depth 1 --branch "$CAVA_REF" "$CAVA_REPO" cava
fi
cd cava
./autogen.sh
./configure \
  --disable-input-portaudio \
  --disable-input-sndio \
  --disable-output-ncurses \
  --disable-input-pulse \
  --program-prefix=mpd_oled_ \
  LIBS="$INIPARSER_STATIC $FFTW3_STATIC"
make -j"$(nproc)"
strip cava
echo "[+] cava built"
echo ""

#
# Step 3: mpd_oled
#
# LIBS names libusb explicitly because mpd_oled links libu8g2arm.a, and
# a static archive carries no dependency information - the consumer has
# to name the transport's own dependencies on the link line.
#
echo "[+] Building mpd_oled ($MPD_OLED_REF)"
cd "$BUILD_BASE"
if [ ! -d mpd_oled_dev ]; then
  git clone --depth 1 --branch "$MPD_OLED_REF" "$MPD_OLED_REPO" mpd_oled_dev
fi
cd mpd_oled_dev
./bootstrap
LIBU8G2_DIR=../libu8g2arm \
CPPFLAGS="-W -Wall -Wno-psabi" \
LIBS="$(pkg-config --libs libusb-1.0)" \
./configure --prefix=/usr/local
make -j"$(nproc)"
strip src/mpd_oled
echo "[+] mpd_oled built"
echo ""

#
# Step 4: collect
#
echo "[+] Collecting payload"
cp -v "$BUILD_BASE/mpd_oled_dev/src/mpd_oled" "$OUTPUT_DIR/mpd_oled"
cp -v "$BUILD_BASE/cava/cava" "$OUTPUT_DIR/mpd_oled_cava"
chmod 755 "$OUTPUT_DIR/mpd_oled" "$OUTPUT_DIR/mpd_oled_cava"
echo ""

#
# Step 5: verify
#
# A missing runtime library is invisible on the build host, which has the
# -dev packages installed, and only shows up on a clean target. That is
# how a libfftw3 dependency reached a field tester once already. These
# checks make the build fail instead.
#
echo "[+] Verifying dependencies"
echo ""
echo "[+] mpd_oled:"
ldd "$OUTPUT_DIR/mpd_oled"
echo ""
echo "[+] mpd_oled_cava:"
ldd "$OUTPUT_DIR/mpd_oled_cava"
echo ""

# Not on a stock Volumio image - see recipes/base/VolumioBase.conf in
# volumio-os. Anything here means a user gets "error while loading shared
# libraries" on first run.
NOT_ON_TARGET="libfftw3 libiniparser"

FAILED=0
for BIN in "$OUTPUT_DIR/mpd_oled" "$OUTPUT_DIR/mpd_oled_cava"; do
  for LIB in $NOT_ON_TARGET; do
    if ldd "$BIN" 2>/dev/null | grep -q "$LIB"; then
      echo "[!] ERROR: $(basename "$BIN") links $LIB dynamically."
      echo "[!]        That library is not on a stock Volumio image."
      FAILED=1
    fi
  done
done

if [ "$FAILED" -ne 0 ]; then
  exit 1
fi

echo "[+] OK: no dependencies outside a stock Volumio image"
echo ""
echo "[+] Build complete"
ls -lh "$OUTPUT_DIR"
