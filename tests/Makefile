CC ?= cc
CFLAGS ?= -O1 -g -std=c11 -Wall -Wextra -Werror -Wno-unused-parameter
SOURCES = gyro_test.c ../src/gyro.c ../src/gyro_runtime.c ../src/ds5_protocol.c ../src/remap.c
BIN = /tmp/ds5-gyro-tests

.PHONY: check sanitize
check:
	$(CC) $(CFLAGS) -DLOG_LEVEL=0 -Istubs -I../src $(SOURCES) -lm -o $(BIN)
	$(BIN)
	python3 check_descriptors.py
	@if command -v node >/dev/null 2>&1; then node web_protocol_test.mjs; else echo "node unavailable: run web_protocol_test.mjs separately"; fi

sanitize:
	$(MAKE) check CFLAGS="$(CFLAGS) -fsanitize=address,undefined -fno-omit-frame-pointer"
