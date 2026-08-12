/*
 * ch341_probe - does the CH341A return usable ACK/NAK status?
 *
 * Two questions, neither answered by the existing kernel drivers:
 *
 *   Test A  Zago's zero-length probe form (i2c-ch341.c, no_data_xfer).
 *           Known to work for detection. Included as a control, so that a
 *           null result in Test B can be distinguished from a broken setup.
 *
 *   Test B  A real data write with STM_IN appended. Neither gschorcht nor
 *           Zago does this. If the status differs between a present and an
 *           absent address, per-write error reporting is possible.
 *
 * Wire framing is as captured on the bench with usbmon, not inferred:
 *
 *   aa            CH341_CMD_I2C_STREAM
 *   74            STM_STA        start
 *   80 | n        STM_OUT        write n bytes (address counts as one)
 *   addr << 1     7-bit address, write direction
 *   ...           payload
 *   c0            STM_IN         read back status   <- the piece under test
 *   75            STM_STO        stop
 *   00            STM_END
 *
 * Endpoints for 1a86:5512, confirmed from the driver probe log:
 *   bulk OUT 0x02, bulk IN 0x82, interrupt IN 0x81 (unused here)
 *
 * Build: make
 * Run:   sudo rmmod i2c-ch341-usb     (libusb must own the interface)
 *        sudo ./ch341_probe
 *        sudo ./ch341_probe 3c 50     (override present/absent addresses)
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <libusb-1.0/libusb.h>

#define CH341_VID       0x1a86
#define CH341_PID       0x5512

#define EP_OUT          0x02
#define EP_IN           0x82

#define CMD_I2C_STREAM  0xAA
#define STM_STA         0x74
#define STM_STO         0x75
#define STM_OUT         0x80
#define STM_IN          0xC0
#define STM_SET         0x60
#define STM_END         0x00

#define SPEED_20K       0
#define SPEED_100K      1
#define SPEED_400K      2
#define SPEED_750K      3

#define TIMEOUT_MS      200
#define IN_BUFSZ        32

static void hexdump(const unsigned char *b, int n)
{
    int i;
    for (i = 0; i < n; i++)
        printf("%02x ", b[i]);
}

/* Send a raw command stream on the bulk OUT endpoint. */
static int send_out(libusb_device_handle *h, const unsigned char *buf, int len)
{
    int actual = 0;
    int rc = libusb_bulk_transfer(h, EP_OUT, (unsigned char *)buf, len,
                                  &actual, TIMEOUT_MS);
    if (rc != 0) {
        printf("    OUT failed: %s\n", libusb_error_name(rc));
        return rc;
    }
    if (actual != len) {
        printf("    OUT short: %d of %d\n", actual, len);
        return -1;
    }
    return 0;
}

/*
 * Read from the bulk IN endpoint. A timeout is a legitimate result here,
 * not an error - it tells us the adapter returned nothing at all - so it
 * is reported rather than treated as a failure.
 */
static int read_in(libusb_device_handle *h, unsigned char *buf, int want)
{
    int actual = 0;
    int rc;

    memset(buf, 0, IN_BUFSZ);
    rc = libusb_bulk_transfer(h, EP_IN, buf, want, &actual, TIMEOUT_MS);

    if (rc == LIBUSB_ERROR_TIMEOUT) {
        printf("    IN  timeout (nothing returned)\n");
        return -1;
    }
    if (rc != 0) {
        printf("    IN  failed: %s\n", libusb_error_name(rc));
        return -1;
    }
    return actual;
}

/* Set the I2C bus rate. Sent standalone, as the drivers do at probe time. */
static int set_speed(libusb_device_handle *h, int speed)
{
    unsigned char out[3];

    out[0] = CMD_I2C_STREAM;
    out[1] = STM_SET | (speed & 0x03);
    out[2] = STM_END;

    printf("Setting bus speed (index %d): ", speed);
    hexdump(out, 3);
    printf("\n");

    return send_out(h, out, 3);
}

/*
 * Test A - zero-length probe, the form Zago uses in no_data_xfer().
 * Address only, no payload, STM_IN appended. This is what i2cdetect
 * drives, and it is the known-good control for this experiment.
 */
static void test_a(libusb_device_handle *h, int addr, const char *label)
{
    unsigned char out[7];
    unsigned char in[IN_BUFSZ];
    int got;

    out[0] = CMD_I2C_STREAM;
    out[1] = STM_STA;
    out[2] = STM_OUT;          /* count 0: address byte only */
    out[3] = (addr << 1);      /* write direction */
    out[4] = STM_IN;
    out[5] = STM_STO;
    out[6] = STM_END;

    printf("  [A] addr 0x%02x (%s)\n", addr, label);
    printf("    OUT: ");
    hexdump(out, 7);
    printf("\n");

    if (send_out(h, out, 7) != 0)
        return;

    got = read_in(h, in, 2);
    if (got < 0)
        return;

    printf("    IN : ");
    hexdump(in, got);
    printf("  (%d bytes)\n", got);
    printf("    -> byte0 bit7 = %d  => %s\n",
           (in[0] & 0x80) ? 1 : 0,
           (in[0] & 0x80) ? "NAK (absent)" : "ACK (present)");
}

