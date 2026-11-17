#pragma once
#include <stdbool.h>
#include <stdint.h>
enum bt_hid_host_state { BT_HID_STATE_IDLE, BT_HID_STATE_SCANNING, BT_HID_STATE_CONNECTING, BT_HID_STATE_SDP_QUERY, BT_HID_STATE_L2CAP_CONTROL, BT_HID_STATE_L2CAP_INTERRUPT, BT_HID_STATE_HANDSHAKE, BT_HID_STATE_CONNECTED, BT_HID_STATE_DISCONNECTING };
enum bt_hid_host_state bt_hid_host_get_state(void);
int bt_hid_host_scan_start(uint8_t seconds);
void bt_hid_host_scan_stop(void);
void bt_hid_host_disconnect(void);
bool bt_hid_host_forget_address(const uint8_t address[6]);
bool bt_hid_host_bond_address(uint8_t index, uint8_t out[6]);
uint8_t bt_hid_host_get_bonded_count(void);
uint8_t bt_hid_host_get_active_idx(void);
