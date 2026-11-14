CC ?= cc
CFLAGS ?= -O1 -g -std=c11 -Wall -Wextra -Werror -Wno-unused-parameter
SOURCES = gyro_test.c ../src/gyro.c ../src/gyro_runtime.c ../src/diagnostics.c ../src/dongle_control.c ../src/ds5_protocol.c ../src/remap.c
BIN = /tmp/ds5-gyro-tests

.PHONY: check sanitize
check:
	@for board in "" "-DBOARD_LCTECH_616=1" "-DBOARD_M0S_DOCK=1"; do \
	  $(CC) $(CFLAGS) -DLOG_LEVEL=0 $$board -Istubs -I../src led_test.c ../src/led_status.c -o /tmp/ds5-led-tests && /tmp/ds5-led-tests || exit 1; \
	done
	$(CC) $(CFLAGS) -DLOG_LEVEL=0 -Istubs -I../src $(SOURCES) -lm -o $(BIN)
	$(BIN)
	$(CC) $(CFLAGS) -I../boot/manager boot_store_test.c ../boot/manager/boot_store.c -o /tmp/ds5-boot-store-tests
	/tmp/ds5-boot-store-tests
	$(CC) $(CFLAGS) -DBOARD_LCTECH_616=1 -DFORCE_FS_MODE=1 -Istubs -I../boot/manager boot_manager_client_test.c ../src/boot_manager_client.c ../boot/manager/boot_store.c -o /tmp/ds5-boot-client-tests
	/tmp/ds5-boot-client-tests
	python3 -m unittest test_dual_firmware_plan.py
	python3 check_descriptors.py
	python3 check_usb_identity.py
	python3 check_usb_input_atomicity.py
	@if command -v node >/dev/null 2>&1; then node web_protocol_test.mjs && node control_center_test.mjs && node diagnostic_capture_test.mjs && node boot_manager_test.mjs; else echo "node unavailable: run web_protocol_test.mjs separately"; fi

sanitize:
	$(MAKE) check CFLAGS="$(CFLAGS) -fsanitize=address,undefined -fno-omit-frame-pointer"