/*
 * Test B - real data write with STM_IN appended.
 *
 * This is the question neither driver answers. Payload is a harmless
 * SSD1306 command: control byte 0x00 marks command mode, 0xa4 resumes
 * display from RAM content and changes nothing destructive.
 */
static void test_b(libusb_device_handle *h, int addr, const char *label)
{
    unsigned char out[9];
    unsigned char in[IN_BUFSZ];
    int got;

    out[0] = CMD_I2C_STREAM;
    out[1] = STM_STA;
    out[2] = STM_OUT | 3;      /* address + control byte + command */
    out[3] = (addr << 1);
    out[4] = 0x00;             /* SSD1306 control byte: command follows */
    out[5] = 0xa4;             /* resume display from RAM (harmless) */
    out[6] = STM_IN;           /* the addition under test */
    out[7] = STM_STO;
    out[8] = STM_END;

    printf("  [B] addr 0x%02x (%s)\n", addr, label);
    printf("    OUT: ");
    hexdump(out, 9);
    printf("\n");

    if (send_out(h, out, 9) != 0)
        return;

    got = read_in(h, in, 2);
    if (got < 0)
        return;

    printf("    IN : ");
    hexdump(in, got);
    printf("  (%d bytes)\n", got);
    printf("    -> byte0 bit7 = %d\n", (in[0] & 0x80) ? 1 : 0);
}

int main(int argc, char **argv)
{
    libusb_device_handle *h;
    int present = 0x3c;
    int absent  = 0x50;
    int rc;

    /*
     * Unbuffered stdout. If the program stalls inside libusb, buffered
     * output would never be flushed and the user would see nothing at
     * all, which tells them less than knowing where it stopped.
     */
    setvbuf(stdout, NULL, _IONBF, 0);

    if (argc >= 2)
        present = (int)strtol(argv[1], NULL, 16);
    if (argc >= 3)
        absent = (int)strtol(argv[2], NULL, 16);

    printf("[1] libusb_init\n");
    rc = libusb_init(NULL);
    if (rc != 0) {
        fprintf(stderr, "libusb_init: %s\n", libusb_error_name(rc));
        return 1;
    }

    printf("[2] opening %04x:%04x\n", CH341_VID, CH341_PID);
    h = libusb_open_device_with_vid_pid(NULL, CH341_VID, CH341_PID);
    if (h == NULL) {
        fprintf(stderr,
                "Cannot open %04x:%04x. Is the adapter plugged in and in\n"
                "I2C mode (check the jumper), and are you running as root?\n",
                CH341_VID, CH341_PID);
        libusb_exit(NULL);
        return 1;
    }

    /*
     * Take the interface away from the kernel module if it holds it.
     * Cleaner to rmmod first, but this makes the tool work either way.
     */
    printf("[3] auto-detach kernel driver\n");
    libusb_set_auto_detach_kernel_driver(h, 1);

    printf("[4] claiming interface 0\n");
    rc = libusb_claim_interface(h, 0);
    if (rc != 0) {
        fprintf(stderr, "claim_interface: %s\n"
                        "Try: sudo rmmod i2c-ch341-usb\n",
                libusb_error_name(rc));
        libusb_close(h);
        libusb_exit(NULL);
        return 1;
    }

    printf("[5] ready\n\n");
    printf("Opened %04x:%04x, interface 0 claimed.\n\n", CH341_VID, CH341_PID);

    if (set_speed(h, SPEED_100K) != 0)
        goto out;

    printf("\n--- Test A: zero-length probe (Zago no_data_xfer form) ---\n");
    printf("    Control. Known to distinguish present from absent.\n\n");
    test_a(h, present, "expected present");
    printf("\n");
    test_a(h, absent, "expected absent");

    printf("\n--- Test B: data write with STM_IN appended ---\n");
    printf("    The open question. Neither kernel driver does this.\n\n");
    test_b(h, present, "expected present");
    printf("\n");
    test_b(h, absent, "expected absent");

    printf("\n--- Reading ---\n");
    printf("If A differs between the two addresses and B does not, then\n");
    printf("write status is unavailable and writes are fire-and-forget.\n");
    printf("If B also differs, per-write NAK reporting is possible.\n");
    printf("If A does not differ either, something is wrong with the\n");
    printf("setup rather than with the chip - stop and check that.\n");

out:
    libusb_release_interface(h, 0);
    libusb_close(h);
    libusb_exit(NULL);
    return 0;
}
