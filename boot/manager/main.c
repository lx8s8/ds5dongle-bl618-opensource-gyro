#include "board.h"
#include "boot_store.h"
#include "usb_manager.h"
#include "bflb_flash.h"
#include "bflb_gpio.h"
#include "bflb_mtimer.h"
#include "bflb_sec_sha.h"
#include "bflb_irq.h"
#include <string.h>

static int read_flash(void*c,uint32_t a,uint8_t*p,size_t n){(void)c;return bflb_flash_read(a,p,n);}
static int erase_flash(void*c,uint32_t a,size_t n){(void)c;return bflb_flash_erase(a,n);}
static int write_flash(void*c,uint32_t a,const uint8_t*p,size_t n){(void)c;return bflb_flash_write(a,(uint8_t*)p,n);}
static const bm_flash flash={NULL,read_flash,erase_flash,write_flash};
static bm_record record;
static uint8_t valid_images;

static bool image_ok(const bm_image*im){
 uint8_t header[256],digest[32],buffer[2048] __attribute__((aligned(32)));
 if(read_flash(NULL,im->address,header,sizeof header)||memcmp(header,"BFNP",4))return false;
 /* Only ordinary, unsigned, unencrypted, single-segment XIP applications with
  * their original 4 KiB header are accepted. Arbitrary binaries are rejected. */
 uint32_t flags=header[120]|header[121]<<8|header[122]<<16|((uint32_t)header[123]<<24);
 uint32_t offset=header[124]|header[125]<<8|header[126]<<16|((uint32_t)header[127]<<24);
 if((flags&0xF)||!(flags&(1u<<8))||offset!=0x1000)return false;
 struct bflb_device_s*sha=bflb_device_get_by_name("sha");struct bflb_sha256_ctx_s ctx;
 if(!sha)return false;bflb_sha_init(sha,SHA_MODE_SHA256);bflb_sha256_start(sha,&ctx);
 for(uint32_t pos=0;pos<im->image_length;){uint32_t n=im->image_length-pos;if(n>sizeof buffer)n=sizeof buffer;
  if(read_flash(NULL,im->address+pos,buffer,n)||bflb_sha256_update(sha,&ctx,buffer,n))return false;pos+=n;}
 bflb_sha256_finish(sha,&ctx,digest);
 return !memcmp(digest,im->sha256,32);
}
static bool boot(uint8_t slot,bool usb){
 if(!(valid_images&(1u<<slot))||!bm_select(&flash,slot,&record)||!bm_partition_select(&flash,slot))return false;
 if(usb){bflb_mtimer_delay_ms(100);bm_usb_stop();bflb_mtimer_delay_ms(20);}
 bflb_irq_save();bflb_flash_jump_app(record.image[slot].address+0x1000);
 for(;;){}
}
static void publish(bool installed,uint8_t cmd,uint8_t result,uint8_t sequence){
 uint8_t p[63]={0};memcpy(p,"DBMR",4);p[4]=1;p[5]=installed;p[6]=installed?record.selected:255;p[7]=valid_images;p[8]=cmd;p[9]=result;p[10]=sequence;p[11]=BM_BOARD_LCTECH_FS;
 if(installed){memcpy(p+16,record.image[0].version,20);memcpy(p+36,record.image[1].version,20);for(int i=0;i<4;i++)p[56+i]=record.generation>>(8*i);}
 p[60]=1; /* experimental: root ROM handoff not yet accepted on hardware */
 bm_usb_status(p);
}
int main(void){
 board_init();struct bflb_device_s*gpio=bflb_device_get_by_name("gpio");
 bflb_gpio_init(gpio,GPIO_PIN_2,GPIO_INPUT|GPIO_FLOAT|GPIO_SMT_EN);
 bflb_gpio_init(gpio,GPIO_PIN_27,GPIO_OUTPUT|GPIO_PULLUP|GPIO_SMT_EN|GPIO_DRV_0);
 bool installed=bm_load(&flash,&record)>=0;
 bool requested=installed&&record.manage;
 if(requested)(void)bm_request_manager(&flash,false,&record);
 if(installed)for(int i=0;i<2;i++)if(image_ok(&record.image[i]))valid_images|=1u<<i;
 bm_gesture gesture={0};uint64_t start=bflb_mtimer_get_time_us();
 while(installed&&!requested){
  uint32_t ms=(bflb_mtimer_get_time_us()-start)/1000;
  if((ms/150)&1)bflb_gpio_set(gpio,GPIO_PIN_27);else bflb_gpio_reset(gpio,GPIO_PIN_27);
  bm_gesture_result next=bm_button(&gesture,bflb_gpio_read(gpio,GPIO_PIN_2)!=0,ms);
  if(next==BM_BOOT_CURRENT||next==BM_BOOT_OTHER){uint8_t slot=record.selected^(next==BM_BOOT_OTHER);if(!boot(slot,false))break;}
  if(next==BM_MANAGE)break;bflb_mtimer_delay_ms(5);
 }
 bm_usb_start();publish(installed,0,0,0);
 for(;;){
  uint8_t command[63];
  if(bm_usb_command(command)){
   uint8_t result=1,slot=command[2];
   if(command[0]==1&&slot<2&&installed&&(valid_images&(1u<<slot))){
    if(bm_select(&flash,slot,&record)&&bm_partition_select(&flash,slot))result=0;
   }
   publish(installed,command[0],result,command[1]);
   if(!result)boot(slot,true);
  }
  uint32_t ms=(bflb_mtimer_get_time_us()-start)/1000;
  if((ms/500)&1)bflb_gpio_set(gpio,GPIO_PIN_27);else bflb_gpio_reset(gpio,GPIO_PIN_27);
  bflb_mtimer_delay_ms(2);
 }
}
