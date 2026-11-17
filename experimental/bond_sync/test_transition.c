#define main boot_store_original_test_main
#include "../../tests/boot_store_test.c"
#undef main
#include "transition.h"
static int sync_result, sync_calls;
static unsigned synced_source;
static int sync_pair(void *unused, unsigned source) {
 (void)unused; sync_calls++; synced_source=source; return sync_result;
}
int main(void){
 memset(original,0xA5,sizeof original);memset(original+BM_RECORD0,255,8192);
 make_table(original+0xE000,0);memset(original+0xF000,255,4096);
 bm_record r=sample(),out;bm_encode(&r,original+BM_RECORD0);
 reset();sync_calls=0;sync_result=-1;
 assert(bond_transition(&flash,1,&out,sync_pair,NULL)==-2 && sync_calls==1 && synced_source==0);
 assert(operation==0);uint8_t active;assert(bm_partition_active(&flash,&active)&&active==0);
 sync_result=0;sync_calls=0;assert(bond_transition(&flash,1,&out,sync_pair,NULL)==0);
 assert(sync_calls==1&&synced_source==0&&bm_partition_active(&flash,&active)&&active==1);
 sync_calls=0;assert(bond_transition(&flash,1,&out,sync_pair,NULL)==0&&sync_calls==0);
 sync_calls=0;assert(bond_transition(&flash,0,&out,sync_pair,NULL)==0&&sync_calls==1&&synced_source==1);
 /* Selection metadata may already name the target after a previous failed switch. */
 reset();assert(bm_select(&flash,1,&out));sync_calls=0;
 assert(bond_transition(&flash,1,&out,sync_pair,NULL)==0&&sync_calls==1&&synced_source==0);
 /* Publication failure is retried using the validated partition source. */
 for(int op=0;op<6;op++){
  reset();sync_calls=0;sync_result=0;fail_operation=op;partial=1;
  (void)bond_transition(&flash,1,&out,sync_pair,NULL);fail_operation=-1;
  assert(bond_transition(&flash,1,&out,sync_pair,NULL)==0);
  assert(bm_partition_active(&flash,&active)&&active==1);protected_unchanged();
 }
 puts("bond transition: source authority, failed sync and interrupted publication passed");
 return 0;
}
