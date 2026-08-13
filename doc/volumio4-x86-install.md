# Driving an I2C OLED on Volumio 4 x86 without a kernel module

Build instructions for `mpd_oled` on Volumio 4 (x86_64, Bookworm, kernel
6.12.x) using a CH341A USB adapter and a userspace transport.

> **There is an easier way.** The [ch341_oled plugin](../ch341_oled/)
> installs prebuilt binaries in one step, needs no toolchain on the
> device, and is the only route that gets the spectrum analyser working.
> This document is for building from source by hand, or for
> understanding how the parts fit together.
>
> If you want to build the binaries yourself but not on the device, the
> [containerised build](../build/) does all three components in one run.

The result survives OTA updates. There is no kernel module, no kernel
headers, no vermagic to match, no module to blacklist, and no
`/dev/i2c-N` bus number that shifts between reboots.

Tested on a GOLE2 (Intel Jasper Lake) running Volumio 4.143 with a
generic 0.96 inch 128x64 SSD1306 panel.

## Why not the kernel module

The usual route uses one of the out-of-tree CH341 kernel drivers. They
work, but:

- The module must be rebuilt for every kernel. After an OTA that changes
  the kernel it silently stops loading and the display goes dark with no
  obvious cause.
- Building it needs kernel headers, and installing those breaks
  Volumio's system integrity check on the next update.
- The version in circulation reports phantom devices at every address
  when scanned, so `i2cdetect` cannot be used to diagnose anything.
- Loading it while another process holds the adapter has been observed
  to deadlock the kernel side badly enough to require a power cycle.

This route avoids all of that by talking to the adapter from userspace.

## Hardware

**Adapter.** A CH341A USB module, the common breakout with a mode jumper
next to the USB connector. Set it to I2C/SPI, not UART. In I2C mode the
red LED lights and `lsusb` reports `1a86:5512`. In UART mode it reports
`1a86:5523` and will not be found.

```
lsusb | grep 1a86
```

**Voltage.** A second pair of jumpers selects 3.3V or 5V on the VCC
output. Both move together. Most 0.96 inch SSD1306 breakouts want 3.3V.
Check the marking on your panel; 5V into a 3.3V-only module will damage
it.

**Wiring.** Four wires, label to label:

```
Display GND  ->  Adapter GND
Display VCC  ->  Adapter VCC
Display SDA  ->  Adapter SDA
Display SCL  ->  Adapter SCL
```

## Remove any existing CH341 kernel module

If you previously followed the kernel module instructions, remove the
module so it cannot autoload and contend for the adapter:

```
sudo rmmod i2c-ch341-usb 2>/dev/null
sudo rm -f /lib/modules/$(uname -r)/kernel/drivers/i2c/busses/i2c-ch341-usb.ko
sudo depmod -a
```

Two drivers on one adapter is the deadlock case. Do not skip this.

## Prerequisites

```
sudo apt-get update
sudo apt-get install -y build-essential autoconf automake libtool \
  autoconf-archive pkg-config libusb-1.0-0-dev libfftw3-dev \
  libiniparser-dev libmpdclient-dev libasound2-dev
```

This installs a compiler toolchain. That is inherent to building on the
device and is not itself an OTA problem, but it is a change to the
appliance and worth being aware of.

## Build

All three trees must sit in the same parent directory, because
`mpd_oled` references `../libu8g2arm`.

### cava

Provides the spectrum calculation. Skip if `mpd_oled_cava` is already
installed.

```
cd /home/volumio
git clone https://github.com/karlstav/cava
cd cava
./autogen.sh
./configure --disable-input-portaudio --disable-input-sndio \
            --disable-output-ncurses --disable-input-pulse \
            --program-prefix=mpd_oled_ \
            LIBS="/usr/lib/x86_64-linux-gnu/libiniparser.a /usr/lib/x86_64-linux-gnu/libfftw3.a"
make -j$(nproc)
sudo make install-strip
cd ..
```

