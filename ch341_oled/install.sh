#!/bin/bash
#
# CH341 OLED plugin - install
# Copyright (c) 2026 foonerd
#
# Installs two prebuilt binaries, a udev rule, a sudoers drop-in and a
# systemd unit.
#
# There is deliberately no apt here. The payload links only against
# libraries present on a stock Volumio image, so the plugin installs with
# no network access and no package version drift:
#
#   mpd_oled        libmpdclient2 (via mpc), libusb-1.0-0 (via usbutils),
#                   libudev, libm, libgcc_s, libpthread, libc
#   mpd_oled_cava   libasound2 (explicit in VolumioBase.conf), libm, libc
#
# libiniparser and libfftw3 are statically linked into mpd_oled_cava.
# Neither is on a stock image - both were mistakenly assumed present
# from a development machine that had them installed as build
# dependencies. A field test on a fresh Wyse 3040 caught libfftw3:
#
#   mpd_oled_cava: error while loading shared libraries: libfftw3.so.3
#
# The authority on what a stock image contains is
# volumio-os/recipes/base/VolumioBase.conf, not a machine that has been
# built on.
#
# No system configuration file is modified, so a system update leaves all
# of this alone.

set -e

PLUGIN_DIR=/data/plugins/system_hardware/ch341_oled

echo "Installing CH341 OLED plugin"

########################################################################
# Payload
########################################################################
echo "Installing mpd_oled and cava"

if [ ! -f "$PLUGIN_DIR/bin/mpd_oled" ] || [ ! -f "$PLUGIN_DIR/bin/mpd_oled_cava" ]; then
  echo "ERROR: the binary payload is missing from $PLUGIN_DIR/bin"
  echo "plugininstallend"
  exit 1
fi

sudo install -m 755 "$PLUGIN_DIR/bin/mpd_oled" /usr/local/bin/mpd_oled
sudo install -m 755 "$PLUGIN_DIR/bin/mpd_oled_cava" /usr/local/bin/mpd_oled_cava

########################################################################
# Device permissions
#
# The transport talks to the raw USB device, so the i2c group plays no
# part. volumio is already in audio, so the rule grants that group
# access. Rules apply as devices appear, hence the trigger for an
# adapter that is already plugged in.
########################################################################
echo "Installing udev rule for the CH341A"
sudo tee /etc/udev/rules.d/60-ch341-i2c.rules >/dev/null <<'EOF'
# CH341A in I2C/SPI/GPIO mode - userspace access for the ch341_oled plugin
SUBSYSTEM=="usb", ATTR{idVendor}=="1a86", ATTR{idProduct}=="5512", MODE="0660", GROUP="audio", TAG+="uaccess"
EOF
sudo udevadm control --reload-rules
sudo udevadm trigger --subsystem-match=usb --attr-match=idVendor=1a86 || true

########################################################################
# Privileged commands
#
# index.js runs as volumio and needs to control the service. The drop-in
# is named volumio-<plugin> so it is identifiable and so uninstall can
# remove it without touching anything else. Scoped to this unit only.
########################################################################
echo "Installing sudoers drop-in"
sudo tee /etc/sudoers.d/volumio-ch341_oled >/dev/null <<'EOF'
volumio ALL=(ALL) NOPASSWD: /bin/systemctl start ch341_oled.service, /bin/systemctl stop ch341_oled.service, /bin/systemctl restart ch341_oled.service, /bin/systemctl enable ch341_oled.service, /bin/systemctl disable ch341_oled.service, /bin/systemctl is-active ch341_oled.service, /bin/systemctl reset-failed ch341_oled.service
EOF
sudo chmod 0440 /etc/sudoers.d/volumio-ch341_oled
sudo visudo -c -f /etc/sudoers.d/volumio-ch341_oled

########################################################################
# FIFO for the spectrum tap
#
# asound.conf names /tmp/ch341_oled_fifo whenever the plugin is enabled.
# /tmp is tmpfs, so the pipe must be created before sound.target and
# before Volumio rebuilds ALSA. tmpfiles.d does that at boot; the plugin
# also creates it in onVolumioStart as a backstop.
########################################################################
echo "Installing tmpfiles drop-in for the spectrum FIFO"
sudo tee /etc/tmpfiles.d/ch341_oled.conf >/dev/null <<'EOF'
# CH341 OLED spectrum tap - must exist before ALSA opens pcm.volumio
p /tmp/ch341_oled_fifo 0666 volumio audio -
EOF
sudo systemd-tmpfiles --create /etc/tmpfiles.d/ch341_oled.conf || true

########################################################################
# Remove any out-of-tree CH341 kernel module
#
# Two drivers contending for one adapter has been observed to deadlock
# the kernel side hard enough to require a power cycle. If the user
# previously followed the kernel module instructions, take it out of the
# way.
########################################################################
if lsmod | grep -q i2c_ch341_usb; then
  echo "Removing the loaded i2c-ch341-usb kernel module"
  sudo rmmod i2c-ch341-usb || true
fi
if [ -e "/lib/modules/$(uname -r)/kernel/drivers/i2c/busses/i2c-ch341-usb.ko" ]; then
  echo "Removing the installed i2c-ch341-usb kernel module"
  sudo rm -f "/lib/modules/$(uname -r)/kernel/drivers/i2c/busses/i2c-ch341-usb.ko"
  sudo depmod -a
fi

########################################################################
# Service
#
# ExecStart runs a script generated by the plugin from its settings, so
# changing a setting needs no root-owned file rewritten.
########################################################################
echo "Installing the ch341_oled service"

# Placeholder, so the unit has something valid to run before the plugin
# first generates the real script on start.
if [ ! -e "$PLUGIN_DIR/start.sh" ]; then
  printf '#!/bin/bash\nexit 0\n' > "$PLUGIN_DIR/start.sh"
fi
chmod 755 "$PLUGIN_DIR/start.sh"

# install.sh is executed as root, so everything created above is
# root-owned. index.js runs as volumio and rewrites start.sh on every
# settings change, so the plugin directory has to be handed over or each
# save fails with EACCES.
sudo chown -R volumio:volumio "$PLUGIN_DIR"

sudo tee /etc/systemd/system/ch341_oled.service >/dev/null <<EOF
[Unit]
Description=CH341 OLED display
After=network.target sound.target systemd-tmpfiles-setup.service
StartLimitIntervalSec=60
StartLimitBurst=5

[Service]
Type=simple
User=volumio
Group=audio
ExecStartPre=/bin/sh -c 'test -p /tmp/ch341_oled_fifo || /usr/bin/mkfifo -m 666 /tmp/ch341_oled_fifo; chmod 666 /tmp/ch341_oled_fifo'
ExecStart=$PLUGIN_DIR/start.sh
Restart=on-failure
RestartSec=5
TimeoutStopSec=2
# mpd_oled's SIGTERM handler calls clearDisplay() (USB I/O) while the
# render loop may have a bulk transfer in flight. That floods
# LIBUSB_ERROR_BUSY and can leave the adapter claimed. SIGKILL lets the
# kernel release the interface; the new instance then claims it.
KillSignal=SIGKILL

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
# Left disabled until the plugin is enabled. onStart enables the unit so
# a reboot starts the display; onStop disables it so a disabled plugin
# stays off.
sudo systemctl disable ch341_oled.service || true

echo "plugininstallend"
