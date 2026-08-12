# ch341-i2c-usb

A userspace I2C transport for the WCH CH341A USB adapter, using libusb.

No kernel module. No kernel headers. Nothing pinned to a kernel version,
and nothing to break when the system is updated.

## Why this exists

The CH341A is a cheap and widely available USB to I2C bridge, but Linux
has no in-tree I2C driver for it. Frank Zago's MFD/I2C/GPIO series was
submitted upstream in 2022 and was not merged, so every existing option
is an out-of-tree module:

- `gschorcht/i2c-ch341-usb` and its ancestors
- `frank-zago/ch341-i2c-spi-gpio`

Both work, and both have the same structural problem on an appliance
distribution: a kernel module must be rebuilt for every kernel, and
building it requires kernel headers, which on some systems breaks update
integrity checking. When the kernel changes, the module silently stops
loading and the device stops working with no obvious cause.

This library sidesteps all of that by talking to the adapter directly
over libusb.

## What it does and does not do

Implemented:

- Open a specific adapter by index, so more than one can be used
- Set the I2C bus rate: 20, 100, 400 or 750 kHz
- Probe an address, with genuine ACK/NAK reporting
- Write to an address

Not implemented:

- Reads. Write-only is sufficient for displays, which is what this was
  written for. Reads are a straightforward addition if needed.
- GPIO and SPI. The CH341A supports both; this library does not.
- Writes larger than 26 bytes. See "Limits" below.

## Limits, and one that matters

**Writes cannot be confirmed.** `ch341_i2c_write()` returns whether the
adapter accepted the command, not whether the slave acknowledged it.

This is not an oversight. Appending a status read to a data write was
tested against both a populated and an empty address, and returned an
identical result in each case, so the acknowledge bit is not available
on that path. It is a property of the chip. Neither existing kernel
driver reports it either.

`ch341_i2c_probe()` **is** reliable, because the address-phase form does
return usable status. Applications that need to know a device is still
present should probe periodically rather than trusting write returns.

**Maximum write is 26 bytes.** The bulk endpoint is 32 bytes and the
command framing costs 6 of them. Larger writes are refused with an
error rather than silently truncated.

## Building

Requires libusb-1.0.

```
sudo apt-get install build-essential libusb-1.0-0-dev
make
```

Produces `libch341.a` and the `ch341_probe` diagnostic tool.

## Permissions

By default the adapter is root-only. Install the supplied udev rule to
avoid running as root:

```
sudo cp udev/60-ch341-i2c.rules /etc/udev/rules.d/
sudo udevadm control --reload-rules
sudo udevadm trigger
```

Adjust `GROUP` in the rule to suit, and make sure your user is a member.

## Adapter setup

The CH341A presents a different USB product ID depending on how it is
strapped, and the mode is selected by a jumper on the breakout board:

| Mode                      | USB ID      | Handled by                |
|---------------------------|-------------|---------------------------|
| UART                      | `1a86:5523` | in-tree `ch341` serial    |
| I2C / SPI / GPIO          | `1a86:5512` | this library              |
| Parallel printer          | `1a86:5584` | in-tree `usblp`           |

This library only finds `1a86:5512`. If `lsusb` reports `5523`, move the
mode jumper. On the common DollaTek and WWZMDiB boards the I2C position
lights the red LED and the UART position lights the blue one.

Set the voltage jumpers to match your device. Most 0.96 inch SSD1306
breakouts want 3.3 V. Both jumpers move together.

## Usage

```c
#include "ch341.h"

char err[160];
ch341_dev *dev = ch341_open(0, err, sizeof(err));
if (!dev) {
    fprintf(stderr, "%s\n", err);
    return 1;
}

ch341_set_speed(dev, CH341_SPEED_400K);

/* Find an SSD1306: it answers at 0x3c or 0x3d */
uint8_t addr = 0;
if (ch341_i2c_probe(dev, 0x3c) == 1)      addr = 0x3c;
else if (ch341_i2c_probe(dev, 0x3d) == 1) addr = 0x3d;

if (addr) {
    /* charge pump on, display on, all pixels on */
    const uint8_t on[] = { 0x00, 0x8d, 0x14, 0xaf, 0xa5 };
    ch341_i2c_write(dev, addr, on, sizeof(on));
}

ch341_close(dev);
```

Link with `-lch341 -lusb-1.0`.

## The probe tool

`ch341_probe` is the diagnostic that established the write-status
limitation, kept in the repository because it is a useful bring-up tool.
It runs two tests against a present and an absent address and prints the
raw bytes in both directions.

```
sudo ./ch341_probe          # defaults: 0x3c present, 0x50 absent
sudo ./ch341_probe 3d 50    # override
```

If a CH341 kernel module is loaded it will be detached automatically,
but unloading it first is cleaner:

```
sudo rmmod i2c-ch341-usb
```

Do not leave a kernel module and this library contending for the same
adapter. That has been observed to wedge the kernel side badly enough to
require a reboot.

## Performance

Measured driving a 128x64 SSD1306 through mpd_oled on an Intel Jasper
Lake host:

| Bus rate | Full frames per second |
|----------|------------------------|
| 100 kHz  | roughly 8              |
| 400 kHz  | roughly 26             |

A full frame is 1024 bytes, sent as 8 pages of 6 transactions each. The
bus is the constraint, not the host, so the rate setting matters a great
deal for display work. This library defaults to 400 kHz for that reason.
Drop to 100 kHz if long leads or weak pull-up resistors make the bus
unreliable.

Note that USB transfer completion does not wait for the I2C transaction
to finish, so timing a single transfer tells you nothing useful about
throughput. Only sustained measurement does.

## Protocol

The wire protocol is documented in [doc/protocol.md](doc/protocol.md).
It was captured with usbmon from a working system and decoded byte by
byte, rather than taken from a datasheet.

## Licence

MIT. See [LICENSE](LICENSE).

The protocol constants are common to several prior implementations, in
particular the work of Till Harbaum, Marco Gittler, Tse Lun Bien, Gunar
Schorcht and Frank Zago. This is an independent implementation, but
their drivers were valuable references and are acknowledged here.
