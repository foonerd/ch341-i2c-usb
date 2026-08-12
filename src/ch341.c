/*
   ch341.c - WCH CH341A USB to I2C transport, via libusb.

   Copyright (c) 2026, foonerd
                       https://github.com/foonerd

   Written as an OTA-safe alternative to the out-of-tree CH341 kernel
   modules for Volumio.

   The wire protocol below was not taken from documentation. It was
   captured with usbmon from a working system and decoded byte by byte,
   then each element verified against a panel that responds. Where the
   two existing kernel drivers disagree with what was observed, the
   observation was taken as authoritative.

   Command framing, as captured:

     aa            CH341_CMD_I2C_STREAM
     74            STM_STA         start condition
     80 | n        STM_OUT         write n bytes, address counts as one
     addr << 1     7-bit address, write direction
     ...           payload
     c0            STM_IN          read status (probe path only)
     75            STM_STO         stop condition
     00            STM_END

   Endpoints on 1a86:5512: bulk OUT 0x02, bulk IN 0x82, interrupt IN
   0x81. The interrupt endpoint carries GPIO change notifications and is
   unused here.

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

#include "ch341.h"

#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <libusb-1.0/libusb.h>

#define CH341_VID 0x1a86
#define CH341_PID 0x5512

#define CH341_EP_OUT 0x02
#define CH341_EP_IN  0x82

#define CH341_CMD_I2C_STREAM 0xAA
#define CH341_STM_STA        0x74
#define CH341_STM_STO        0x75
#define CH341_STM_OUT        0x80
#define CH341_STM_IN         0xC0
#define CH341_STM_SET        0x60
#define CH341_STM_END        0x00

/* CH341A wMaxPacketSize for the bulk endpoints. */
#define CH341_PACKET_SIZE 32

/*
 * Timeouts. The write path is on the hot loop for display refresh, so it
 * is kept short: a stalled transfer should surface quickly rather than
 * stalling the caller's frame loop. The probe path is not time critical.
 */
#define CH341_TIMEOUT_WRITE_MS 100
#define CH341_TIMEOUT_PROBE_MS 200

#define CH341_ERRMSG_LEN 160

struct ch341_dev {
    libusb_context *ctx;
    libusb_device_handle *handle;
    int interface_claimed;
    char errmsg[CH341_ERRMSG_LEN];
};

static void set_error(ch341_dev *dev, const char *fmt, ...)
    __attribute__((format(printf, 2, 3)));

static void set_error(ch341_dev *dev, const char *fmt, ...)
{
    va_list ap;

    if (dev == NULL)
        return;

    va_start(ap, fmt);
    vsnprintf(dev->errmsg, sizeof(dev->errmsg), fmt, ap);
    va_end(ap);
}

/*
 * Locate the index'th CH341A. Iterating the device list rather than
 * using libusb_open_device_with_vid_pid(), because that convenience
 * function always returns the first match and gives no way to address a
 * second adapter.
 */
static libusb_device *find_device(libusb_context *ctx, int index,
                                  libusb_device ***list_out, ssize_t *cnt_out)
{
    libusb_device **list = NULL;
    ssize_t cnt;
    ssize_t i;
    int seen = 0;

    cnt = libusb_get_device_list(ctx, &list);
    if (cnt < 0) {
        *list_out = NULL;
        *cnt_out = 0;
        return NULL;
    }

    *list_out = list;
    *cnt_out = cnt;

    for (i = 0; i < cnt; i++) {
        struct libusb_device_descriptor desc;

        if (libusb_get_device_descriptor(list[i], &desc) != 0)
            continue;

        if (desc.idVendor != CH341_VID || desc.idProduct != CH341_PID)
            continue;

        if (seen == index)
            return list[i];

        seen++;
    }

    return NULL;
}

ch341_dev *ch341_open(int index, char *errmsg, int errmsg_len)
{
    ch341_dev *dev;
    libusb_device **list = NULL;
    libusb_device *found;
    ssize_t cnt = 0;
    int rc;

    if (index < 0)
        index = 0;

    dev = (ch341_dev *)calloc(1, sizeof(*dev));
    if (dev == NULL) {
        if (errmsg && errmsg_len > 0)
            snprintf(errmsg, errmsg_len, "out of memory");
        return NULL;
    }

    strcpy(dev->errmsg, "no error");

    rc = libusb_init(&dev->ctx);
    if (rc != 0) {
        if (errmsg && errmsg_len > 0)
            snprintf(errmsg, errmsg_len, "libusb_init: %s",
                     libusb_error_name(rc));
        free(dev);
        return NULL;
    }

    found = find_device(dev->ctx, index, &list, &cnt);
    if (found == NULL) {
        if (errmsg && errmsg_len > 0)
            snprintf(errmsg, errmsg_len,
                     "no CH341 adapter at index %d (%04x:%04x not found; "
                     "check the mode jumper is set to I2C)",
                     index, CH341_VID, CH341_PID);
        if (list)
            libusb_free_device_list(list, 1);
        libusb_exit(dev->ctx);
        free(dev);
        return NULL;
    }

    rc = libusb_open(found, &dev->handle);
    libusb_free_device_list(list, 1);

    if (rc != 0) {
        if (errmsg && errmsg_len > 0)
            snprintf(errmsg, errmsg_len,
                     "cannot open adapter: %s%s", libusb_error_name(rc),
                     (rc == LIBUSB_ERROR_ACCESS)
                         ? " (need root, or a udev rule granting access)"
                         : "");
        libusb_exit(dev->ctx);
        free(dev);
        return NULL;
    }

    /*
     * Take the interface from the kernel module if one holds it. This
     * matters on Volumio, where i2c-ch341-usb may already be loaded:
     * without the detach, claim_interface fails, and with both drivers
     * contending the kernel side has been observed to deadlock.
     */
    libusb_set_auto_detach_kernel_driver(dev->handle, 1);

    rc = libusb_claim_interface(dev->handle, 0);
    if (rc != 0) {
        if (errmsg && errmsg_len > 0)
            snprintf(errmsg, errmsg_len,
                     "cannot claim interface: %s (is the adapter in use?)",
                     libusb_error_name(rc));
        libusb_close(dev->handle);
        libusb_exit(dev->ctx);
        free(dev);
        return NULL;
    }

    dev->interface_claimed = 1;

    if (errmsg && errmsg_len > 0)
        errmsg[0] = '\0';

    return dev;
}

