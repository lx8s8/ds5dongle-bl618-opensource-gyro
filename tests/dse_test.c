#include "bt_hid_host.h"
#include "dse.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
static uint64_t clock_us;
static int fail_id = -1;
static unsigned requests[256];
static bool connected = true;
void link_diag_note(uint8_t event, uint32_t value, uint32_t detail) {}
uint64_t bflb_mtimer_get_time_us(void) {
    return clock_us;
}
enum bt_hid_host_state bt_hid_host_get_state(void) {
    return connected ? BT_HID_STATE_CONNECTED : BT_HID_STATE_IDLE;
}
int bt_hid_host_get_feature(uint8_t rid) {
    requests[rid]++;
    return rid == fail_id ? -1 : 0;
}
int bt_hid_host_set_feature(uint8_t rid, const uint8_t *p, uint16_t n) {
    return 0;
}
int bt_hid_host_set_feature_crc(uint8_t rid, const uint8_t *p, uint16_t n) {
    return 0;
}
bool bt_hid_host_get_cached_feature(uint8_t rid, const uint8_t **p, uint16_t *n) {
    return false;
}
static void tick(unsigned delta) {
    clock_us += delta;
    dse_task();
}
int main(void) {
    dse_reset();
    dse_on_edge_detected();
    assert(!dse_profiles_ready());
    tick(4000000);
    fail_id = 0x74;
    for (int i = 0; i < 12; i++) {
        tick(80000);
        dse_on_feature_received((uint8_t)(0x70 + i), 63);
    }
    tick(80000);
    assert(!dse_profiles_ready());
    assert(requests[0x7B]); /* last request is insufficient */
    fail_id = -1;
    for (int i = 0; i < 12; i++)
        tick(80000);
    assert(requests[0x74] >= 2);
    dse_on_feature_received(0x74, 62);
    tick(80000);
    assert(!dse_profiles_ready());
    dse_on_feature_received(0x74, 63);
    tick(80000);
    assert(dse_profiles_ready());
    dse_on_profile_write(0x60);
    tick(1000);
    assert(!dse_profiles_ready());
    connected = false;
    tick(80000);
    dse_reset();
    assert(dse_profiles_ready());
    memset(requests, 0, sizeof requests);
    connected = true;
    dse_on_edge_detected();
    tick(4000000);
    dse_on_feature_received(0x70, 63); /* unsolicited old probe ignored */
    for (int i = 0; i < 12; i++)
        tick(80000);
    assert(!dse_profiles_ready());
    for (int i = 0; i < 12; i++)
        dse_on_feature_received((uint8_t)(0x70 + i), 63);
    tick(80000);
    assert(dse_profiles_ready());
    puts("Edge: wait for every response, retry sends/missing/short reports, reset and post-save refresh "
         "passed");
}