The `LIBS=` statically links iniparser and fftw. Neither is on a stock
Volumio image, and the `-dev` packages installed above bring in their
shared libraries, so without this the binary builds and runs on the
machine you built it on and fails elsewhere with:

```
mpd_oled_cava: error while loading shared libraries: libfftw3.so.3
```

If you are only ever running it on the machine you built it on, you can
leave `LIBS=` out.

Confirm afterwards that only stock libraries remain:

```
ldd /usr/local/bin/mpd_oled_cava
```

Expect `libasound.so.2`, `libm`, `libc` and nothing else.

### libu8g2arm with the CH341 transport

```
git clone -b feat/ch341-usb-transport https://github.com/foonerd/libu8g2arm.git
cd libu8g2arm
./bootstrap
mkdir build && cd build
CPPFLAGS="-W -Wall -Wno-psabi" ../configure --prefix=/usr/local
make -j$(nproc)
cd ../..
```

Not installed system-wide. `mpd_oled` links the build tree directly.

### mpd_oled

```
git clone -b feat/volumio-x86 https://github.com/foonerd/mpd_oled_dev.git
cd mpd_oled_dev
./bootstrap
LIBU8G2_DIR=../libu8g2arm \
CPPFLAGS="-W -Wall -Wno-psabi" \
LIBS="$(pkg-config --libs libusb-1.0)" \
./configure --prefix=/usr/local
make -j$(nproc)
sudo make install-strip
cd ..
```

This is a fork of antiprism's development branch carrying the x86 work:
the `-L` layout option originally from Wheaten's fork, a `-u` option for
the player status polling interval, and a fix so the Volumio path no
longer requires an MPD connection - relevant when the active source is
AirPlay, Spotify Connect or Tidal Connect rather than MPD.

The `LIBS=` is required and easy to miss. `mpd_oled` links
`libu8g2arm.a`, and a static archive carries no dependency information,
so libusb must be named on the link line by the consumer. Without it the
link fails with a page of `undefined reference to libusb_*`.

## Device permissions

By default the adapter is root-only. This rule grants access to the
`audio` group, which the `volumio` user is already in:

```
sudo tee /etc/udev/rules.d/60-ch341-i2c.rules >/dev/null <<'EOF'
# CH341A in I2C/SPI/GPIO mode - userspace access for mpd_oled
SUBSYSTEM=="usb", ATTR{idVendor}=="1a86", ATTR{idProduct}=="5512", MODE="0660", GROUP="audio", TAG+="uaccess"
EOF
sudo udevadm control --reload-rules
sudo udevadm trigger
```

Rules apply to devices as they appear, so **unplug and replug the
adapter** afterwards. The existing device keeps its old permissions
until it re-enumerates.

## Find the settings for your panel

Two things vary between panels sold under the same name, and both have
to be determined by looking at the display.

Run in the foreground so errors are visible:

```
/usr/local/bin/mpd_oled -b 20 -g 2 -P s -L t \
  -o SSD1306,128X64_NONAME,I2C,ch341=0 -f 50
```

**Model variant.** `mpd_oled -o help` lists them. For a 128x64 SSD1306
the candidates are `128X64`, `128X64_NONAME`, `128X64_ALT0` and
`128X64_VCOMH0`. If the panel is actually an SH1106, which many are, try
the SH1106 variants instead. Pick whichever gives the clearest image.

**Column offset.** If the first character on a line is clipped, the
panel's visible area starts partway into the controller's memory. Add
`xoffset=N`:

```
/usr/local/bin/mpd_oled -b 20 -g 2 -P s -L t \
  -o SSD1306,128X64_NONAME,I2C,ch341=0,xoffset=2 -f 50
```

Try 1, 2 and 3. Use the value that gives a complete first character.
The test panel needed 2.

Ctrl-C between attempts. If a run reports `LIBUSB_ERROR_BUSY`, a
previous instance is still holding the adapter:

```
pgrep -a mpd_oled
```

## Optional settings

`ch341=N` selects the adapter when more than one is present. `0` is the
first found.

