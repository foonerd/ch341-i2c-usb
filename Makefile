# ch341-i2c-usb
# Copyright (c) 2026 foonerd

CC       ?= gcc
AR       ?= ar
CFLAGS   ?= -W -Wall -Wextra -O2
PREFIX   ?= /usr/local

USB_CFLAGS := $(shell pkg-config --cflags libusb-1.0 2>/dev/null)
USB_LIBS   := $(shell pkg-config --libs libusb-1.0 2>/dev/null || echo -lusb-1.0)

LIB     := libch341.a
LIBOBJS := src/ch341.o
TOOL    := ch341_probe

all: $(LIB) $(TOOL)

src/%.o: src/%.c src/ch341.h
	$(CC) $(CFLAGS) $(USB_CFLAGS) -Isrc -c $< -o $@

$(LIB): $(LIBOBJS)
	$(AR) rcs $@ $^

$(TOOL): tools/ch341_probe.c
	$(CC) $(CFLAGS) $(USB_CFLAGS) -Isrc -o $@ $< $(USB_LIBS)

install: $(LIB)
	install -d $(DESTDIR)$(PREFIX)/lib $(DESTDIR)$(PREFIX)/include
	install -m 644 $(LIB) $(DESTDIR)$(PREFIX)/lib/
	install -m 644 src/ch341.h $(DESTDIR)$(PREFIX)/include/

install-udev:
	install -m 644 udev/60-ch341-i2c.rules /etc/udev/rules.d/
	udevadm control --reload-rules
	udevadm trigger

clean:
	rm -f $(LIBOBJS) $(LIB) $(TOOL)

.PHONY: all install install-udev clean
