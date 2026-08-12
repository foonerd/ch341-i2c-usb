/*
   ch341.h - WCH CH341A USB to I2C transport, via libusb.

   Copyright (c) 2026, foonerd
                       https://github.com/foonerd

   Written as an OTA-safe alternative to the out-of-tree CH341 kernel
   modules for Volumio. No kernel module, no kernel headers, no vermagic
   pinning, nothing to break when the kernel is updated.

   Permission is hereby granted, free of charge, to any person obtaining a
   copy of this software and associated documentation files (the "Software"),
   to deal in the Software without restriction, including without limitation
   the rights to use, copy, modify, merge, publish, distribute, sublicense,
   and/or sell copies of the Software, and to permit persons to whom the
   Software is furnished to do so, subject to the following conditions:

      The above copyright notice and this permission notice shall be included
      in all copies or substantial portions of the Software.

  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
  IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
  FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
  AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
  LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
  FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
  IN THE SOFTWARE.
*/

#ifndef FOONERD_CH341_H
#define FOONERD_CH341_H

#ifdef __cplusplus
extern "C" {
#endif

#include <stdint.h>

/*
 * I2C bus rates. The CH341A supports exactly these four and no others.
 *
 * Measured on a Jasper Lake host driving a 128x64 SSD1306 through
 * mpd_oled: 100 kHz yields roughly 8 full frames per second, 400 kHz
 * yields roughly 26. For an OLED the difference is decisive, so 400 kHz
 * is the default here. Drop to 100 kHz if long leads or weak pull-ups
 * make the bus unreliable.
 */
#define CH341_SPEED_20K   0
#define CH341_SPEED_100K  1
#define CH341_SPEED_400K  2
#define CH341_SPEED_750K  3

#define CH341_SPEED_DEFAULT CH341_SPEED_400K

/*
 * Largest I2C payload accepted by ch341_i2c_write(), excluding the
 * address byte. The CH341A bulk endpoint is 32 bytes and the command
 * framing costs 6 of them (STREAM, STA, OUT, address, STO, END), which
 * leaves 26. u8g2 sends at most 25 (one control byte plus 24 of data),
 * so this is adequate with one byte to spare.
 */
#define CH341_MAX_WRITE 26

/* Opaque device handle. */
typedef struct ch341_dev ch341_dev;

/*
 * Open the index'th CH341A found on the USB bus, 0 being the first.
 * The device must be strapped for I2C/SPI mode so that it enumerates as
 * 1a86:5512; in UART mode it presents a different product ID and will
 * not be found.
 *
 * Any kernel driver holding the interface is detached automatically.
 *
 * Returns NULL on failure. If errmsg is non-NULL it receives a short
 * description, truncated to errmsg_len.
 */
ch341_dev *ch341_open(int index, char *errmsg, int errmsg_len);

/* Release the interface and close. Safe to call with NULL. */
void ch341_close(ch341_dev *dev);

/*
 * Set the I2C bus rate to one of the CH341_SPEED_* values.
 * Returns 0 on success, negative on failure.
 */
int ch341_set_speed(ch341_dev *dev, int speed);

/*
 * Test whether a device acknowledges at the given 7-bit address.
 *
 * This issues an address-phase-only transaction and reads the adapter's
 * status byte back. Bit 7 clear means the slave acknowledged.
 *
 * Returns 1 if present, 0 if absent, negative on transport failure.
 *
 * Unlike the write path below this is genuinely reliable, so it is the
 * correct way to locate a panel or to check that one is still attached.
 */
int ch341_i2c_probe(ch341_dev *dev, uint8_t addr);

/*
 * Write len bytes to the 7-bit address addr.
 *
 * IMPORTANT, and the reason this is documented rather than assumed:
 * the return value reports only whether the adapter accepted the
 * command. It does NOT report whether the slave acknowledged.
 *
 * This was established by experiment rather than inferred. Appending a
 * status read to a data write returns an identical result whether or
 * not a slave is present, so the acknowledge bit is simply not
 * available on this path. It is a property of the CH341A, not of this
 * code, and neither of the two kernel drivers reports it either.
 *
 * Callers that need to know a panel is alive should call
 * ch341_i2c_probe() periodically instead.
 *
 * Returns 0 on success, negative on failure. len must not exceed
 * CH341_MAX_WRITE.
 */
int ch341_i2c_write(ch341_dev *dev, uint8_t addr, const uint8_t *buf, int len);

/* Human-readable description of the last failure, never NULL. */
const char *ch341_last_error(ch341_dev *dev);

#ifdef __cplusplus
}
#endif

#endif /* FOONERD_CH341_H */
