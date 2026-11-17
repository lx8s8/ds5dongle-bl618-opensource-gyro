#define main bond_sync_baseline_main
#include "test_bond_sync.c"
#undef main
#include "extension/extension.h"

static uint8_t flash[0x400000];
static uint32_t target_base;
#ifdef BOND_ENABLE_ASSERT_GUARD
#include "extension/assert_guard.h"
static int trigger_assert;
static int invalid_lfs_config(void *context){
 disk *d=context;lfs_t fs;struct lfs_config c=config(d);c.cache_size=0;
 return lfs_mount(&fs,&c);
}
#endif
static int read_flash(uint32_t address,uint8_t *buf,uint32_t length){
#ifdef BOND_ENABLE_ASSERT_GUARD
if(trigger_assert)bond_assert_failed();
#endif
if(address>sizeof flash||length>sizeof flash-address){return -1;}memcpy(buf,flash+address,length);return 0;}
static int write_flash(uint32_t address,const uint8_t *buf,uint32_t length){if(address<target_base||address>target_base+SIZE||length>target_base+SIZE-address)return -1;for(unsigned i=0;i<length;i++){if((flash[address+i]&buf[i])!=buf[i])return -1;flash[address+i]&=buf[i];}return 0;}
static int erase_flash(uint32_t address,uint32_t length){if(address<target_base||address>target_base+SIZE||length>target_base+SIZE-address)return -1;memset(flash+address,255,length);return 0;}
int main(void){
 assert(bond_extension_extent_valid(0,0,256));
 assert(bond_extension_extent_valid(7,4095,1));
 assert(!bond_extension_extent_valid(8,0,256));
 assert(!bond_extension_extent_valid(0,4095,2));
 assert(!bond_extension_extent_valid(0,0xffffffffu,2));
 assert(!bond_extension_extent_valid(0x100000u,0,256));
 disk a,b;lfs_t la,lb;struct lfs_config ca,cb;fresh(&a,&la,&ca);fresh(&b,&lb,&cb);
 uint8_t original[196],replacement[196],out[196];rec(original,1);rec(replacement,2);put(&la,KEY,replacement,196);put(&lb,KEY,original,196);put(&lb,CFG,"user-config",11);assert(!lfs_unmount(&la));assert(!lfs_unmount(&lb));
 memset(flash,255,sizeof flash);memcpy(flash+0x330000,a.data,SIZE);memcpy(flash+0x3e9000,b.data,SIZE);target_base=0x3e9000;
 bond_extension_api api={1,read_flash,write_flash,erase_flash};bond_extension_workspace work;memset(&work,0xaa,sizeof work);
 assert(bond_extension_run(&api,0,&work)==BOND_SYNC_CHANGED);
 for(size_t i=0;i<sizeof work;i++)assert(!((uint8_t*)&work)[i]);
 assert(!memcmp(flash+0x330000,a.data,SIZE));memcpy(b.data,flash+target_base,SIZE);cb=config(&b);assert(!lfs_mount(&lb,&cb));check_cfg(&lb);assert(get(&lb,KEY,out,196)==196&&!memcmp(out,replacement,196));assert(!lfs_unmount(&lb));
 /* Reverse direction, then propagate a valid deletion from each side. */
 memcpy(flash+0x330000,a.data,SIZE);memcpy(flash+0x3e9000,b.data,SIZE);
 target_base=0x330000;memset(&work,0xaa,sizeof work);
 /* b currently contains replacement; replace upstream with original first. */
 cb=config(&b);assert(!lfs_mount(&lb,&cb));put(&lb,KEY,original,196);assert(!lfs_unmount(&lb));memcpy(flash+0x3e9000,b.data,SIZE);
 assert(bond_extension_run(&api,1,&work)==BOND_SYNC_CHANGED);
 memcpy(a.data,flash+0x330000,SIZE);ca=config(&a);assert(!lfs_mount(&la,&ca));assert(get(&la,KEY,out,196)==196&&!memcmp(out,original,196));
 uint8_t empty[196];rec(empty,0);put(&la,KEY,empty,196);assert(!lfs_unmount(&la));memcpy(flash+0x330000,a.data,SIZE);
 target_base=0x3e9000;assert(bond_extension_run(&api,0,&work)==BOND_SYNC_CHANGED);
 memcpy(b.data,flash+0x3e9000,SIZE);cb=config(&b);assert(!lfs_mount(&lb,&cb));check_cfg(&lb);assert(get(&lb,KEY,out,196)==196&&!memcmp(out,empty,196));
 put(&lb,KEY,replacement,196);assert(!lfs_unmount(&lb));memcpy(flash+0x3e9000,b.data,SIZE);
 target_base=0x330000;assert(bond_extension_run(&api,1,&work)==BOND_SYNC_CHANGED);
 memcpy(a.data,flash+0x330000,SIZE);ca=config(&a);assert(!lfs_mount(&la,&ca));assert(get(&la,KEY,out,196)==196&&!memcmp(out,replacement,196));
 put(&la,KEY,original,196);assert(!lfs_unmount(&la));memcpy(flash+0x330000,a.data,SIZE);
 target_base=0x3e9000;assert(bond_extension_run(&api,0,&work)==BOND_SYNC_CHANGED);
 memcpy(b.data,flash+0x3e9000,SIZE);cb=config(&b);assert(!lfs_mount(&lb,&cb));put(&lb,KEY,empty,196);assert(!lfs_unmount(&lb));memcpy(flash+0x3e9000,b.data,SIZE);
 target_base=0x330000;assert(bond_extension_run(&api,1,&work)==BOND_SYNC_CHANGED);
 memcpy(a.data,flash+0x330000,SIZE);ca=config(&a);assert(!lfs_mount(&la,&ca));assert(get(&la,KEY,out,196)==196&&!memcmp(out,empty,196));assert(!lfs_unmount(&la));
 target_base=0x3e9000;
#ifdef BOND_ENABLE_ASSERT_GUARD
 /* An assertion in LittleFS or a callback must unwind and clear secrets. */
 assert(bond_guarded_call(invalid_lfs_config,&a)<0);
 memset(&work,0xaa,sizeof work);trigger_assert=1;
 assert(bond_extension_run(&api,0,&work)<0);trigger_assert=0;
 for(size_t i=0;i<sizeof work;i++)assert(!((uint8_t*)&work)[i]);
 assert(bond_extension_run(&api,0,&work)>=0);
#endif
 /* A damaged destination is rejected without touching the source or other areas. */
 memset(flash+target_base,0,SIZE);memset(&work,0xaa,sizeof work);assert(bond_extension_run(&api,0,&work)<0);for(size_t i=0;i<sizeof work;i++)assert(!((uint8_t*)&work)[i]);
 puts("bond extension: callback boundaries, data preservation and workspace clearing passed");
}
