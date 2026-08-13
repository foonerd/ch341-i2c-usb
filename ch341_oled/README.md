# CH341 OLED — Volumio plugin

Drives an I2C OLED panel through a WCH CH341A USB adapter on x86 Volumio
systems, which have no usable I2C bus of their own.

No kernel module, no compilation on the device, and no apt at install
time. Nothing it installs is disturbed by a system update.

> **Prototype.** Working and tested on Volumio 4.143 / amd64, but not in
> the plugin store and not widely exercised.

## What you need

| | |
|---|---|
| Host | x86_64 Volumio 4 (Bookworm) |
| Adapter | CH341A USB module, jumper set to **I2C/SPI** — red LED, `lsusb` reports `1a86:5512` |
| Panel | I2C OLED supported by u8g2 — SSD1306, SH1106 and others |
| Wiring | Four wires, label to label: GND, VCC, SDA, SCL |

Set the adapter's voltage jumpers to match your panel. Most 0.96 inch
SSD1306 breakouts want 3.3 V, and both jumpers move together.

## Install

```
git clone --depth=1 https://github.com/foonerd/ch341-i2c-usb.git
cd ch341-i2c-usb/ch341_oled
volumio plugin install
```

Then enable it under **Plugins → Installed plugins**.

If a CH341 kernel module was installed previously, the installer removes
it. Two drivers contending for one adapter can deadlock the kernel.

## Settings

**Panel model** — controller and model as listed by `mpd_oled -o help`.
Start with `SSD1306,128X64_NONAME`. Many panels sold as SSD1306 are in
fact SH1106, so try `SH1106,128X64_NONAME` if the image is poor.

**Column offset** — if the first character on a line is clipped at the
left edge, the panel's visible area starts partway into the controller's
memory. Try 1, 2 and 3. This varies between panels sold under the same
name; the development panel needed 2.

**I2C address** — leave empty for 0x3c, set `3d` if your panel uses the
alternate address.

**Bus speed** — 400 kHz by default, roughly three times the frame rate
of 100 kHz. Reduce it if long leads or weak pull-up resistors make the
display unreliable.

## How it works

```mermaid
flowchart TB
    subgraph sw["Volumio host"]
        mpdoled["mpd_oled<br/><i>layout, text, spectrum</i>"]
        cava["mpd_oled_cava<br/><i>FFT</i>"]
        u8g2["libu8g2arm<br/><i>u8g2 + CH341 transport</i>"]
        libusb["libusb-1.0"]
    end
    subgraph hw["Hardware"]
        adapter["CH341A<br/><code>1a86:5512</code>"]
        panel["OLED panel"]
    end
    fifo[("/tmp/ch341_oled_fifo")]
    fifo --> cava
    cava --> mpdoled
    mpdoled --> u8g2
    u8g2 --> libusb
    libusb -->|USB bulk| adapter
    adapter -->|I2C| panel
```

The display path needs no kernel driver: `libu8g2arm` was forked to add
a transport that speaks to the adapter over libusb directly. The device
string carries `ch341=0` instead of a bus number.

## The audio tap

The spectrum needs a copy of the playback stream. The plugin declares
`has_alsa_contribution` and ships an ALSA fragment, which Volumio's
backend splices into the generated chain. **`/etc/mpd.conf` is never
edited**, so the system integrity check is not disturbed and updates are
unaffected.

```mermaid
flowchart LR
    src["MPD · AirPlay<br/>Spotify · Tidal"] --> vol["pcm.volumio"]
    vol --> mr["multiroom<br/><i>rank 1000</i>"]
    mr --> in["ch341oled_in<br/><i>rank 5</i>"]
    in --> split{"route + multi"}
    split -->|unconverted| out["ch341oled_out"]
    split -->|"44100 S16_LE"| ff["volumiofifo"]
    out --> hw["volumioOutput<br/>volumioHw"]
    ff --> fifo[("/tmp/ch341_oled_fifo")]
    fifo --> cava["mpd_oled_cava"]
    classDef ours fill:#eef,stroke:#66c
    class in,split,ff,fifo ours
```

