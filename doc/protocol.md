# CH341A I2C wire protocol

Captured with `usbmon` from a working system and decoded byte by byte.
Where the existing kernel drivers disagree with what was observed, the
observation was treated as authoritative.

## Device

| Property        | Value                                    |
|-----------------|------------------------------------------|
| USB ID          | `1a86:5512` (I2C/SPI/GPIO mode)          |
| Bulk OUT        | `0x02`                                   |
| Bulk IN         | `0x82`                                   |
| Interrupt IN    | `0x81` (GPIO notifications, unused here) |
| Max packet size | 32 bytes                                 |

The chip presents a different product ID per mode: `0x5523` for UART,
`0x5512` for I2C/SPI/GPIO, `0x5584` for parallel printer. Mode is
selected in hardware by strapping, which is what the jumper on a
breakout board does.

## Commands

| Byte     | Name        | Meaning                          |
|----------|-------------|----------------------------------|
| `0xAA`   | I2C_STREAM  | Begin a command stream           |
| `0x74`   | STM_STA     | Start condition                  |
| `0x75`   | STM_STO     | Stop condition                   |
| `0x80\|n`| STM_OUT     | Write n bytes                    |
| `0xC0\|n`| STM_IN      | Read n bytes                     |
| `0x60\|s`| STM_SET     | Set bus rate, s = 0..3           |
| `0x00`   | STM_END     | End of stream                    |

Bus rates: `0` = 20 kHz, `1` = 100 kHz, `2` = 400 kHz, `3` = 750 kHz.

## Setting the bus rate

Sent standalone, typically once at open.

```
aa 62 00
```

`0x62` is `STM_SET | 2`, selecting 400 kHz.

## Writing

The count in `STM_OUT` includes the address byte. Framing costs six
bytes, leaving 26 for payload within a single 32-byte packet.

Single command byte to an SSD1306 at `0x3c`:

```
aa 74 83 78 00 a5 75 00

aa    stream
74    start
83    OUT | 3   -> address + control byte + one command
78    0x3c << 1
00    SSD1306 control byte: command follows
a5    entire display on
75    stop
00    end
```

Command with an argument:

```
aa 74 84 78 00 8d 14 75 00
```

Display data uses control byte `0x40` instead of `0x00`. The framing is
otherwise identical:

```
aa 74 83 78 40 ff 75 00
```

No IN transfer occurs on a write. Across 38,682 submissions captured
during sustained display refresh, there was not one.

## Probing an address

The only path that returns usable acknowledge status. Address phase
only, with `STM_IN` appended.

```
OUT: aa 74 80 78 c0 75 00
IN : 6f ff                  bit 7 of first byte clear -> ACK, present

OUT: aa 74 80 a0 c0 75 00
IN : ef ff                  bit 7 of first byte set   -> NAK, absent
```

Note `0x80` with a count of zero, meaning the address byte alone.

## Write status is not available

Appending `STM_IN` to a *data* write does not yield usable status. Tested
against a present and an absent address:

```
OUT: aa 74 83 78 00 a4 c0 75 00     (0x3c, panel present)
IN : ff                             one byte only

OUT: aa 74 83 a0 00 a4 c0 75 00     (0x50, nothing present)
IN : ff                             identical
```

Two observations. The results do not differ, and only one byte is
returned where the probe path returns two, so the status byte is absent
rather than merely uninformative.

Conclusion: writes are fire-and-forget on this chip. Applications
needing liveness detection should probe periodically.

## Timing

USB transfer completion is decoupled from I2C completion. The adapter
buffers the stream and completes the USB transfer before the I2C
transaction has finished:

| Transaction              | 100 kHz | 400 kHz |
|--------------------------|---------|---------|
| URB completion, measured | 114 us  | 155 us  |
| I2C wire time, computed  | 290 us  |  72 us  |

At 100 kHz the transfer completed in less than half the time the
transaction physically requires, and the ordering across the two rates
is inverted. Single-transfer timing is therefore useless as a throughput
measure; only sustained measurement is meaningful.

## Observed display workload

Driving a 128x64 SSD1306 through u8g2, per page:

```
cmd   40           set display start line 0
cmd   10 02 bN     column high 0, column low 2, page N
data  24 bytes  x5
data   8 bytes  x1
```

That is 128 bytes of pixel data in 6 transactions, 8 pages per frame.

The column low nibble of `2` is the SH1106 offset convention. A genuine
SSD1306 starts at column 0, so a mismatched device profile shows as an
image shifted by two columns.

Sustained measurement over 23.44 seconds: 4,833 pages, 604 full frames,
25.8 frames per second at 400 kHz.

Note that u8g2 sends 25 bytes per data transaction, one control byte
plus 24 of data. With the address that is 26, exactly the single-packet
maximum. There is one byte of headroom, not more.
