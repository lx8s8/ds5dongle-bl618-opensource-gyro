#include "pairing_control.h"
#include "bt_hid_host.h"
#include "queue.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
static unsigned char saved[16]; static unsigned size; static int full, count=1, stuck; static uint64_t now; static enum bt_hid_host_state state=BT_HID_STATE_IDLE;
static const uint8_t address[6]={1,2,3,4,5,6};
uint64_t bflb_mtimer_get_time_us(void){return now;}
QueueHandle_t xQueueCreate(unsigned n,unsigned s){assert(n==1&&s<=sizeof saved);size=s;return saved;}
BaseType_t xQueueSend(QueueHandle_t q,const void*p,unsigned t){(void)q;(void)t;if(full)return 0;memcpy(saved,p,size);full=1;return pdTRUE;}
BaseType_t xQueueReceive(QueueHandle_t q,void*p,unsigned t){(void)q;(void)t;if(!full)return 0;memcpy(p,saved,size);full=0;return pdTRUE;}
enum bt_hid_host_state bt_hid_host_get_state(void){return state;}
int bt_hid_host_scan_start(uint8_t seconds){(void)seconds;state=BT_HID_STATE_SCANNING;return 0;}
void bt_hid_host_scan_stop(void){state=BT_HID_STATE_IDLE;}
void bt_hid_host_disconnect(void){if(!stuck)state=BT_HID_STATE_IDLE;}
bool bt_hid_host_forget_address(const uint8_t a[6]){if(state!=BT_HID_STATE_IDLE||!count||memcmp(a,address,6))return false;count=0;return true;}
bool bt_hid_host_bond_address(uint8_t n,uint8_t out[6]){if(n||!count)return false;memcpy(out,address,6);return true;}
uint8_t bt_hid_host_get_bonded_count(void){return count;}
uint8_t bt_hid_host_get_active_idx(void){return 0;}
int main(void){uint8_t v[19],data[6]={0};assert(pairing_control_init());assert(!pairing_control_keep_usb());pairing_control_snapshot(v);assert(v[0]==0xb1);assert(!pairing_control_submit(6,0,data));assert(pairing_control_submit(6,1,data));assert(pairing_control_keep_usb());assert(!pairing_control_submit(7,2,data));pairing_control_poll();pairing_control_snapshot(v);assert(v[1]==1&&v[3]==2&&v[4]==6&&v[5]==1&&v[7]&&!memcmp(v+8,address,6));state=BT_HID_STATE_CONNECTED;assert(pairing_control_submit(7,2,data));pairing_control_poll();pairing_control_snapshot(v);assert(v[3]==1&&state==BT_HID_STATE_IDLE);pairing_control_poll();pairing_control_snapshot(v);assert(v[3]==2&&state==BT_HID_STATE_SCANNING);assert(pairing_control_submit(8,3,address));pairing_control_poll();pairing_control_snapshot(v);assert(v[3]==2&&v[1]==0&&!v[7]);count=1;state=BT_HID_STATE_CONNECTED;stuck=1;assert(pairing_control_submit(8,5,address));pairing_control_poll();assert(!pairing_control_submit(6,6,data));now=4500001;pairing_control_poll();pairing_control_snapshot(v);assert(v[3]==3&&v[5]==5&&count==1);puts("pairing task: queue, listing, disconnect, scanning and targeted delete passed");}