Because the split happens at the ALSA layer rather than inside MPD, the
spectrum works for **every** source — AirPlay, Spotify Connect, Tidal
Connect and webradio, not only MPD.

Two details in the fragment are not obvious and both matter. The FIFO
branch uses `volumiofifo`, Volumio's own plugin, because the stock ALSA
`file` plugin blocks on opening a FIFO until a reader attaches and would
make playback depend on cava starting first. And the branch is wrapped
in a `plug` forcing 44100/S16_LE/2, because cava's FIFO input assumes a
rate rather than negotiating one.

## Lifecycle

```mermaid
sequenceDiagram
    participant V as Volumio
    participant P as plugin
    participant A as alsa_controller
    participant S as systemd
    V->>P: onStart
    P->>P: mkfifo -m 646 /tmp/ch341_oled_fifo
    P->>P: generate start.sh from settings
    P->>A: updateALSAConfigFile
    A->>A: rebuild /etc/asound.conf with our fragment
    P->>S: systemctl start ch341_oled
    S->>S: start.sh → mpd_oled, which spawns cava
    Note over V,S: settings change → regenerate start.sh, restart service
    V->>P: onStop
    P->>S: systemctl stop ch341_oled
    P->>A: updateALSAConfigFile
    A->>A: rebuild without our fragment
    P->>P: rm -f the FIFO
```

The FIFO must exist before the ALSA config is regenerated: regeneration
makes MPD reopen the chain immediately, `volumiofifo` does not create the
FIFO itself, and a missing one makes the whole chain fail to resolve.

## What gets installed

```
/usr/local/bin/mpd_oled                    display program
/usr/local/bin/mpd_oled_cava               spectrum calculation
/etc/udev/rules.d/60-ch341-i2c.rules       device permissions
/etc/sudoers.d/volumio-ch341_oled          service control, scoped to this unit
/etc/systemd/system/ch341_oled.service     the unit
```

Nothing under `/boot`, nothing in `/lib/modules`, and no system
configuration file modified. Uninstalling removes all of it.

The payload is prebuilt and links only against libraries present on a
stock image, with `libiniparser` and `libfftw3` statically linked into
cava. So the install needs no network and cannot drift with package
versions.

## Troubleshooting

**`cannot open adapter: LIBUSB_ERROR_ACCESS`** — the udev rule has not
taken effect. Unplug and replug the adapter.

**`no CH341 adapter at index 0`** — the adapter is in UART mode. Move
the mode jumper and check `lsusb | grep 1a86` reports `5512`.

**First character clipped** — set the column offset. Try 1, 2 and 3.

**Blurred or wrong-looking text** — try a different panel model. The
SH1106 variants are worth trying even if the panel was sold as SSD1306.

**No spectrum bars** — check `ls -l /tmp/ch341_oled_fifo` shows a FIFO,
the leading character being `p`. Then confirm something is playing. If
the display updates on track change but never shows bars, check the
journal for cava failing to start:

```
journalctl -u ch341_oled -n 50 --no-pager | grep -i cava
```

**Nothing plays after enabling** — disable the plugin, which rebuilds
the ALSA chain without the fragment and restores audio, then report it.

Note that `i2cdetect` is no help here. There is no kernel I2C bus in
this configuration.

## Building the payload yourself

The binaries in `bin/` come from
[foonerd/libu8g2arm](https://github.com/foonerd/libu8g2arm/tree/feat/ch341-usb-transport)
and [wheaten/mpd_oled_dev](https://github.com/wheaten/mpd_oled_dev). The
full build procedure is in
[../doc/volumio4-x86-install.md](../doc/volumio4-x86-install.md), which
also covers running `mpd_oled` without the plugin.

## Licence

MIT. See [../LICENSE](../LICENSE).

`mpd_oled` is by Adrian Rossiter and contributors; the x86 work builds
on Wheaten's development branch. cava is by Karl Stavestrand. The
Volumio plugin conventions and the ALSA contribution pattern follow the
existing `mpd_oled`, `peppyspectrum` and `stylish_player` plugins.
