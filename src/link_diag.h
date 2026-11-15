#pragma once
#include <stdint.h>
#define LINK_DIAG_SIZE 400
enum {
    LINK_ACL_UP = 1,
    LINK_ACL_DOWN,
    LINK_FORCE_DISCONNECT,
    LINK_INPUT_WATCHDOG,
    LINK_HOST_FEATURE,
    LINK_EDGE_READY
};
void link_diag_note(uint8_t event, uint32_t value, uint32_t detail);
void link_diag_snapshot(uint8_t out[LINK_DIAG_SIZE]);
