"""Run real connection-owner/disconnect functions with completion reentrancy."""
import os
from pathlib import Path
import re
import shlex
import subprocess
import tempfile

source = (Path(__file__).resolve().parents[1] / 'src/bt_hid_host.c').read_text()


def function(name):
    match = re.search(r'(?:static )?(?:void|struct bt_conn \*)\s*' + name + r'\([^;]*?\)\n\{', source)
    assert match, name
    start = match.start()
    brace = source.index('{', match.start())
    level = 1
    end = brace + 1
    while level:
        level += (source[end] == '{') - (source[end] == '}')
        end += 1
    return source[start:end]


program = r'''
#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>
#include <stdio.h>
#include <string.h>
#define LOG_INF(...)
#define LOG_WRN(...)
#define taskENTER_CRITICAL() ((void)0)
#define taskEXIT_CRITICAL() ((void)0)
#define BT_HCI_ERR_REMOTE_USER_TERM_CONN 0x13
#define BT_HID_STATE_IDLE 0
#define BT_HID_STATE_DISCONNECTING 2
#define LINK_FORCE_DISCONNECT 3
typedef unsigned TickType_t;
struct bt_conn { int refs; };
static struct {
 struct bt_conn *conn;
 int state,active_idx,handshake_next,handshake_count,connect_pending_tick;
 bool ctrl_connected,intr_connected,ctrl_accepting,intr_accepting,outgoing,is_dse,check_dse,
      handshake_send_failed,connect_pending,sdp_pending,security_pending,security_done,fallback_retry;
 struct { uint8_t val[6]; } pending_addr;
} hid_ctx;
static unsigned disconnects,releases,acquires;static bool reenter,complete;
static bool force_busy,first_intr_logged,first_output_logged,switch_pending;
static unsigned bonded_count,active_idx;static struct{uint8_t val[6];}bonded_list[2];
static void app_tx_fifo_reset(void){}
static void feature_cache_clear(void){}
static void dse_reset(void){}
static void bt_br_set_connectable(bool value){}
static void bt_br_set_discoverable(bool value){}
static void set_state(int state){hid_ctx.state=state;}
static void link_diag_note(unsigned a,unsigned b,unsigned c){}
static void bt_conn_unref(struct bt_conn*c){assert(c&&c->refs>0);c->refs--;releases++;}
static struct bt_conn*bt_conn_ref(struct bt_conn*c){assert(c&&c->refs>0);c->refs++;acquires++;return c;}
static unsigned xTaskGetTickCount(void){return 100;}
static struct bt_conn *conn_take(struct bt_conn*);
void bt_hid_host_force_disconnect(void);
static int bt_conn_disconnect(struct bt_conn*c,unsigned reason){
 assert(c&&c->refs>0);disconnects++;
 if(reenter){reenter=false;bt_hid_host_force_disconnect();}
 if(complete){struct bt_conn*owned=conn_take(c);if(owned)bt_conn_unref(owned);}
 return 0;
}
'''
program += '\n'.join(function(name) for name in ('conn_take', 'conn_acquire',
    'bt_hid_host_disconnect', 'bt_hid_host_force_disconnect', 'bt_hid_host_drop_stale_conn'))
program += r'''
int main(void){
 for(unsigned mode=0;mode<4;mode++){
  struct bt_conn c={1};memset(&hid_ctx,0,sizeof hid_ctx);hid_ctx.conn=&c;
  reenter=mode&1;complete=mode&2;unsigned before=releases;
  bt_hid_host_force_disconnect();assert(!hid_ctx.conn&&c.refs==0&&releases==before+1&&!force_busy);
  bt_hid_host_force_disconnect();assert(c.refs==0); /* no second unref */
 }
 struct bt_conn c={1};hid_ctx.conn=&c;reenter=false;complete=true;
 bt_hid_host_disconnect();assert(c.refs==0&&!hid_ctx.conn&&acquires==1);
 struct bt_conn old={1},current={1};hid_ctx.conn=&current;
 assert(!conn_take(&old)&&hid_ctx.conn==&current); /* delayed old callback cannot claim new connection */
 bt_hid_host_drop_stale_conn();assert(current.refs==0&&!hid_ctx.conn);
 puts("Bluetooth lifetime: completion during command, recursive teardown, stale callback and exactly-once release passed");
}
'''
with tempfile.TemporaryDirectory(prefix='ds5-bt-lifetime-') as temp:
    path = Path(temp)
    (path / 'test.c').write_text(program)
    subprocess.run(shlex.split(os.environ.get('CC', 'cc')) + ['-std=c11', '-w',
        str(path / 'test.c'), '-o', str(path / 'test')], check=True)
    subprocess.run([str(path / 'test')], check=True)