`ch341_speed=N` sets the bus rate: `0` = 20 kHz, `1` = 100 kHz,
`2` = 400 kHz, `3` = 750 kHz. The default is 400 kHz, which on the test
system gave roughly 26 full frames per second against roughly 8 at
100 kHz. Drop to `1` if long leads or weak pull-up resistors make the
bus unreliable.

`i2c_address=3d` if your panel answers at 0x3d rather than 0x3c.

`-L s` draws the spectrum full width with a frequency scale and no track
information. `-L t` is the default and shows track information alongside
a half-width spectrum.

`-u <secs>` sets how often the player status is polled, default 0.3. On
Volumio each poll is an HTTP request to the player API and the backend
logs every call, so the default puts several requests per second into
the journal continuously. `-u 1.0` is indistinguishable on a display
showing elapsed time to the second, and is what the plugin uses.

## Run it at boot

Put the arguments in a file rather than the unit, so a different panel
needs no new service file:

```
sudo tee /etc/default/mpd_oled >/dev/null <<'EOF'
# Arguments for mpd_oled. Adjust the -o string for your panel:
#   model variant  - see: mpd_oled -o help
#   xoffset=N      - if the first character is clipped
#   ch341_speed=N  - 0:20k 1:100k 2:400k 3:750k (default 2)
MPD_OLED_OPTS="-b 20 -g 2 -P s -L t -o SSD1306,128X64_NONAME,I2C,ch341=0,xoffset=2 -f 50"
EOF
```

Then the unit:

```
sudo tee /etc/systemd/system/mpd_oled.service >/dev/null <<'EOF'
[Unit]
Description=mpd_oled OLED display
After=network.target sound.target mpd.service
Wants=mpd.service

[Service]
Type=simple
User=volumio
Group=audio
EnvironmentFile=/etc/default/mpd_oled
ExecStart=/usr/local/bin/mpd_oled $MPD_OLED_OPTS
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now mpd_oled
systemctl status mpd_oled
```

Runs as `volumio` in group `audio`, which is why the udev rule uses that
group. After editing `/etc/default/mpd_oled`:

```
sudo systemctl restart mpd_oled
```

## The spectrum analyser

The spectrum area will be blank. mpd_oled needs a copy of the audio
stream, and creating one on Volumio means either editing `/etc/mpd.conf`
(which breaks the system integrity check on the next update) or using
the plugin framework's ALSA contribution mechanism, which is not
available to a standalone install.

Everything else works: track information, clock, and the play and pause
screens. Use `-L t` for the track information layout.

This is the one remaining gap, and it is deliberate. A blank spectrum is
a better trade than a failing update.

## What is where

```
/usr/local/bin/mpd_oled            the display program
/usr/local/bin/mpd_oled_cava       spectrum calculation
/etc/udev/rules.d/60-ch341-i2c.rules  device permissions
/etc/default/mpd_oled              the arguments
/etc/systemd/system/mpd_oled.service  the unit
```

Nothing under `/boot`, nothing in `/lib/modules`, and no system
configuration file modified. An OTA update does not touch any of it.

## Troubleshooting

`cannot open adapter: LIBUSB_ERROR_ACCESS` - the udev rule is missing or
the adapter has not been replugged since it was installed.

`no CH341 adapter at index 0 (1a86:5512 not found)` - the adapter is in
UART mode. Move the mode jumper. Check with `lsusb | grep 1a86`.

`cannot claim interface` or `LIBUSB_ERROR_BUSY` - something else holds
the adapter. Usually another `mpd_oled`, or the kernel module still
loaded. Check `pgrep -a mpd_oled` and `lsmod | grep ch341`.

Nothing on the panel, no error - check the model variant and `xoffset`.
Confirm the panel is alive first: `sudo systemctl stop mpd_oled`, then
`ch341_probe` from https://github.com/foonerd/ch341-i2c-usb will report
whether anything acknowledges at 0x3c.

Note that `i2cdetect` cannot help here. There is no kernel I2C bus in
this configuration, and on the kernel module route it reports a device
at every address whether or not anything is connected.