void ch341_close(ch341_dev *dev)
{
    if (dev == NULL)
        return;

    if (dev->handle) {
        if (dev->interface_claimed)
            libusb_release_interface(dev->handle, 0);
        libusb_close(dev->handle);
    }

    if (dev->ctx)
        libusb_exit(dev->ctx);

    free(dev);
}

const char *ch341_last_error(ch341_dev *dev)
{
    if (dev == NULL)
        return "no device";
    return dev->errmsg;
}

/* Send a prepared command stream on the bulk OUT endpoint. */
static int bulk_out(ch341_dev *dev, const uint8_t *buf, int len, int timeout_ms)
{
    int actual = 0;
    int rc;

    rc = libusb_bulk_transfer(dev->handle, CH341_EP_OUT,
                              (unsigned char *)buf, len, &actual, timeout_ms);
    if (rc != 0) {
        set_error(dev, "bulk write failed: %s", libusb_error_name(rc));
        return -1;
    }

    if (actual != len) {
        set_error(dev, "short bulk write: %d of %d bytes", actual, len);
        return -1;
    }

    return 0;
}

int ch341_set_speed(ch341_dev *dev, int speed)
{
    uint8_t out[3];

    if (dev == NULL || dev->handle == NULL)
        return -1;

    if (speed < CH341_SPEED_20K || speed > CH341_SPEED_750K) {
        set_error(dev, "invalid speed index %d, must be 0 to 3", speed);
        return -1;
    }

    out[0] = CH341_CMD_I2C_STREAM;
    out[1] = CH341_STM_SET | (uint8_t)speed;
    out[2] = CH341_STM_END;

    return bulk_out(dev, out, 3, CH341_TIMEOUT_PROBE_MS);
}

int ch341_i2c_probe(ch341_dev *dev, uint8_t addr)
{
    uint8_t out[7];
    unsigned char in[CH341_PACKET_SIZE];
    int actual = 0;
    int rc;

    if (dev == NULL || dev->handle == NULL)
        return -1;

    /*
     * Address phase only, with a status read appended. Verified on the
     * bench: a present slave returns a first byte with bit 7 clear, an
     * absent one returns the same byte with bit 7 set.
     */
    out[0] = CH341_CMD_I2C_STREAM;
    out[1] = CH341_STM_STA;
    out[2] = CH341_STM_OUT;        /* count zero: address byte only */
    out[3] = (uint8_t)(addr << 1); /* write direction */
    out[4] = CH341_STM_IN;
    out[5] = CH341_STM_STO;
    out[6] = CH341_STM_END;

    if (bulk_out(dev, out, 7, CH341_TIMEOUT_PROBE_MS) != 0)
        return -1;

    memset(in, 0, sizeof(in));
    rc = libusb_bulk_transfer(dev->handle, CH341_EP_IN, in, 2, &actual,
                              CH341_TIMEOUT_PROBE_MS);

    if (rc == LIBUSB_ERROR_TIMEOUT) {
        set_error(dev, "probe of 0x%02x: no status returned", addr);
        return -1;
    }

    if (rc != 0) {
        set_error(dev, "probe of 0x%02x: %s", addr, libusb_error_name(rc));
        return -1;
    }

    if (actual < 1) {
        set_error(dev, "probe of 0x%02x: empty status", addr);
        return -1;
    }

    return (in[0] & 0x80) ? 0 : 1;
}

int ch341_i2c_write(ch341_dev *dev, uint8_t addr, const uint8_t *buf, int len)
{
    uint8_t out[CH341_PACKET_SIZE];
    int k = 0;

    if (dev == NULL || dev->handle == NULL)
        return -1;

    if (buf == NULL || len < 0) {
        set_error(dev, "invalid write arguments");
        return -1;
    }

    /*
     * One packet only. Framing costs 6 bytes of the 32-byte endpoint,
     * leaving CH341_MAX_WRITE for payload. u8g2 never exceeds that, so
     * rather than carry untested multi-segment code that would never
     * run, this refuses oversized writes and says so plainly.
     */
    if (len > CH341_MAX_WRITE) {
        set_error(dev, "write of %d bytes exceeds maximum of %d",
                  len, CH341_MAX_WRITE);
        return -1;
    }

    out[k++] = CH341_CMD_I2C_STREAM;
    out[k++] = CH341_STM_STA;
    out[k++] = (uint8_t)(CH341_STM_OUT | (len + 1)); /* +1 for the address */
    out[k++] = (uint8_t)(addr << 1);

    if (len > 0) {
        memcpy(&out[k], buf, (size_t)len);
        k += len;
    }

    out[k++] = CH341_STM_STO;
    out[k++] = CH341_STM_END;

    /*
     * No status read here. Appending STM_IN to a data write was tested
     * against both a present and an absent address and returned an
     * identical result, so there is nothing to be learned from it and
     * the extra USB round trip would only cost throughput. See the
     * comment on ch341_i2c_write() in ch341.h.
     */
    return bulk_out(dev, out, k, CH341_TIMEOUT_WRITE_MS);
}
