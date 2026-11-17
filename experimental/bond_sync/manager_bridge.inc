/* Experimental XIP helper; the root pins the helper's exact size and hash. */
#include "extension/extension.h"
#include "bond_extension_build.h"
static bond_extension_workspace bond_workspace __attribute__((section(".noncacheable"),aligned(32)));
static uint32_t bond_target_base;
static int bond_read(uint32_t a,uint8_t*p,uint32_t n){
 if(!((a>=0x330000u&&a<=0x338000u&&n<=0x338000u-a)||(a>=0x3e9000u&&a<=0x3f1000u&&n<=0x3f1000u-a)))return -1;
 return bflb_flash_read(a,p,n);
}
static int bond_write(uint32_t a,const uint8_t*p,uint32_t n){
 if(a<bond_target_base||a>bond_target_base+0x8000u||n>bond_target_base+0x8000u-a)return -1;
#ifdef DS5_BOND_TEST_POWER_WAIT
 /* Test only: complete 128 bytes, signal on the blue LED and wait for an
  * external power cut. This models interruption between flash commands. */
 if(n>=128u){
  if(bflb_flash_write(a,(uint8_t*)p,128u))return -1;
  struct bflb_device_s *gpio=bflb_device_get_by_name("gpio");
  bflb_gpio_reset(gpio,GPIO_PIN_27);
  for(;;)bflb_mtimer_delay_ms(1000);
 }
#endif
#ifdef DS5_BOND_TEST_FAIL_PROG
 /* Hardware-only fault injection: interrupt the first program operation after
  * a partial write. Never compiled into normal or packaged managers. */
 if(n>=128u){if(bflb_flash_write(a,(uint8_t*)p,128u))return -1;GLB_SW_System_Reset();}
#endif
 return bflb_flash_write(a,(uint8_t*)p,n);
}
static int bond_erase(uint32_t a,uint32_t n){
 if(a<bond_target_base||a>bond_target_base+0x8000u||n!=0x1000u||n>bond_target_base+0x8000u-a||(a&0xfffu))return -1;
 return bflb_flash_erase(a,n);
}
static int sync_bonds(unsigned source){
 static const uint8_t expected[32]=BOND_EXTENSION_SHA256;
 struct tc_sha256_state_struct ctx;uint8_t digest[32];
 if(source>1||BOND_EXTENSION_SIZE==0||BOND_EXTENSION_SIZE>0x4000u||
    !bm_partition_range_free(&flash,0x342000u,0x4000u)||!tc_sha256_init(&ctx))return -1;
 for(uint32_t n=0;n<BOND_EXTENSION_SIZE;){uint32_t l=BOND_EXTENSION_SIZE-n;if(l>sizeof sha_buf)l=sizeof sha_buf;
  if(read_flash(NULL,0x342000u+n,sha_buf,l)||!tc_sha256_update(&ctx,sha_buf,l))return -1;n+=l;}
 if(!tc_sha256_final(digest,&ctx)||memcmp(digest,expected,32))return -1;
 bond_target_base=source?0x330000u:0x3e9000u;
 bond_extension_api api={1,bond_read,bond_write,bond_erase};
 int (*run)(const bond_extension_api*,unsigned,bond_extension_workspace*)=(void*)0xa0340000u;
 return run(&api,source,&bond_workspace);
}
static bool select_target(uint8_t slot){
 uint8_t source;if(!bm_partition_active(&flash,&source))return false;
 if(source!=slot&&sync_bonds(source)<0)return false;
 return bm_select(&flash,slot,&record)&&bm_partition_select(&flash,slot);
}
