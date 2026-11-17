#define main boot_store_original_test_main
#include "../../tests/boot_store_test.c"
#undef main
#define main bond_sync_original_test_main
#include "test_bond_sync.c"
#undef main
#include "transition.h"

static disk banks[2];
static int sync_real(void *unused, unsigned from){
 (void)unused;lfs_t s,t;struct lfs_config a=config(&banks[from]),b=config(&banks[from^1]);
 if(lfs_mount(&s,&a)<0)return -1;
 if(lfs_mount(&t,&b)<0){lfs_unmount(&s);return -1;}
 bond_sync_workspace work;int result=bond_sync_lfs(&s,&t,&work);
 if(!banks[from^1].dead)lfs_unmount(&t);
 lfs_unmount(&s);memset(&work,0,sizeof work);return result;
}
static void read_bank(unsigned i,uint8_t result[196]){
 lfs_t l;struct lfs_config c=config(&banks[i]);assert(!lfs_mount(&l,&c));check_cfg(&l);assert(get(&l,KEY,result,196)==196);assert(!lfs_unmount(&l));
}
int main(void){
 memset(original,0xa5,sizeof original);memset(original+BM_RECORD0,255,8192);
 make_table(original+0xe000,0);memset(original+0xf000,255,4096);
 bm_record initial=sample(),out;bm_encode(&initial,original+BM_RECORD0);
 disk baseline[2];uint8_t newer[196],older[196],outkey[196];rec(newer,3);rec(older,4);
 for(int i=0;i<2;i++){lfs_t l;struct lfs_config c;fresh(&baseline[i],&l,&c);put(&l,KEY,i?older:newer,196);put(&l,CFG,"user-config",11);assert(!lfs_unmount(&l));}
 /* Interrupt individual PSM erase/program operations before publishing a slot;
  * after reboot the partition table must still identify the authoritative bank. */
 for(int partial=0;partial<2;partial++)for(int fail=0;fail<12;fail++){
  reset();memcpy(banks,baseline,sizeof banks);banks[1].fail_after=fail;banks[1].partial=partial;banks[1].writes=0;
  int result=bond_transition(&flash,1,&out,sync_real,NULL);uint8_t active;
  assert(bm_partition_active(&flash,&active));if(result<0)assert(active==0);
  banks[1].dead=false;banks[1].fail_after=-1;
  assert(bond_transition(&flash,1,&out,sync_real,NULL)==0);
  assert(bm_partition_active(&flash,&active)&&active==1);
  read_bank(0,outkey);assert(!memcmp(outkey,newer,196));read_bank(1,outkey);assert(!memcmp(outkey,newer,196));protected_unchanged();
 }
 /* Interrupt metadata or partition publication after a successful sync. */
 for(int op=0;op<6;op++){
  reset();memcpy(banks,baseline,sizeof banks);fail_operation=op;partial=1;
  (void)bond_transition(&flash,1,&out,sync_real,NULL);fail_operation=-1;
  assert(bond_transition(&flash,1,&out,sync_real,NULL)==0);
  read_bank(0,outkey);assert(!memcmp(outkey,newer,196));read_bank(1,outkey);assert(!memcmp(outkey,newer,196));protected_unchanged();
 }
 /* Exercise deletion in the upstream bank and a later re-pair in the
  * motion bank through the same transition and independent settings. */
 reset();memcpy(banks,baseline,sizeof banks);assert(bond_transition(&flash,1,&out,sync_real,NULL)==0);
 lfs_t fs;struct lfs_config cfg=config(&banks[1]);uint8_t empty[196];rec(empty,0);
 assert(!lfs_mount(&fs,&cfg));put(&fs,KEY,empty,196);assert(!lfs_unmount(&fs));
 assert(bond_transition(&flash,0,&out,sync_real,NULL)==0);read_bank(0,outkey);assert(!memcmp(outkey,empty,196));
 cfg=config(&banks[0]);assert(!lfs_mount(&fs,&cfg));put(&fs,KEY,older,196);assert(!lfs_unmount(&fs));
 assert(bond_transition(&flash,1,&out,sync_real,NULL)==0);read_bank(1,outkey);assert(!memcmp(outkey,older,196));
 puts("bond end-to-end: bidirectional deletion/re-pair, interrupted publication and retry passed");return 0;
}
